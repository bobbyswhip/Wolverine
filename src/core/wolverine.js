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
const { EVENT_TYPES } = require("../logger/event-logger");

/**
 * The Wolverine healing engine — v3.
 *
 * Two repair modes:
 * 1. FAST PATH: Single-file fix (simple errors, uses CODING_MODEL)
 * 2. AGENT PATH: Multi-file agent with tool use (complex errors, uses REASONING_MODEL)
 *
 * The engine tries fast path first. If that fails verification, it escalates to the agent.
 */
async function heal({ stderr, cwd, sandbox, redactor, notifier, rateLimiter, backupManager, logger, brain, mcp, skills, repairHistory }) {
  const healStartTime = Date.now();
  // Redact secrets from stderr BEFORE any processing, logging, or AI calls
  const safeStderr = redactor ? redactor.redact(stderr) : stderr;

  if (logger) logger.info(EVENT_TYPES.HEAL_START, "Wolverine detected a crash", { stderr: safeStderr.slice(0, 500) });
  console.log(chalk.yellow("\n🐺 Wolverine detected a crash. Analyzing...\n"));

  // 1. Parse the error (use original for file path extraction, redacted for everything else)
  const parsed = parseError(stderr);
  const errorSignature = RateLimiter.signature(parsed.errorMessage, parsed.filePath);

  // Redact the parsed fields — these go to AI, brain, and logs
  if (redactor) {
    parsed.errorMessage = redactor.redact(parsed.errorMessage);
    parsed.stackTrace = redactor.redact(parsed.stackTrace);
  }

  if (redactor && redactor.containsSecrets(stderr)) {
    console.log(chalk.yellow("  🔐 Secrets detected in error output — redacted before AI/brain/logs"));
  }

  if (logger) logger.debug(EVENT_TYPES.HEAL_PARSE, `Parsed: ${parsed.errorMessage}`, { file: parsed.filePath, line: parsed.line });

  if (!parsed.filePath) {
    console.log(chalk.red("  Could not identify the source file from the error. Skipping repair."));
    if (logger) logger.error(EVENT_TYPES.HEAL_FAILED, "Could not parse file path from error");
    return { healed: false, explanation: "Could not parse file path from error" };
  }

  // 2. Sandbox check
  try {
    sandbox.resolve(parsed.filePath);
  } catch (e) {
    if (e instanceof SandboxViolationError) {
      console.log(chalk.red(`  🔒 SANDBOX: ${e.message}`));
      if (logger) logger.error(EVENT_TYPES.SECURITY_SANDBOX_VIOLATION, e.message, { file: parsed.filePath });
      return { healed: false, explanation: "File outside sandbox — access denied" };
    }
    throw e;
  }

  if (!sandbox.exists(parsed.filePath)) {
    console.log(chalk.red(`  Source file not found: ${parsed.filePath}`));
    return { healed: false, explanation: "Source file not found" };
  }

  console.log(chalk.cyan(`  File:  ${parsed.filePath}`));
  console.log(chalk.cyan(`  Line:  ${parsed.line || "unknown"}`));
  console.log(chalk.cyan(`  Error: ${parsed.errorMessage}`));

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

  const injectionResult = await detectInjection(parsed.errorMessage, parsed.stackTrace, { openaiClient });

  if (logger) logger.info(EVENT_TYPES.HEAL_INJECTION_SCAN, `Injection scan: ${injectionResult.safe ? "clean" : "BLOCKED"}`, injectionResult);

  if (!injectionResult.safe) {
    console.log(chalk.red("  🚨 BLOCKED: Potential prompt injection detected."));
    if (logger) logger.critical(EVENT_TYPES.SECURITY_INJECTION_DETECTED, "Injection detected — repair blocked", injectionResult);
    return { healed: false, explanation: "Prompt injection detected — repair blocked" };
  }
  console.log(chalk.green("  ✅ Clean — no injection detected."));

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

  // 5. Read the source file + get brain context
  const sourceCode = sandbox.readFile(parsed.filePath);

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

  // 6. Research — check past attempts to avoid loops
  const researcher = new ResearchAgent({ brain, logger, redactor });
  let researchContext = "";
  try {
    researchContext = await researcher.buildFixContext(parsed.errorMessage);
    if (researchContext) console.log(chalk.gray(`  🔍 Research: found past context for this error`));
  } catch {}

  // 7. Goal Loop — set goal, iterate until fixed or exhausted
  // Iteration 1: fast path (CODING_MODEL)
  // Iteration 2: agent path (REASONING_MODEL)
  // Iteration 3: deep research (RESEARCH_MODEL) + agent retry
  const loop = new GoalLoop({
    maxIterations: parseInt(process.env.WOLVERINE_MAX_RETRIES, 10) || 3,
    researcher,
    logger,
    goal: `Fix: ${parsed.errorMessage.slice(0, 80)}`,

    onAttempt: async (iteration, researchCtx) => {
      // Create backup for this attempt
      // Full server/ backup — includes all files, configs, databases
      const bid = backupManager.createBackup(null);
      backupManager.setErrorSignature(bid, errorSignature);
      if (logger) logger.info(EVENT_TYPES.BACKUP_CREATED, `Backup ${bid} (iteration ${iteration})`, { backupId: bid });

      const fullContext = [brainContext, researchContext, researchCtx].filter(Boolean).join("\n");

      let result;
      if (iteration === 1) {
        // Fast path — CODING_MODEL, single file
        console.log(chalk.yellow(`  🧠 Fast path (${getModel("coding")})...`));
        try {
          const repair = await requestRepair({
            filePath: parsed.filePath, sourceCode,
            errorMessage: parsed.errorMessage, stackTrace: parsed.stackTrace,
          });
          rateLimiter.record(errorSignature);

          const sandboxCheck = sandbox.validateChanges(repair.changes);
          if (!sandboxCheck.valid) throw new Error("Changes outside sandbox");

          const patchResults = applyPatch(repair.changes, cwd, sandbox);
          if (!patchResults.every(r => r.success)) throw new Error("Patch failed");

          for (const r of patchResults) console.log(chalk.green(`  ✅ Patched: ${r.file}`));

          const verification = await verifyFix(parsed.filePath, cwd, errorSignature);
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
      } else {
        // Agent path — REASONING_MODEL, multi-file
        console.log(chalk.magenta(`  🤖 Agent path (${getModel("reasoning")})...`));
        const agent = new AgentEngine({
          sandbox, logger, cwd, mcp,
          maxTurns: iteration >= 3 ? 10 : 8,
          maxTokens: iteration >= 3 ? 40000 : 25000,
        });

        const agentResult = await agent.run({
          errorMessage: parsed.errorMessage, stackTrace: parsed.stackTrace,
          primaryFile: parsed.filePath, sourceCode,
          brainContext: fullContext,
        });
        rateLimiter.record(errorSignature, agentResult.totalTokens);

        if (agentResult.success && agentResult.filesModified.length > 0) {
          const verification = await verifyFix(parsed.filePath, cwd, errorSignature);
          if (verification.verified) {
            backupManager.markVerified(bid);
            rateLimiter.clearSignature(errorSignature);
            return { healed: true, explanation: agentResult.summary, backupId: bid, mode: "agent", agentStats: agentResult };
          }
        }

        backupManager.rollbackTo(bid);
        return { healed: false, explanation: agentResult.summary || "Agent could not fix" };
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

  if (goalResult.success) {
    if (logger) logger.info(EVENT_TYPES.HEAL_SUCCESS, goalResult.explanation, { iteration: goalResult.iteration, mode: goalResult.mode });
    return { healed: true, ...goalResult };
  }

  if (logger) logger.error(EVENT_TYPES.HEAL_FAILED, `Goal failed after ${goalResult.iteration} iterations`, { attempts: goalResult.attempts });
  return { healed: false, explanation: goalResult.explanation };
}

module.exports = { heal };
