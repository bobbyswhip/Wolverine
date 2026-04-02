const chalk = require("chalk");
const { parseError } = require("./error-parser");
const { requestRepair, getClient } = require("./ai-client");
const { getModel } = require("./models");
const { applyPatch } = require("./patcher");
const { verifyFix } = require("./verifier");
const { Sandbox, SandboxViolationError } = require("../security/sandbox");
const { RateLimiter } = require("../security/rate-limiter");
const { detectInjection } = require("../security/injection-detector");
const { BackupManager } = require("../backup/backup-manager");
const { AgentEngine } = require("../agent/agent-engine");
const { ResearchAgent } = require("../agent/research-agent");
const { GoalLoop } = require("../agent/goal-loop");
const { exploreAndFix, spawnParallel } = require("../agent/sub-agents");
const { EVENT_TYPES } = require("../logger/event-logger");
const { diagnose: diagnoseDeps } = require("../skills/deps");

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
  const HEAL_TIMEOUT_MS = parseInt(process.env.WOLVERINE_HEAL_TIMEOUT_MS, 10) || 300000; // 5 min
  try {
    return await Promise.race([
      _healImpl(opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), HEAL_TIMEOUT_MS)),
    ]);
  } catch (err) {
    if (err.message === "timeout") {
      console.log(chalk.red(`\n🐺 Heal timed out after ${HEAL_TIMEOUT_MS / 1000}s`));
      if (opts.logger) opts.logger.error(EVENT_TYPES.HEAL_FAILED, `Heal timed out after ${HEAL_TIMEOUT_MS / 1000}s`);
      return { healed: false, explanation: `Heal timed out after ${HEAL_TIMEOUT_MS / 1000}s` };
    }
    throw err;
  }
}

