const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const chalk = require("chalk");
const { parseError } = require("./error-parser");
const { requestRepair, getClient, aiCall, _trackOp, getTrackerSnapshot } = require("./ai-client");
const { getModel } = require("./models");
const { applyPatch } = require("./patcher");
const { verifyFix } = require("./verifier");
const { Sandbox, SandboxViolationError } = require("../security/sandbox");
const { RateLimiter } = require("../security/rate-limiter");
const { detectInjection } = require("../security/injection-detector");
const { redact, hasSecrets } = require("../security/secret-redactor");
const { BackupManager } = require("../backup/backup-manager");
const { getRoutePrompt } = require("../brain/tool-router");
const { AgentEngine } = require("../agent/agent-engine");
const { ResearchAgent } = require("../agent/research-agent");
const { GoalLoop } = require("../agent/goal-loop");
const { exploreAndFix, spawnParallel } = require("../agent/sub-agents");
const { EVENT_TYPES } = require("../logger/event-logger");
const { diagnose: diagnoseDeps } = require("../skills/deps");
const { getSummary: getServerContextSummary } = require("./server-context");

/**
 * The Wolverine healing engine — v3.
 *
 * Two repair modes:
 * 1. FAST PATH: Single-file fix (simple errors, uses CODING_MODEL)
 * 2. AGENT PATH: Multi-file agent with tool use (complex errors, uses REASONING_MODEL)
 *
 * The engine tries fast path first. If that fails verification, it escalates to the agent.
 */
async function heal(opts) {
  const { loadConfig } = require("./config");
  const _cfg = loadConfig();
  const HEAL_TIMEOUT_MS = _cfg.heal?.healTimeoutMs || 300000;
  try {
    return await Promise.race([
      _healImpl(opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), HEAL_TIMEOUT_MS)),
    ]);
  } catch (err) {
    if (err.message === "timeout") {
      console.log(chalk.red(`\n🐺 Heal timed out after ${HEAL_TIMEOUT_MS / 1000}s`));
      if (opts.logger) opts.logger.error(EVENT_TYPES.HEAL_FAILED, `Heal timed out after ${HEAL_TIMEOUT_MS / 1000}s`);
      // #11: Rollback on timeout — the background _healImpl may have partially applied patches
      if (opts.backupManager) {
        try {
          const all = opts.backupManager.getAll();
          const latest = all.find(b => b.status === "unstable");
          if (latest) {
            opts.backupManager.rollbackTo(latest.id);
            console.log(chalk.yellow(`  ↩️  Rolled back to ${latest.id} (timeout cleanup)`));
          }
        } catch {}
      }
      return { healed: false, explanation: `Heal timed out after ${HEAL_TIMEOUT_MS / 1000}s` };
    }
    throw err;
  }
}