async function _healImpl({ stderr, cwd, sandbox, notifier, rateLimiter, backupManager, logger, brain, mcp, skills, repairHistory, routeContext }) {
  const healStartTime = Date.now();
  const { redact, hasSecrets } = require("../security/secret-redactor");

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
  const opsFix = await tryOperationalFix(parsed, cwd, logger);
  if (opsFix.fixed) {
    console.log(chalk.green(`  ⚡ Operational fix applied: ${opsFix.action}`));
    if (logger) logger.info(EVENT_TYPES.HEAL_SUCCESS, `Operational fix: ${opsFix.action}`, { action: opsFix.action });
    if (repairHistory) {
      repairHistory.record({
        error: parsed.errorMessage, file: parsed.filePath, line: parsed.line,
        resolution: opsFix.action, success: true, mode: "operational",
        model: "none", tokens: 0, cost: 0, iteration: 0,
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
      const fs = require("fs");
      const path = require("path");
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

  // 7. Research — check past attempts to avoid loops
  const researcher = new ResearchAgent({ brain, logger });
  let researchContext = "";
  try {
    researchContext = await researcher.buildFixContext(parsed.errorMessage);
    if (researchContext) console.log(chalk.gray(`  🔍 Research: found past context for this error`));
  } catch {}

  // 7b. Token budget by error complexity — simple bugs get tight caps
  const isSimpleError = /TypeError|ReferenceError|SyntaxError|Cannot find module/.test(parsed.errorMessage);
  const isModerateError = /ECONNREFUSED|timeout|ENOENT|EACCES|EADDRINUSE/.test(parsed.errorMessage);
  const tokenBudget = isSimpleError
    ? { fast: 5000, agent: 20000, subAgent: 15000 }
    : isModerateError
    ? { fast: 10000, agent: 50000, subAgent: 30000 }
    : { fast: 15000, agent: 100000, subAgent: 50000 };
  console.log(chalk.gray(`  💰 Token budget: ${isSimpleError ? "simple" : isModerateError ? "moderate" : "complex"} (agent: ${tokenBudget.agent})`));

  // 8. Goal Loop — set goal, iterate until fixed or exhausted
  const loop = new GoalLoop({
    maxIterations: parseInt(process.env.WOLVERINE_MAX_RETRIES, 10) || 3,
    researcher,
    logger,
    goal: `Fix: ${parsed.errorMessage.slice(0, 80)}`,

    onAttempt: async (iteration, researchCtx, priorAttempts) => {
      // Create backup for this attempt
      const bid = backupManager.createBackup(`heal attempt ${iteration}: ${parsed.errorMessage.slice(0, 60)}`);
      backupManager.setErrorSignature(bid, errorSignature);
      if (logger) logger.info(EVENT_TYPES.BACKUP_CREATED, `Backup ${bid} (iteration ${iteration})`, { backupId: bid });

      // Build concise prior attempt summary instead of full context bleed
      let priorSummary = "";
      if (priorAttempts && priorAttempts.length > 0) {
        priorSummary = "\nPRIOR ATTEMPTS (do NOT repeat):\n" + priorAttempts.map(a =>
          `- Attempt ${a.iteration} (${a.mode}): ${a.explanation?.slice(0, 100)}`
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
          rateLimiter.record(errorSignature);

          // Execute shell commands first (npm install, mkdir, etc.)
          if (repair.commands && Array.isArray(repair.commands)) {
            const { execSync } = require("child_process");
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
            rateLimiter.clearSignature(errorSignature);
            return { healed: true, explanation: repair.explanation, backupId: bid, mode: "fast" };
          }

          backupManager.rollbackTo(bid);
          return { healed: false, explanation: `Fast path: ${verification.status}` };
        } catch (err) {
          backupManager.rollbackTo(bid);
          return { healed: false, explanation: `Fast path error: ${err.message}` };
        }
      } else if (iteration <= 2) {
        // Agent path — REASONING_MODEL (also handles iteration 1 when no file)
        console.log(chalk.magenta(`  🤖 Agent path (${getModel("reasoning")})...`));
        const agent = new AgentEngine({
          sandbox, logger, cwd, mcp,
          maxTurns: isSimpleError ? 4 : 8,
          maxTokens: tokenBudget.agent,
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

  // Record to repair history
  if (repairHistory) {
    const duration = Date.now() - healStartTime;
    const tokenUsage = goalResult.agentStats?.totalTokens || 0;
    const { calculateCost } = require("../logger/pricing");
    const model = goalResult.mode === "fast" ? getModel("coding") : getModel("reasoning");
    const cost = calculateCost(model, tokenUsage * 0.7, tokenUsage * 0.3); // estimate in/out split

    repairHistory.record({
      error: parsed.errorMessage,
      file: parsed.filePath,
      line: parsed.line,
      resolution: goalResult.explanation,
      success: goalResult.success,
      mode: goalResult.mode || "unknown",
      model,
      tokens: tokenUsage,
      cost: cost.total,
      iteration: goalResult.iteration,
      duration,
      filesModified: goalResult.agentStats?.filesModified || [],
    });
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
async function tryOperationalFix(parsed, cwd, logger) {
  const { execSync } = require("child_process");
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

  // Pattern 2: ENOENT on config/data files the server expects
  const enoent = msg.match(/ENOENT.*?'([^']+)'/);
  if (enoent) {
    const missingFile = enoent[1];
    const fs = require("fs");
    const path = require("path");

    // Only auto-create if it's inside the project and looks like a config/data file
    const rel = path.relative(cwd, missingFile).replace(/\\/g, "/");
    if (!rel.startsWith("..") && /\.(json|yaml|yml|toml|ini|conf|cfg|env|log|txt|csv|db|sqlite)$/i.test(missingFile)) {
      try {
        fs.mkdirSync(path.dirname(missingFile), { recursive: true });
        // Create empty file or sensible default
        const ext = path.extname(missingFile).toLowerCase();
        const defaults = { ".json": "{}", ".yaml": "", ".yml": "", ".log": "", ".txt": "", ".csv": "", ".env": "" };
        fs.writeFileSync(missingFile, defaults[ext] || "", "utf-8");
        console.log(chalk.blue(`  📄 Created missing file: ${rel}`));
        return { fixed: true, action: `Created missing file: ${rel}` };
      } catch {}
    }
  }

  // Pattern 3: EACCES/EPERM permission errors
  const permErr = /EACCES|EPERM/.test(msg);
  if (permErr) {
    const permFile = msg.match(/(?:EACCES|EPERM).*?'([^']+)'/);
    if (permFile) {
      try {
        const fs = require("fs");
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

  return { fixed: false };
}

module.exports = { heal };