async function _healImpl({ stderr, cwd, sandbox, notifier, rateLimiter, backupManager, logger, brain, mcp, skills, repairHistory, routeContext }) {
  const healStartTime = Date.now();
  // Snapshot token tracker at heal start — diff at end = FULL pipeline cost
  const _snapshot = getTrackerSnapshot();

  // Guard: don't burn tokens on empty stderr (signal kills, clean shutdowns, etc.)
  if (!stderr || stderr.trim().length < 10) {
    console.log(chalk.yellow("\n🐺 Empty stderr — nothing to heal (likely signal kill)"));
    if (logger) logger.warn(EVENT_TYPES.HEAL_FAILED, "Empty stderr — skipping heal");
    return { healed: false, explanation: "Empty stderr — nothing to diagnose" };
  }

  // Redact secrets BEFORE any processing, logging, or AI calls
  const safeStderr = redact(stderr);

  if (logger) logger.info(EVENT_TYPES.HEAL_START, "Wolverine detected a crash", { stderr: safeStderr.slice(0, 500) });
  console.log(chalk.yellow("\n🐺 Wolverine detected a crash. Analyzing...\n"));

  // 1. Parse the error (use original for file path extraction, redacted for everything else)
  const parsed = parseError(stderr);
  const errorSignature = RateLimiter.signature(parsed.errorMessage, parsed.filePath);

  // Redact parsed fields — these go to AI, brain, and logs
  parsed.errorMessage = redact(parsed.errorMessage);
  parsed.stackTrace = redact(parsed.stackTrace);

  if (hasSecrets(stderr)) {
    console.log(chalk.yellow("  🔐 Secrets detected in error output — redacted before AI/brain/logs"));
  }

  if (logger) logger.debug(EVENT_TYPES.HEAL_PARSE, `Parsed: ${parsed.errorMessage}`, { file: parsed.filePath, line: parsed.line });

  // File path is optional — some errors (database, config, port) don't trace to a file.
  // When no file is found, skip fast path and go straight to agent investigation.
  let hasFile = false;
  if (parsed.filePath) {
    // 2. Sandbox check
    try {
      sandbox.resolve(parsed.filePath);
      hasFile = sandbox.exists(parsed.filePath);
    } catch (e) {
      if (e instanceof SandboxViolationError) {
        console.log(chalk.red(`  🔒 SANDBOX: ${e.message}`));
        if (logger) logger.error(EVENT_TYPES.SECURITY_SANDBOX_VIOLATION, e.message, { file: parsed.filePath });
        return { healed: false, explanation: "File outside sandbox — access denied" };
      }
      throw e;
    }
  }

  console.log(chalk.cyan(`  File:  ${parsed.filePath || "(no file — agent will investigate)"}`));
  console.log(chalk.cyan(`  Line:  ${parsed.line || "unknown"}`));
  console.log(chalk.cyan(`  Error: ${parsed.errorMessage}`));
  console.log(chalk.cyan(`  Type:  ${parsed.errorType || "unknown"}`));

  // 2c. If error mentions env vars, collect env context for AI
  let envContext = "";
  if (/process\.env|\.env|missing.*(?:key|token|secret|api|url|host|port|password|database)|undefined.*(?:config|setting)/i.test(parsed.errorMessage + " " + (parsed.stackTrace || ""))) {
    const envKeys = Object.keys(process.env)
      .filter(k => !k.startsWith("npm_") && !k.startsWith("WOLVERINE_") && !k.startsWith("__"))
      .sort();
    envContext = `\nAvailable environment variables (names only, values redacted): ${envKeys.join(", ")}\nIf the error is about a missing env var, suggest setting it rather than working around it in code.\n`;
    console.log(chalk.gray(`  🔑 Env context: ${envKeys.length} vars available`));
  }

  // 3. Rate limit check
  const rateCheck = rateLimiter.check(errorSignature);
  if (!rateCheck.allowed) {
    console.log(chalk.red(`  ⏱️  ${rateCheck.reason}`));
    if (logger) logger.warn(EVENT_TYPES.SECURITY_RATE_LIMITED, rateCheck.reason, { errorSignature });
    return { healed: false, explanation: rateCheck.reason, waitMs: rateCheck.waitMs };
  }

  // 4. Prompt injection scan
  console.log(chalk.gray(`  🛡️  Scanning for prompt injection (${getModel("audit")})...`));
  let openaiClient = null;
  try { openaiClient = getClient(); } catch { /* will fail later */ }

  // Skip injection scan on empty/trivial stderr (prevents false positives on clean restarts)
  const stderrContent = (parsed.errorMessage || "").trim() + (parsed.stackTrace || "").trim();
  if (stderrContent.length < 20) {
    console.log(chalk.gray("  🛡️  Stderr too short for injection scan — skipping"));
  } else {
    const injectionResult = await detectInjection(parsed.errorMessage, parsed.stackTrace, { openaiClient });

    if (logger) logger.info(EVENT_TYPES.HEAL_INJECTION_SCAN, `Injection scan: ${injectionResult.safe ? "clean" : "BLOCKED"}`, injectionResult);

    if (!injectionResult.safe) {
      console.log(chalk.red("  🚨 BLOCKED: Potential prompt injection detected."));
      if (logger) logger.critical(EVENT_TYPES.SECURITY_INJECTION_DETECTED, "Injection detected — repair blocked", injectionResult);
      return { healed: false, explanation: "Prompt injection detected — repair blocked" };
    }
    console.log(chalk.green("  ✅ Clean — no injection detected."));
  }

  // 4b. Check if this is a human-required issue (expired keys, billing, etc.)
  if (notifier) {
    const notification = await notifier.notify(parsed.errorMessage, parsed.stackTrace);
    if (notification) {
      // This is not AI-fixable — don't waste tokens, just notify the human
      return {
        healed: false,
        explanation: `Human action required [${notification.category}]: ${notification.summary}`,
        notification,
      };
    }
  }

  // 4c. Pre-heal operational fix — detect common non-code errors
  // Some crashes aren't code bugs (missing npm packages, missing config files).
  // Fix these directly without wasting AI tokens.
  const opsFix = await tryOperationalFix(parsed, cwd, logger, sandbox);
  if (opsFix.fixed) {
    console.log(chalk.green(`  ⚡ Operational fix applied: ${opsFix.action}`));
    if (logger) logger.info(EVENT_TYPES.HEAL_SUCCESS, `Operational fix: ${opsFix.action}`, { action: opsFix.action });
    // Record with FULL pipeline cost (includes injection scan, brain lookup, etc.)
    const _endSnap = getTrackerSnapshot();
    const pipelineTokens = _endSnap.tokens - _snapshot.tokens;
    const pipelineCost = _endSnap.cost - _snapshot.cost;
    if (repairHistory) {
      repairHistory.record({
        error: parsed.errorMessage, file: parsed.filePath, line: parsed.line,
        resolution: opsFix.action, success: true, mode: "operational",
        model: getModel("audit"), tokens: pipelineTokens, cost: pipelineCost, iteration: 0,
        duration: Date.now() - healStartTime, filesModified: [],
      });
    }
    return { healed: true, explanation: opsFix.action, mode: "operational" };
  }

  // 5. Read the source file (if available) + get brain context
  const sourceCode = hasFile ? sandbox.readFile(parsed.filePath) : "";

  // 5b. Get last known good version from backup (helps AI revert vs patch)
  let backupSourceCode = "";
  if (hasFile && backupManager) {
    try {
      const stableBackups = backupManager.getAll().filter(b => b.status === "stable" || b.status === "verified");
      if (stableBackups.length > 0) {
        const latest = stableBackups[stableBackups.length - 1];
        const relPath = path.relative(cwd, parsed.filePath).replace(/[/\\]/g, "__");
        const backupFile = path.join(cwd, ".wolverine", "backups", latest.id, relPath);
        if (fs.existsSync(backupFile)) {
          backupSourceCode = fs.readFileSync(backupFile, "utf-8");
          if (backupSourceCode === sourceCode) backupSourceCode = ""; // Same — no useful diff
          else console.log(chalk.gray(`  📋 Found last known good version (backup ${latest.id})`));
        }
      }
    } catch { /* non-fatal */ }
  }

  let brainContext = "";
  // Inject server context (routes, DB, config, deps) if available
  try {
    const serverCtx = getServerContextSummary(cwd);
    if (serverCtx) brainContext += serverCtx + "\n\n";
  } catch {}
  // Inject tool routing — tells agent exactly which tools to use for this error type
  const toolRoute = getRoutePrompt(parsed.errorMessage, parsed.errorType);
  if (toolRoute) {
    brainContext += toolRoute + "\n\n";
    console.log(chalk.gray(`  🗺️  Tool route: ${toolRoute.split("\n")[1]?.trim() || "matched"}`));
  }
  // Inject relevant skill context (claw-code: pre-enrich prompt with matched tools)
  if (skills) {
    const skillCtx = skills.buildContext(parsed.errorMessage);
    if (skillCtx) brainContext += skillCtx + "\n";
  }
  if (brain && brain._initialized) {
    try {
      brainContext += await brain.getContext(parsed.errorMessage);
      if (brainContext) {
        console.log(chalk.gray(`  🧠 Brain + skills: ${brainContext.split("\n").length} lines of context`));
      }
      // Remember the error
      await brain.remember("errors", `Error in ${parsed.filePath}:${parsed.line}: ${parsed.errorMessage}\n${parsed.stackTrace?.slice(0, 300) || ""}`, {
        file: parsed.filePath,
        line: parsed.line,
        error: parsed.errorMessage,
      });
    } catch { /* non-fatal */ }
  }

  // 6. Check brain for cached fix — if we fixed this exact error before, replay it (zero tokens)
  if (brain && brain._initialized && hasFile && repairHistory) {
    try {
      const pastRepairs = repairHistory.getAll().filter(r =>
        r.success && r.file === parsed.filePath && r.error &&
        parsed.errorMessage.includes(r.error.split(":").pop()?.trim()?.slice(0, 30))
      );
      if (pastRepairs.length > 0) {
        const cached = pastRepairs[pastRepairs.length - 1];
        console.log(chalk.gray(`  🧠 Found cached fix for similar error (${cached.mode}, ${cached.id})`));
        if (logger) logger.info("heal.cached", `Cached fix found: ${cached.resolution?.slice(0, 80)}`, { cachedId: cached.id });
      }
    } catch {}
  }

  // 7. Classify error complexity — regex first (fast, free), AI only when uncertain
  let errorComplexity = "moderate";
  const isObviouslySimple = /TypeError|ReferenceError|SyntaxError|Cannot find module|Cannot read prop/.test(parsed.errorMessage);
  const isObviouslyModerate = /ECONNREFUSED|timeout|ENOENT|EACCES|EADDRINUSE|ENOSPC|EMFILE/.test(parsed.errorMessage);
  if (isObviouslySimple) {
    errorComplexity = "simple";
    console.log(chalk.gray(`  🏷️  Classifier (fast): simple`));
  } else if (isObviouslyModerate) {
    errorComplexity = "moderate";
    console.log(chalk.gray(`  🏷️  Classifier (fast): moderate`));
  } else {
    // Uncertain — use AI classifier
    try {
      const classifyResult = await aiCall({
        model: getModel("classifier"),
        systemPrompt: "You classify Node.js errors. Respond with ONLY one word: SIMPLE, MODERATE, or COMPLEX.",
        userPrompt: `Classify this error:\n${parsed.errorMessage}\n\nFile: ${parsed.filePath || "unknown"}\nType: ${parsed.errorType || "unknown"}`,
        maxTokens: 10,
        category: "classifier",
      });
      const word = (classifyResult.content || "").trim().toUpperCase();
      if (word.includes("SIMPLE")) errorComplexity = "simple";
      else if (word.includes("COMPLEX")) errorComplexity = "complex";
      else errorComplexity = "moderate";
      console.log(chalk.gray(`  🏷️  Classifier (AI): ${errorComplexity}`));
    } catch {
      errorComplexity = "complex"; // unknown = treat as complex to be safe
      console.log(chalk.gray(`  🏷️  Classifier (fallback): complex`));
    }
  }

  // 7b. Research — look up past fixes AND search for solutions
  const researcher = new ResearchAgent({ brain, logger });
  let researchContext = "";
  try {
    researchContext = await researcher.buildFixContext(parsed.errorMessage);
    if (researchContext) console.log(chalk.gray(`  🔍 Research: found past context for this error`));
    // For moderate/complex errors, also do a deep research call
    if (errorComplexity !== "simple" && brain && brain._initialized) {
      const deepCtx = await researcher.research(parsed.errorMessage, researchContext || brainContext);
      if (deepCtx) researchContext = (researchContext || "") + "\n" + deepCtx;
    }
  } catch {}

  // 7c. Token budget by classified complexity
  const isSimpleError = errorComplexity === "simple";
  const isModerateError = errorComplexity === "moderate";
  const tokenBudget = isSimpleError
    ? { fast: 5000, agent: 20000, subAgent: 15000 }
    : isModerateError
    ? { fast: 10000, agent: 50000, subAgent: 30000 }
    : { fast: 15000, agent: 100000, subAgent: 50000 };
  console.log(chalk.gray(`  💰 Token budget: ${errorComplexity} (agent: ${tokenBudget.agent})`));

  // 8. Goal Loop — set goal, iterate until fixed or exhausted
  const loop = new GoalLoop({
    maxIterations: parseInt(process.env.WOLVERINE_MAX_RETRIES, 10) || 3,
    researcher,
    logger,
    goal: `Fix: ${parsed.errorMessage.slice(0, 80)}`,

    onAttempt: async (iteration, researchCtx, priorAttempts) => {
      // #12: Create backup for this attempt — if backup fails, skip the attempt entirely
      let bid;
      try {
        bid = backupManager.createBackup(`heal attempt ${iteration}: ${parsed.errorMessage.slice(0, 60)}`);
      } catch (backupErr) {
        console.log(chalk.red(`  ⚠️  Backup creation failed: ${backupErr.message} — skipping attempt`));
        if (logger) logger.error(EVENT_TYPES.BACKUP_CREATED, `Backup failed: ${backupErr.message}`);
        return { healed: false, explanation: `Backup creation failed: ${backupErr.message}` };
      }
      backupManager.setErrorSignature(bid, errorSignature);
      if (logger) logger.info(EVENT_TYPES.BACKUP_CREATED, `Backup ${bid} (iteration ${iteration})`, { backupId: bid });

      // Build concise prior attempt summary instead of full context bleed
      let priorSummary = "";
      if (priorAttempts && priorAttempts.length > 0) {
        priorSummary = "\nPRIOR ATTEMPTS (do NOT repeat):\n" + priorAttempts.map(a =>
          `- Attempt ${a.iteration} (${a.mode}): ${a.explanation?.slice(0, 50)}`
        ).join("\n") + "\n";
      }

      const fullContext = [brainContext, researchContext, researchCtx, envContext, priorSummary].filter(Boolean).join("\n");

      let result;
      if (iteration === 1 && hasFile) {
        // Fast path — CODING_MODEL, single file + optional commands
        // Only available when we have a specific file to fix
        console.log(chalk.yellow(`  🧠 Fast path (${getModel("coding")})...`));
        try {
          const repair = await requestRepair({
            filePath: parsed.filePath, sourceCode, backupSourceCode,
            errorMessage: parsed.errorMessage, stackTrace: parsed.stackTrace,
            extraContext: envContext,
          });
          // #15: Don't record rate limit until AFTER verification — failed attempts shouldn't exhaust the limit

          // Execute shell commands first (npm install, mkdir, etc.)
          if (repair.commands && Array.isArray(repair.commands)) {
            for (const cmd of repair.commands) {
              // Block dangerous commands
              if (/rm\s+-rf\s+[/\\]|format\s+c:|mkfs/i.test(cmd)) {
                console.log(chalk.red(`  🛡️ Blocked dangerous command: ${cmd}`));
                continue;
              }
              console.log(chalk.blue(`  ⚡ Running: ${cmd}`));
              try {
                execSync(cmd, { cwd, stdio: "pipe", timeout: 60000 });
                console.log(chalk.green(`  ✅ Command succeeded: ${cmd}`));
              } catch (cmdErr) {
                console.log(chalk.yellow(`  ⚠️ Command failed: ${cmd} — ${cmdErr.message?.slice(0, 80)}`));
              }
            }
          }

          // Apply code changes (if any)
          if (repair.changes && repair.changes.length > 0) {
            const sandboxCheck = sandbox.validateChanges(repair.changes);
            if (!sandboxCheck.valid) throw new Error("Changes outside sandbox");

            const patchResults = applyPatch(repair.changes, cwd, sandbox);
            if (!patchResults.every(r => r.success)) throw new Error("Patch failed");

            for (const r of patchResults) console.log(chalk.green(`  ✅ Patched: ${r.file}`));
          }

          const verification = await verifyFix(parsed.filePath, cwd, errorSignature, routeContext);
          if (verification.verified) {
            backupManager.markVerified(bid);
            rateLimiter.record(errorSignature);
            rateLimiter.clearSignature(errorSignature);
            // Track tool operations: file read + patch + verify + any commands
            // These are the same operations an agent would do with read_file/write_file/bash_exec
            const toolOps = 1 + (repair.changes?.length || 0) + (repair.commands?.length || 0) + 1; // read + patches + commands + verify
            const toolTokens = (sourceCode?.length || 0) / 4; // approximate tokens for file read
            _trackOp(getModel("tool"), "tool", Math.round(toolTokens), 0, "fast_path_ops", Date.now() - healStartTime, true);
            return { healed: true, explanation: repair.explanation, backupId: bid, mode: "fast" };
          }

          // #13: Safe rollback — wrap in try/catch to prevent rollback-of-rollback loop
          try { backupManager.rollbackTo(bid); } catch (rbErr) { console.log(chalk.red(`  ⚠️  Rollback failed: ${rbErr.message}`)); }
          return { healed: false, explanation: `Fast path: ${verification.status}` };
        } catch (err) {
          try { backupManager.rollbackTo(bid); } catch (rbErr) { console.log(chalk.red(`  ⚠️  Rollback failed: ${rbErr.message}`)); }
          return { healed: false, explanation: `Fast path error: ${err.message}` };
        }
      } else if (iteration <= 2) {
        // Agent path — REASONING_MODEL (also handles iteration 1 when no file)
        console.log(chalk.magenta(`  🤖 Agent path (${getModel("reasoning")})...`));
        // Tight turn budget: simple errors get 4 turns, ENOENT/config gets 5, complex gets 8
        const isConfigError = /ENOENT|missing.*config|missing.*file|no such file/i.test(parsed.errorMessage);
        const agentMaxTurns = isSimpleError ? 4 : isConfigError ? 5 : 8;
        const agent = new AgentEngine({
          sandbox, logger, cwd, mcp,
          maxTurns: agentMaxTurns,
          maxTokens: tokenBudget.agent,
          category: "tool", // Agent uses tools (read_file, write_file, bash_exec) = tool category
        });

        const agentResult = await agent.run({
          errorMessage: parsed.errorMessage, stackTrace: parsed.stackTrace,
          primaryFile: parsed.filePath, sourceCode,
          brainContext: fullContext + (backupSourceCode ? `\n\nLAST KNOWN WORKING VERSION of ${parsed.filePath}:\n${backupSourceCode}\nIf the broken code added something that doesn't work, revert it rather than patching around it.` : ""),
        });
        rateLimiter.record(errorSignature, agentResult.totalTokens);

        if (agentResult.success) {
          // Verify: if we have a file, do syntax + boot check. Otherwise just boot probe.
          if (hasFile) {
            const verification = await verifyFix(parsed.filePath, cwd, errorSignature, routeContext);
            if (verification.verified) {
              backupManager.markVerified(bid);
              rateLimiter.clearSignature(errorSignature);
              return { healed: true, explanation: agentResult.summary, backupId: bid, mode: "agent", agentStats: agentResult };
            }
          } else if (agentResult.filesModified.length > 0 || agentResult.toolCalls?.some(t => t.name === "bash_exec")) {
            // No specific file but agent made changes or ran commands — trust it
            backupManager.markVerified(bid);
            rateLimiter.clearSignature(errorSignature);
            return { healed: true, explanation: agentResult.summary, backupId: bid, mode: "agent", agentStats: agentResult };
          }
        }

        backupManager.rollbackTo(bid);
        return { healed: false, explanation: agentResult.summary || "Agent could not fix" };
      } else {
        // Iteration 3+: Sub-agents — explore → plan → fix (divide and conquer)
        console.log(chalk.magenta(`  🤖 Sub-agent path (explore → plan → fix)...`));

        const subResult = await exploreAndFix(
          `Error: ${parsed.errorMessage}\n${parsed.filePath ? "File: " + parsed.filePath + "\n" : ""}Stack: ${parsed.stackTrace?.slice(0, 300)}`,
          { sandbox, logger, cwd, mcp, brainContext: fullContext }
        );
        rateLimiter.record(errorSignature, subResult.totalTokens);

        if (subResult.success) {
          if (hasFile) {
            const verification = await verifyFix(parsed.filePath, cwd, errorSignature, routeContext);
            if (verification.verified) {
              backupManager.markVerified(bid);
              rateLimiter.clearSignature(errorSignature);
              return { healed: true, explanation: subResult.summary, backupId: bid, mode: "sub-agents", agentStats: subResult };
            }
          } else {
            backupManager.markVerified(bid);
            rateLimiter.clearSignature(errorSignature);
            return { healed: true, explanation: subResult.summary, backupId: bid, mode: "sub-agents", agentStats: subResult };
          }
        }

        backupManager.rollbackTo(bid);
        return { healed: false, explanation: subResult.summary || "Sub-agents could not fix" };
      }
    },
  });

  const goalResult = await loop.run({
    errorMessage: parsed.errorMessage,
    filePath: parsed.filePath,
    cwd,
  });

  backupManager.prune();

  // Record to repair history — use FULL pipeline cost (injection scan + brain + fix)
  if (repairHistory) {
    const duration = Date.now() - healStartTime;
    const _endSnap = getTrackerSnapshot();
    const pipelineTokens = _endSnap.tokens - _snapshot.tokens;
    const pipelineCost = _endSnap.cost - _snapshot.cost;
    const model = goalResult.mode === "fast" ? getModel("coding") : getModel("reasoning");

    repairHistory.record({
      error: parsed.errorMessage,
      file: parsed.filePath,
      line: parsed.line,
      resolution: goalResult.explanation,
      success: goalResult.success,
      mode: goalResult.mode || "unknown",
      model,
      tokens: pipelineTokens,
      cost: pipelineCost,
      iteration: goalResult.iteration,
      duration,
      filesModified: goalResult.agentStats?.filesModified || [],
    });
  }

  // Generate a concise heal summary using CHAT_MODEL
  if (goalResult.success) {
    try {
      const summaryResult = await aiCall({
        model: getModel("chat"),
        systemPrompt: "Summarize this server heal in 1-2 sentences for a developer dashboard. Be specific about what broke and how it was fixed.",
        userPrompt: `Error: ${parsed.errorMessage}\nFile: ${parsed.filePath || "unknown"}\nFix mode: ${goalResult.mode}\nResolution: ${goalResult.explanation?.slice(0, 200) || "fixed"}`,
        maxTokens: 80,
        category: "chat",
      });
      goalResult.summary = (summaryResult.content || "").trim();
      if (goalResult.summary) console.log(chalk.cyan(`  💬 ${goalResult.summary}`));
    } catch {}
  }

  // Record outcome to brain — both successes AND failures with full context
  if (brain && brain._initialized) {
    try {
      if (goalResult.success) {
        await brain.remember("fixes",
          `FIXED (${goalResult.mode}, iter ${goalResult.iteration}): ${parsed.errorMessage} in ${parsed.filePath}:${parsed.line}. ` +
          `Solution: ${goalResult.explanation?.slice(0, 200)}. Files: ${(goalResult.agentStats?.filesModified || []).join(", ")}`,
          { type: "fix-success", file: parsed.filePath, error: parsed.errorMessage, mode: goalResult.mode }
        );
      } else {
        // Record failure with all attempts so brain knows what NOT to do
        const attemptSummary = (goalResult.attempts || []).map(a =>
          `Iter ${a.iteration} (${a.mode}): ${a.explanation?.slice(0, 80)}`
        ).join("; ");
        await brain.remember("errors",
          `UNRESOLVED: ${parsed.errorMessage} in ${parsed.filePath}:${parsed.line}. ` +
          `Tried ${goalResult.iteration} iterations: ${attemptSummary}. All failed.`,
          { type: "fix-failure", file: parsed.filePath, error: parsed.errorMessage, attempts: goalResult.iteration }
        );
      }
    } catch {}
  }

  if (goalResult.success) {
    if (logger) logger.info(EVENT_TYPES.HEAL_SUCCESS, goalResult.explanation, { iteration: goalResult.iteration, mode: goalResult.mode });
    return { healed: true, ...goalResult };
  }

  if (logger) logger.error(EVENT_TYPES.HEAL_FAILED, `Goal failed after ${goalResult.iteration} iterations`, { attempts: goalResult.attempts });
  return { healed: false, explanation: goalResult.explanation };
}

/**
 * Try to fix common operational errors without AI.
 * Returns { fixed: boolean, action: string }
 */
async function tryOperationalFix(parsed, cwd, logger, sandbox) {
  const msg = parsed.errorMessage || "";

  // Pattern 1: Dependency issues — use deps skill for structured diagnosis
  const depsDiag = diagnoseDeps(msg, cwd);
  if (depsDiag.diagnosed) {
    console.log(chalk.blue(`  📦 Deps diagnosis: ${depsDiag.category} — ${depsDiag.summary}`));
    if (logger) logger.info("heal.ops.deps", depsDiag.summary, { category: depsDiag.category });

    for (const fix of (depsDiag.fixes || [])) {
      try {
        console.log(chalk.blue(`  📦 Running: ${fix}`));
        execSync(fix, { cwd, stdio: "pipe", timeout: 60000 });
        return { fixed: true, action: `${depsDiag.summary}. Fixed via: ${fix}` };
      } catch (e) {
        console.log(chalk.yellow(`  ⚠️ ${fix} failed: ${e.message?.slice(0, 80)}`));
      }
    }
  }

  // Pattern 2: Missing files — ENOENT or error messages mentioning missing file paths
  const enoent = msg.match(/ENOENT.*?'([^']+)'/)
    || msg.match(/[Mm]issing\s+(?:required\s+)?(?:config\s+)?file:\s*([^\s,."]+\.\w+)/)
    || msg.match(/no such file.*?'([^']+)'/)
    || msg.match(/cannot find.*?'([^']+\.\w+)'/i);
  if (enoent) {
    const missingFile = enoent[1];

    // Only auto-create if it's inside the project and looks like a config/data file
    const rel = path.relative(cwd, missingFile).replace(/\\/g, "/");
    // #18: Validate through sandbox to prevent creating files outside allowed paths
    let safePath = missingFile;
    if (sandbox) {
      try { safePath = sandbox.resolve(missingFile); } catch { safePath = null; }
    }
    if (safePath && !rel.startsWith("..") && /\.(json|yaml|yml|toml|ini|conf|cfg|env|log|txt|csv|db|sqlite)$/i.test(missingFile)) {
      try {
        fs.mkdirSync(path.dirname(safePath), { recursive: true });
        const ext = path.extname(missingFile).toLowerCase();

        // For JSON config files, try to infer expected structure from the code or error message
        let content = "";
        if (ext === ".json") {
          content = _inferJsonConfig(missingFile, cwd, parsed);
          // Also try to extract fields from the error message: "Expected JSON with { field1, field2 }"
          if (!content) {
            const fieldsMatch = msg.match(/(?:expected|with|fields?)[:\s]*\{\s*([^}]+)\}/i);
            if (fieldsMatch) {
              const fields = fieldsMatch[1].split(/[,\s]+/).filter(f => /^[a-zA-Z_]\w*$/.test(f.trim()));
              if (fields.length > 0) {
                const config = {};
                for (const f of fields) {
                  const lower = f.toLowerCase();
                  if (/url|endpoint|host|uri/.test(lower)) config[f] = "http://localhost:3000";
                  else if (/timeout|delay/.test(lower)) config[f] = 5000;
                  else if (/port/.test(lower)) config[f] = 3000;
                  else if (/enabled|active/.test(lower)) config[f] = true;
                  else config[f] = "";
                }
                console.log(chalk.gray(`  🔍 Inferred ${fields.length} fields from error message: ${fields.join(", ")}`));
                content = JSON.stringify(config, null, 2);
              }
            }
          }
          content = content || "{}";
        } else {
          const defaults = { ".yaml": "", ".yml": "", ".log": "", ".txt": "", ".csv": "", ".env": "" };
          content = defaults[ext] || "";
        }

        fs.writeFileSync(safePath, content, "utf-8");
        console.log(chalk.blue(`  📄 Created missing file: ${rel}`));
        return { fixed: true, action: `Created missing file: ${rel} with ${content === "{}" ? "empty" : "inferred"} config` };
      } catch {}
    }
  }

  // Pattern 3: EACCES/EPERM permission errors
  const permErr = /EACCES|EPERM/.test(msg);
  if (permErr) {
    const permFile = msg.match(/(?:EACCES|EPERM).*?'([^']+)'/);
    if (permFile) {
      try {
        fs.chmodSync(permFile[1], 0o755);
        console.log(chalk.blue(`  🔑 Fixed permissions on: ${permFile[1]}`));
        return { fixed: true, action: `Fixed permissions (chmod 755) on: ${permFile[1]}` };
      } catch {}
    }
  }

  // Pattern 4: EADDRINUSE — port taken by stale process
  if (/EADDRINUSE/.test(msg)) {
    const portMatch = msg.match(/:(\d{2,5})/) || msg.match(/port\s+(\d{2,5})/i);
    if (portMatch) {
      const port = parseInt(portMatch[1], 10);
      try {
        if (process.platform === "win32") {
          const out = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: "utf-8", timeout: 3000 }).trim();
          const pids = [...new Set(out.split("\n").map(l => parseInt(l.trim().split(/\s+/).pop(), 10)).filter(p => p && p !== process.pid))];
          for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /F`, { timeout: 3000 }); } catch {} }
          if (pids.length > 0) return { fixed: true, action: `Killed stale process(es) on port ${port}: PIDs ${pids.join(", ")}` };
        } else {
          const out = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: "utf-8", timeout: 3000 }).trim();
          const pids = out.split("\n").map(p => parseInt(p, 10)).filter(p => p && p !== process.pid);
          for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
          if (pids.length > 0) return { fixed: true, action: `Killed stale process(es) on port ${port}: PIDs ${pids.join(", ")}` };
        }
      } catch { /* no stale process found */ }
    }
  }

  // Pattern 5: ENOSPC — disk full, try automated cleanup
  if (/ENOSPC/.test(msg)) {
    try {
      const backupDir = path.join(os.homedir(), ".wolverine-safe-backups", "snapshots");
      let cleaned = 0;
      if (fs.existsSync(backupDir)) {
        const now = Date.now();
        for (const dir of fs.readdirSync(backupDir)) {
          const full = path.join(backupDir, dir);
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory() && (now - stat.mtimeMs) > 7 * 86400000) {
              execSync(`rm -rf "${full}"`, { timeout: 10000 });
              cleaned++;
            }
          } catch {}
        }
      }
      try { execSync("npm cache clean --force", { cwd, stdio: "pipe", timeout: 30000 }); cleaned++; } catch {}
      if (cleaned > 0) {
        console.log(chalk.blue(`  🧹 Cleaned ${cleaned} items to free disk space`));
        return { fixed: true, action: `Disk full — cleaned ${cleaned} old backups/caches to free space` };
      }
    } catch {}
  }

  // Pattern 6: EMFILE — too many open files
  if (/EMFILE|ENFILE/.test(msg)) {
    // Close stale file handles by clearing node_modules/.cache and restarting
    try {
      const cachePath = path.join(cwd, "node_modules", ".cache");
      if (fs.existsSync(cachePath)) {
        execSync(`rm -rf "${cachePath}"`, { timeout: 10000 });
        console.log(chalk.blue("  📂 Cleared node_modules/.cache to reduce open FDs"));
        return { fixed: true, action: "EMFILE — cleared build cache to reduce open file descriptors. Consider increasing ulimit -n in your system profile." };
      }
    } catch {}
  }

  return { fixed: false };
}

/**
 * Try to infer JSON config structure by scanning the code that loads the file.
 * Looks for property access patterns after require/readFile of the missing file.
 * Returns a JSON string with empty/default values, or null if can't infer.
 */
function _inferJsonConfig(missingFile, cwd, parsed) {
  // Find which source file loads the missing config
  const basename = path.basename(missingFile);
  const sourceFile = parsed.filePath;
  if (!sourceFile) return null;

  // #17: Escape all regex special characters in basename to prevent regex injection
  const escapedBasename = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // #23: Guard against regex construction failure on unusual filenames
  let configVarRegex;
  try {
    configVarRegex = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:require|JSON\\.parse).*${escapedBasename}`);
  } catch {
    return null;
  }

  try {
    const source = fs.readFileSync(sourceFile, "utf-8");
    // Look for property accesses on the loaded config: config.apiUrl, config.timeout, etc.
    const configVarMatch = source.match(configVarRegex);
    if (!configVarMatch) return null;

    const varName = configVarMatch[1];
    // Find all property accesses: varName.prop or varName["prop"]
    const propRegex = new RegExp(`${varName}\\.(\\w+)`, "g");
    const bracketRegex = new RegExp(`${varName}\\["(\\w+)"\\]`, "g");
    const props = new Set();
    let m;
    while ((m = propRegex.exec(source)) !== null) props.add(m[1]);
    while ((m = bracketRegex.exec(source)) !== null) props.add(m[1]);

    if (props.size === 0) return null;

    // Build config with sensible defaults based on property names
    const config = {};
    for (const prop of props) {
      const lower = prop.toLowerCase();
      if (/url|endpoint|host|uri/.test(lower)) config[prop] = "http://localhost:3000";
      else if (/port/.test(lower)) config[prop] = 3000;
      else if (/timeout|delay|interval|ttl/.test(lower)) config[prop] = 5000;
      else if (/key|token|secret/.test(lower)) config[prop] = "placeholder";
      else if (/name/.test(lower)) config[prop] = "default";
      else if (/enabled|active|debug/.test(lower)) config[prop] = true;
      else if (/count|max|min|limit|size/.test(lower)) config[prop] = 10;
      else if (/path|dir|file/.test(lower)) config[prop] = "./";
      else config[prop] = "";
    }

    console.log(chalk.gray(`  🔍 Inferred ${props.size} config fields from ${path.basename(sourceFile)}: ${[...props].join(", ")}`));
    return JSON.stringify(config, null, 2);
  } catch {
    return null;
  }
}

module.exports = { heal };
