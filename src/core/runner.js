const { spawn, execSync } = require("child_process");
const path = require("path");
const chalk = require("chalk");
const { heal } = require("./wolverine");
const { HealthMonitor } = require("./health-monitor");
const { Sandbox } = require("../security/sandbox");
const { RateLimiter } = require("../security/rate-limiter");
const { BackupManager, STABILITY_THRESHOLD_MS } = require("../backup/backup-manager");
const { EventLogger, EVENT_TYPES } = require("../logger/event-logger");
const { DashboardServer } = require("../dashboard/server");
const { PerfMonitor } = require("../monitor/perf-monitor");
const { Brain } = require("../brain/brain");
const { initRedactor, getRedactor } = require("../security/secret-redactor");
const { McpRegistry } = require("../mcp/mcp-registry");
const { TokenTracker } = require("../logger/token-tracker");
const { RepairHistory } = require("../logger/repair-history");
const { setTokenTracker } = require("./ai-client");
const { SkillRegistry } = require("../skills/skill-registry");
const { ProcessMonitor } = require("../monitor/process-monitor");
const { RouteProber } = require("../monitor/route-prober");
const { startHeartbeat, stopHeartbeat } = require("../platform/heartbeat");
const { Notifier } = require("../notifications/notifier");
const { loadConfig } = require("./config");
const { ErrorMonitor } = require("../monitor/error-monitor");
const { startAutoUpdate, stopAutoUpdate } = require("../platform/auto-update");
const { LoopGuard, ensureSingleProcess } = require("../skills/loop-guard");

/**
 * The Wolverine process runner — v3.
 *
 * Full autonomous server agent:
 * - Process management (spawn, crash detection, restart)
 * - AI-powered self-healing (fast path + multi-file agent)
 * - Health check monitoring
 * - Performance monitoring with proactive optimization
 * - Real-time web dashboard
 * - Comprehensive event logging
 */
class WolverineRunner {
  constructor(scriptPath, options = {}) {
    this.scriptPath = path.resolve(scriptPath);
    this.cwd = options.cwd || path.dirname(this.scriptPath);
    this.maxRetries = parseInt(process.env.WOLVERINE_MAX_RETRIES, 10) || 3;
    this.retryCount = 0;
    this.child = null;
    this.running = false;

    // Stability tracking
    this._lastStartTime = null;
    this._lastBackupId = null;
    this._stabilityTimer = null;
    this._stderrBuffer = "";
    this._healInProgress = false;
    this._healStatus = null; // { active, file, error, phase, startedAt, iteration }

    this._initSubsystems(options);
  }

  /**
   * Initialize all subsystems — extracted from constructor for readability.
   */
  _initSubsystems(options) {
    // Core subsystems
    this.sandbox = new Sandbox(this.cwd);
    this.redactor = initRedactor(this.cwd);

    // Code Guard — runtime injection detection
    try {
      const { start: startCodeGuard, onInjection } = require("../security/code-guard");
      const { improvementLoop } = require("../security/self-improve");
      startCodeGuard(this.cwd);
      onInjection(async (event) => {
        console.log(chalk.red(`\n  🛡️  CODE INJECTION BLOCKED: ${event.file}`));
        for (const t of event.threats || []) {
          console.log(chalk.red(`     [${t.severity}] ${t.label} line ${t.line}`));
        }
        // Run self-improvement loop
        try { await improvementLoop(event, this.cwd); } catch {}
      });
    } catch (e) {
      console.warn(chalk.yellow(`  ⚠️  Code guard init: ${e.message}`));
    }
    const cfg = loadConfig();
    this.rateLimiter = new RateLimiter({
      maxCallsPerWindow: cfg.rateLimiting.maxCallsPerWindow,
      windowMs: cfg.rateLimiting.windowMs,
      minGapMs: cfg.rateLimiting.minGapMs,
      maxTokensPerHour: cfg.rateLimiting.maxTokensPerHour,
      maxGlobalHealsPerWindow: cfg.heal?.globalMaxHeals || 5,
      globalWindowMs: cfg.heal?.globalWindowMs || 300000,
    });
    this.backupManager = new BackupManager(this.cwd);
    this.logger = new EventLogger(this.cwd);
    this.logger.setRedactor(this.redactor);
    this.tokenTracker = new TokenTracker(this.cwd);
    setTokenTracker(this.tokenTracker);
    this.repairHistory = new RepairHistory(this.cwd);
    this.notifier = new Notifier({
      logger: this.logger,
      redactor: this.redactor,
    });

    // Health monitoring
    const port = cfg.server.port;
    this.healthMonitor = new HealthMonitor({
      port,
      path: options.healthPath || "/health",
      intervalMs: cfg.healthCheck.intervalMs,
      timeoutMs: cfg.healthCheck.timeoutMs,
      failThreshold: cfg.healthCheck.failThreshold,
      startDelayMs: cfg.healthCheck.startDelayMs,
    });

    // Performance monitoring
    this.perfMonitor = new PerfMonitor({
      logger: this.logger,
      sandbox: this.sandbox,
      cwd: this.cwd,
      port,
    });

    // Process monitor — heartbeat, memory, CPU, leak detection
    this.processMonitor = new ProcessMonitor({ logger: this.logger });

    // Brain — semantic memory + project context
    this.brain = new Brain(this.cwd);

    // Route prober — tests all routes periodically
    this.routeProber = new RouteProber({
      port,
      logger: this.logger,
      brain: this.brain,
    });

    // Error monitor — detects caught 500 errors without process crash
    this.errorMonitor = new ErrorMonitor({
      threshold: cfg.errorMonitor.threshold,
      windowMs: cfg.errorMonitor.windowMs,
      cooldownMs: cfg.errorMonitor.cooldownMs,
      logger: this.logger,
      onError: (routePath, errorDetails) => this._healFromError(routePath, errorDetails),
    });

    // Loop guard — detects infinite heal loops, generates bug reports
    this.loopGuard = new LoopGuard(this.cwd, {
      maxAttempts: parseInt(process.env.WOLVERINE_LOOP_MAX_ATTEMPTS, 10) || 3,
      windowMs: parseInt(process.env.WOLVERINE_LOOP_WINDOW_MS, 10) || 600000,
    });

    // Skills — discoverable capabilities
    this.skills = new SkillRegistry();
    this.skills.load();

    // MCP — external tool servers
    this.mcp = new McpRegistry({
      projectRoot: this.cwd,
      redactor: this.redactor,
      logger: this.logger,
    });

    // Web dashboard
    this.dashboard = new DashboardServer({
      logger: this.logger,
      backupManager: this.backupManager,
      perfMonitor: this.perfMonitor,
      healthMonitor: this.healthMonitor,
      brain: this.brain,
      sandbox: this.sandbox,
      redactor: this.redactor,
      scriptPath: this.scriptPath,
      runner: this,
      tokenTracker: this.tokenTracker,
      skills: this.skills,
      repairHistory: this.repairHistory,
      processMonitor: this.processMonitor,
      routeProber: this.routeProber,
      errorMonitor: this.errorMonitor,
    });
  }

  async start() {
    // Ensure only one wolverine instance runs — kill any old process
    ensureSingleProcess(this.cwd);

    this.running = true;
    this.retryCount = 0;

    this.logger.info(EVENT_TYPES.PROCESS_START, "Wolverine started", {
      script: this.scriptPath,
      cwd: this.cwd,
      maxRetries: this.maxRetries,
    });

    // Port safety check
    const port = parseInt(process.env.PORT, 10) || 3000;
    const safeDevPorts = [3000, 3001, 8080, 8443];
    const safeProdPorts = [80, 443, 8080, 8443];
    const env = process.env.NODE_ENV || "development";

    if (env === "production" && port !== 443 && port !== 80 && port !== 8443 && port !== 8080) {
      console.log(chalk.yellow(`  ⚠️  Port ${port} in production — recommend 443 (HTTPS) or 80 (HTTP) behind a reverse proxy`));
    } else if (env !== "production" && !safeDevPorts.includes(port) && port < 1024) {
      console.log(chalk.yellow(`  ⚠️  Port ${port} requires root/admin — use 3000 for local development`));
    } else if (port > 9999) {
      console.log(chalk.yellow(`  ⚠️  Port ${port} is non-standard — use 3000 (dev) or 443 (prod) for best compatibility`));
    }

    // Initialize brain (scan project, seed docs, embed function map)
    try {
      await this.brain.init();
    } catch (err) {
      console.log(chalk.yellow(`  ⚠️  Brain init failed (non-fatal): ${err.message}`));
    }

    // Initialize MCP servers
    try {
      await this.mcp.init();
    } catch (err) {
      console.log(chalk.yellow(`  ⚠️  MCP init failed (non-fatal): ${err.message}`));
    }

    // Initialize vault (encrypted key storage)
    try {
      const { initVault, isVaultInitialized } = require("../vault/vault-manager");
      const vaultResult = await initVault();
      if (vaultResult.created) {
        try {
          const { getWalletAddress } = require("../vault/wallet-ops");
          const addr = await getWalletAddress();
          console.log(chalk.green(`  🔐 Vault initialized — wallet: ${addr}`));
        } catch { console.log(chalk.green("  🔐 Vault initialized")); }
      } else if (isVaultInitialized()) {
        console.log(chalk.gray("  🔐 Vault: ready"));
      }
    } catch (err) {
      console.log(chalk.yellow(`  ⚠️  Vault init failed (non-fatal): ${err.message}`));
    }

    // Scan server context (routes, DB, config, deps) for agent knowledge
    try {
      const { scan } = require("./server-context");
      const ctx = scan(this.cwd);
      if (ctx) {
        const routes = ctx.routes.reduce((s, r) => s + r.endpoints.length, 0);
        const warns = (ctx.warnings || []).length;
        console.log(chalk.gray(`  🗺️  Server context: ${routes} routes, ${ctx.structure.length} files, ${ctx.envVars.length} env vars`));
        if (warns > 0) console.log(chalk.yellow(`  ⚠️  ${warns} security warning(s) — run wolverine --init for details`));
      }
    } catch {}

    // Log redactor stats
    const redactorStats = this.redactor.getStats();
    console.log(chalk.gray(`  🔐 Secret redactor: ${redactorStats.trackedSecrets} secrets tracked from ${redactorStats.envFiles} env file(s)`));

    // Log backup stats
    const stats = this.backupManager.getStats();
    if (stats.total > 0) {
      console.log(chalk.gray(`  📁 Backups: ${stats.total} total (${stats.stable} stable, ${stats.verified} verified, ${stats.unstable} unstable)`));
    }
    console.log(chalk.gray(`  💓 Health checks: every ${this.healthMonitor.intervalMs / 1000}s on :${this.healthMonitor.port}${this.healthMonitor.path}`));

    // Prune old backups
    this.backupManager.prune();

    // Start dashboard
    this.dashboard.start();

    // Start performance monitor
    this.perfMonitor.start();

    // Start platform telemetry (heartbeats to analytics backend)
    startHeartbeat({
      processMonitor: this.processMonitor,
      routeProber: this.routeProber,
      tokenTracker: this.tokenTracker,
      repairHistory: this.repairHistory,
      backupManager: this.backupManager,
      brain: this.brain,
      redactor: this.redactor,
    });

    // Auto-update: check for new wolverine-ai versions
    const autoUpdateCfg = loadConfig().autoUpdate || {};
    const autoUpdateEnabled = process.env.WOLVERINE_AUTO_UPDATE !== "false" && autoUpdateCfg.enabled !== false;
    if (autoUpdateEnabled) {
      const { getCurrentVersion } = require("../platform/auto-update");
      const updateInterval = autoUpdateCfg.intervalMs || 3600000;
      startAutoUpdate({
        cwd: this.cwd,
        logger: this.logger,
        intervalMs: updateInterval,
        onUpdate: (result) => {
          console.log(chalk.blue(`  🔄 Wolverine updated ${result.from} → ${result.to}, restarting...`));
          this.logger.info("update.restart", `Restarting after update ${result.from} → ${result.to}`);
          this.restart();
        },
      });
      console.log(chalk.gray(`  🔄 Auto-update: enabled (v${getCurrentVersion()}, checks every ${Math.round(updateInterval / 60000)}min)`));
    } else {
      console.log(chalk.gray("  🔄 Auto-update: disabled"));
    }

    // Create startup backup — safety net for corrupted server/ from bad updates
    // If the child crashes immediately after this, we can rollback to this known state
    try {
      this._startupBackupId = this.backupManager.createBackup("pre-start (safety snapshot)");
      console.log(chalk.gray(`  📸 Startup backup: ${this._startupBackupId}`));
    } catch (err) {
      console.log(chalk.yellow(`  ⚠️  Startup backup failed (non-fatal): ${err.message}`));
    }

    this._spawn();
  }

  restart() {
    console.log(chalk.blue("\n  🔄 Restarting server..."));
    // Reset config cache so restart picks up any settings.json changes
    const { resetConfig } = require("./config");
    resetConfig();
    this.healthMonitor.stop();
    this._clearStabilityTimer();
    // Clear any pending heals — restart is a clean slate
    this._pendingErrorHeal = null;
    // #1: Don't clear _healInProgress here — only the heal function itself should clear it
    // #6: Clear stale heal status so dashboard doesn't show phantom heals
    this._healStatus = null;

    if (this.child) {
      const oldChild = this.child;
      this.child = null;
      let spawned = false;

      // Wait for old process to actually exit before spawning new one
      const onExit = () => {
        if (spawned) return; // Prevent double-spawn from exit + force-kill timeout
        spawned = true;
        // #7: Don't call _ensurePortFree() here — _spawn() already calls it
        // Give port time to fully release (TIME_WAIT)
        setTimeout(() => this._spawn(), 500);
      };

      oldChild.removeAllListeners("exit");
      oldChild.once("exit", onExit);
      this._killProcessTree(oldChild.pid, "SIGTERM");

      // Force kill if it doesn't exit in 3s
      setTimeout(() => {
        if (!spawned) {
          this._killProcessTree(oldChild.pid, "SIGKILL");
          onExit();
        }
      }, 3000);
    } else {
      // #7: Don't call _ensurePortFree() here — _spawn() already calls it
      setTimeout(() => this._spawn(), 500);
    }
  }

  /**
   * Graceful shutdown — backup, stop subsystems, kill child cleanly.
   * Prevents wolverine from treating shutdown as a crash.
   */
  stop() {
    if (!this.running) return; // prevent double-stop
    this.running = false;
    this._shuttingDown = true;

    console.log(chalk.yellow("\n  🔒 Graceful shutdown..."));

    // Create shutdown backup
    try {
      this.backupManager.createShutdownBackup();
    } catch {}

    // Stop all monitors (prevents restart triggers during shutdown)
    this._clearStabilityTimer();
    this.healthMonitor.stop();
    this.perfMonitor.stop();
    this.processMonitor.stop();
    this.routeProber.stop();
    stopHeartbeat();
    stopAutoUpdate();
    this.mcp.shutdown();
    this.tokenTracker.save();
    this.dashboard.stop();

    this.logger.info(EVENT_TYPES.PROCESS_STOP, "Wolverine stopped (graceful shutdown)");

    // Kill child + all its descendants — remove exit listener first so it doesn't trigger heal
    if (this.child) {
      const pid = this.child.pid;
      this.child.removeAllListeners("exit");
      this._killProcessTree(pid, "SIGTERM");
      // Force kill after 3s if it doesn't respond
      setTimeout(() => {
        this._killProcessTree(pid, "SIGKILL");
      }, 3000);
      this.child = null;
    }
  }

  _spawn() {
    if (!this.running) return;

    this._ensurePortFree();

    console.log(chalk.blue(`\n🚀 Starting: node ${this.scriptPath}`));
    console.log(chalk.gray(`   Attempt ${this.retryCount + 1}/${this.maxRetries + 1}\n`));

    this._stderrBuffer = "";
    this._lastStartTime = Date.now();

    // Spawn with --require error-hook.js for IPC error reporting
    // The error hook auto-patches Fastify/Express to report caught 500s
    const errorHookPath = path.join(__dirname, "error-hook.js");
    const sysInfo = require("./system-info").detect();
    this.child = spawn("node", ["--require", errorHookPath, this.scriptPath], {
      cwd: this.cwd,
      env: {
        ...process.env,
        // Tell the user's server how many workers to fork (if it uses clustering)
        WOLVERINE_RECOMMENDED_WORKERS: String(sysInfo.recommended?.workers || 1),
        WOLVERINE_MANAGED: "1", // Signal that wolverine is managing this process
      },
      stdio: ["inherit", "inherit", "pipe", "ipc"],
    });

    this.child.stderr.on("data", (data) => {
      const text = data.toString();
      this._stderrBuffer += text;
      process.stderr.write(text);
    });

    // #27: Only start stability timer if there's a backup to promote — don't clear
    // an existing timer on every spawn (e.g., auto-update restart shouldn't reset
    // the stability countdown for a previously healed backup)
    if (this._lastBackupId) {
      this._startStabilityTimer();
    }

    // Start process monitor (memory, CPU, heartbeat)
    if (this.child && this.child.pid) {
      this.processMonitor.reset(this.child.pid);
      if (!this.processMonitor._running) {
        this.processMonitor.start(this.child.pid, (reason) => {
          if (this._healInProgress) return;
          console.log(chalk.red(`\n🚨 Process monitor triggered restart: ${reason}`));
          this.logger.error("process.monitor_restart", `Restart: ${reason}`, { reason, pid: this.child?.pid });
          this.restart();
        });
      } else {
        this.processMonitor.reset(this.child.pid);
      }
    }

    // Start route prober (auto-discovers and tests all routes)
    if (!this.routeProber._running) this.routeProber.start();

    // Start health monitoring
    this.healthMonitor.stop();
    this.healthMonitor.reset();
    this.healthMonitor.start(async (reason) => {
      try {
        if (this._healInProgress || !this.running) return;
        // #26: Claim the heal lock immediately — prevents exit event from starting
        // a concurrent heal between our check and the child kill below
        this._healInProgress = true;
        console.log(chalk.red(`\n🚨 Health check triggered heal (reason: ${reason})`));
        this.logger.error(EVENT_TYPES.HEALTH_UNRESPONSIVE, `Server unresponsive: ${reason}`, { reason });
        this.healthMonitor.stop();

        // Kill the hung process — remove exit listener to prevent double-heal
        if (this.child) {
          const pid = this.child.pid;
          this.child.removeAllListeners("exit");
          this._killProcessTree(pid, "SIGKILL");
          this.child = null;
        }

        // Synthesize error context for the heal pipeline
        this._stderrBuffer = `Server became unresponsive. Health check failed: ${reason}\n` +
          `The server was running but stopped responding to HTTP requests.\n` +
          `Possible causes: infinite loop, deadlock, memory exhaustion, blocked event loop.`;

        this.retryCount++;
        if (this.retryCount > this.maxRetries) {
          console.log(chalk.red(`\n🛑 Max retries reached.`));
          this._logRollbackHint();
          this.running = false;
          this._healInProgress = false;
          return;
        }
        // Pass through directly — _healAndRestart checks _healInProgress internally,
        // so release it just before the call to avoid a race window
        this._healInProgress = false;
        await this._healAndRestart({ skipHealLockCheck: true });
      } catch (err) {
        // #5: Prevent unhandled errors in health callback from crashing the parent
        console.log(chalk.red(`  ⚠️  Health callback error: ${err.message}`));
        this._healInProgress = false;
        this._healStatus = null;
        if (this.running) this._spawn();
      }
    });

    this.child.on("exit", async (code, signal) => {
      this._clearStabilityTimer();
      this.healthMonitor.stop();

      if (!this.running) return;

      // Clean exit or graceful shutdown — don't heal
      if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") {
        console.log(chalk.green("\n✅ Process exited cleanly."));
        this.logger.info(EVENT_TYPES.PROCESS_HEALTHY, "Process exited cleanly");
        return;
      }

      // #28: SIGKILL = likely OOM — synthesize useful stderr for the heal pipeline
      if (signal === "SIGKILL" && (!this._stderrBuffer.trim() || this._stderrBuffer.trim().length < 10)) {
        this._stderrBuffer = `Process killed by SIGKILL (possible OOM). Memory limit may have been exceeded. Check memory usage patterns and reduce memory consumption.\nExit code: ${code}, Signal: ${signal}`;
        console.log(chalk.red(`\n💀 Process killed by SIGKILL (possible OOM)`));
        this.logger.error(EVENT_TYPES.PROCESS_CRASH, "SIGKILL — possible OOM", { exitCode: code, signal });
      }

      // Killed by signal with no stderr — just restart, don't waste tokens healing
      if (!this._stderrBuffer.trim() || this._stderrBuffer.trim().length < 10) {
        console.log(chalk.yellow(`\n⚠️  Process killed (code: ${code}, signal: ${signal}) — no error to heal, restarting`));
        this.logger.warn(EVENT_TYPES.PROCESS_CRASH, `Killed with no stderr (code: ${code}, signal: ${signal})`, { exitCode: code, signal });
        this._spawn();
        return;
      }

      const uptime = Date.now() - this._lastStartTime;
      console.log(chalk.red(`\n💥 Process crashed with exit code ${code} (uptime: ${Math.round(uptime / 1000)}s)`));
      this.logger.error(EVENT_TYPES.PROCESS_CRASH, `Crashed with code ${code}`, {
        exitCode: code,
        uptime,
        stderr: this._stderrBuffer.slice(0, 1000),
      });

      if (this.retryCount >= this.maxRetries) {
        console.log(chalk.red(`\n🛑 Max retries (${this.maxRetries}) reached. Giving up.`));
        this._logRollbackHint();
        this.running = false;
        return;
      }

      this.retryCount++;
      // #3: Guard against unhandled rejections — don't let heal errors crash the parent
      try {
        await this._healAndRestart();
      } catch (healErr) {
        console.log(chalk.red(`  ⚠️  Heal error (recovering): ${healErr.message}`));
        this._healInProgress = false;
        this._healStatus = null;
        if (this.running) this._spawn(); // restart without healing
      }
    });

    this.child.on("error", (err) => {
      console.log(chalk.red(`Failed to start process: ${err.message}`));
      this.logger.error(EVENT_TYPES.PROCESS_CRASH, `Failed to start: ${err.message}`);
      // #10: Retry spawn after delay instead of permanently dying
      if (this.running && this.retryCount < this.maxRetries) {
        this.retryCount++;
        console.log(chalk.yellow(`   Retrying spawn in 5s (attempt ${this.retryCount}/${this.maxRetries})...`));
        setTimeout(() => { if (this.running) this._spawn(); }, 5000);
      } else {
        this.running = false;
      }
    });

    // IPC channel: child reports caught 500 errors (Fastify/Express)
    this.child.on("message", (msg) => {
      if (msg && msg.type === "route_error") {
        const { redact } = require("../security/secret-redactor");
        const safeMsg = redact(msg.message || "");
        const safeStack = redact(msg.stack || "");
        console.log(chalk.yellow(`  🔍 Caught error on ${msg.method} ${msg.path}: ${safeMsg.slice(0, 100)}`));
        this.logger.warn("error_monitor.caught", `${msg.method} ${msg.path} → 500: ${safeMsg.slice(0, 200)}`, {
          route: msg.path, method: msg.method, file: msg.file, line: msg.line,
        });
        this.errorMonitor.record(msg.path, msg.statusCode || 500, {
          message: safeMsg,
          stack: safeStack,
          file: msg.file,
          line: msg.line,
          path: msg.path,
          method: msg.method,
        });
      }
    });

    // Reset error monitor on new spawn
    this.errorMonitor.reset();
  }

  async _healAndRestart(options) {
    if (this._healInProgress && !options?.skipHealLockCheck) return;
    // #9: Bail if stop() was called during the window between crash and heal
    if (this._shuttingDown) return;
    this._healInProgress = true;
    this._healStatus = { active: true, error: this._stderrBuffer.slice(0, 200), phase: "diagnosing", startedAt: Date.now() };

    // Loop guard: check if we're stuck repeating failed heals
    const errorSig = RateLimiter.signature(this._stderrBuffer.slice(0, 200), "");
    const loopCheck = this.loopGuard.check(errorSig);
    if (!loopCheck.allowed) {
      console.log(chalk.red(`\n  🔄 ${loopCheck.reason}`));
      if (loopCheck.shouldReport) {
        const report = await this.loopGuard.generateBugReport({
          errorMessage: this._stderrBuffer.slice(0, 500),
          filePath: null,
          attempts: loopCheck.attempts,
          brain: this.brain,
          logger: this.logger,
        });
        await this.loopGuard.sendToBackend(report);
      }
      this._healInProgress = false;
      this._healStatus = null;
      // Just restart without healing — the bug report is filed
      this._spawn();
      return;
    }

    try {
      // #9: Check again before expensive heal — stop() may have been called during loop guard
      if (this._shuttingDown) { this._healInProgress = false; return; }
      const result = await heal({
        stderr: this._stderrBuffer,
        cwd: this.cwd,
        sandbox: this.sandbox,
        redactor: this.redactor,
        notifier: this.notifier,
        rateLimiter: this.rateLimiter,
        backupManager: this.backupManager,
        logger: this.logger,
        brain: this.brain,
        mcp: this.mcp,
        skills: this.skills,
        repairHistory: this.repairHistory,
      });

      // Record attempt for loop guard
      this.loopGuard.record(errorSig, result.healed, result.agentStats?.totalTokens || 0);

      if (result.healed) {
        this._lastBackupId = result.backupId;
        this.retryCount = 0;
        const mode = result.mode === "agent" ? "multi-file agent" : result.mode || "fast path";
        console.log(chalk.green(`\n🐺 Wolverine healed the error via ${mode}! Restarting...\n`));

        if (result.agentStats) {
          console.log(chalk.gray(`   Agent stats: ${result.agentStats.turns} turns, ${result.agentStats.tokens} tokens, ${result.agentStats.filesModified.length} files modified`));
        }

        // Broadcast heal success to dashboard SSE
        if (this.logger) {
          this.logger.info("heal.success", `Healed via ${mode}: ${result.explanation?.slice(0, 100)}`, {
            mode, file: result.agentStats?.filesModified?.[0], duration: Date.now() - (this._healStatus?.startedAt || Date.now()),
          });
        }

        this._healInProgress = false;
        this._healStatus = null;
        // Clear pending errors — the heal fixed the root cause, stale errors are irrelevant
        this._pendingErrorHeal = null;
        // #9: Don't restart if stop() was called while heal was running
        if (this._shuttingDown) return;
        // Use restart() to properly kill old child before spawning — prevents EADDRINUSE
        this.restart();
      } else {
        console.log(chalk.red(`\n🐺 Wolverine could not heal: ${result.explanation}`));

        if (result.waitMs) {
          const waitSec = Math.ceil(result.waitMs / 1000);
          console.log(chalk.yellow(`   Waiting ${waitSec}s before next attempt...`));
          setTimeout(() => {
            this._healInProgress = false;
            if (this.running && this.retryCount < this.maxRetries) {
              this._spawn();
            }
          }, result.waitMs);
          return;
        }

        this._healInProgress = false;
        if (this.retryCount < this.maxRetries) {
          console.log(chalk.yellow("   Retrying...\n"));
          this._spawn();
        } else {
          // Max retries — try rolling back to startup backup as last resort
          if (this._startupBackupId) {
            console.log(chalk.yellow(`\n  🔄 Max retries reached — rolling back to startup backup ${this._startupBackupId}...`));
            try {
              this.backupManager.rollbackTo(this._startupBackupId);
              console.log(chalk.green("  ✅ Rolled back to startup state. Restarting..."));
              this.retryCount = 0;
              this._startupBackupId = null; // don't rollback again if this also fails
              this._spawn();
              return;
            } catch (rbErr) {
              console.log(chalk.red(`  ❌ Rollback failed: ${rbErr.message}`));
            }
          }
          console.log(chalk.red("   Max retries reached."));
          this._logRollbackHint();
          this.running = false;
        }
      }
    } catch (err) {
      // #4: Don't permanently die on transient errors — restart without healing
      console.log(chalk.red(`\n🐺 Wolverine heal error (recovering): ${err.message}`));
      this._healInProgress = false;
      this._healStatus = null;
      if (this.running) {
        console.log(chalk.yellow("   Restarting without healing..."));
        this._spawn();
      }
    }
  }

  /**
   * Heal from a caught 500 error (ErrorMonitor threshold reached).
   * Unlike crash healing, the server is still running — we heal and restart.
   */
  async _healFromError(routePath, errorDetails) {
    if (this._shuttingDown) return;
    if (this._healInProgress) {
      // Queue the error — process after current heal finishes
      this._pendingErrorHeal = { routePath, errorDetails };
      console.log(chalk.yellow(`  🔄 Heal in progress — queued IPC error on ${routePath} for after current heal`));
      return;
    }
    this._healInProgress = true;

    // Safety timeout — must be strictly greater than heal()'s 5-min timeout to avoid concurrent heals
    const HEAL_TIMEOUT_MS = parseInt(process.env.WOLVERINE_HEAL_TIMEOUT_MS, 10) || 300000;
    const safetyMs = HEAL_TIMEOUT_MS + 30000; // heal timeout + 30s grace
    const healTimeout = setTimeout(() => {
      if (this._healInProgress) {
        console.log(chalk.red(`  ⚠️  _healFromError safety timeout (${Math.round(safetyMs / 60000)}min) — releasing heal lock`));
        this._healInProgress = false;
        this._healStatus = null;
      }
    }, safetyMs);

    console.log(chalk.yellow(`\n🐺 Wolverine healing caught error on ${routePath}...`));
    this._healStatus = { active: true, route: routePath, error: errorDetails?.message?.slice(0, 200), phase: "diagnosing", startedAt: Date.now() };
    this.logger.info("heal.error_monitor", `Healing caught 500 on ${routePath}`, { route: routePath });

    // Build synthetic stderr that matches the error parser's expected format
    // If IPC didn't include a file, try to resolve from the route path or stack
    let file = errorDetails.file;
    let line = errorDetails.line || 1;
    if (!file && errorDetails.stack) {
      // Try to find user-land file in stack (not node_modules, not node:)
      const frames = (errorDetails.stack || "").split("\n");
      for (const frame of frames) {
        const m = frame.match(/\(([^)]+):(\d+):(\d+)\)/) || frame.match(/at\s+([^\s(]+):(\d+):(\d+)/);
        if (m && !m[1].includes("node_modules") && !m[1].includes("node:")) {
          file = m[1]; line = parseInt(m[2], 10); break;
        }
      }
    }
    if (!file && routePath) {
      // Last resort: map route path to likely file (e.g., /breakable → server/routes/breakable.js)
      const routeName = routePath.split("/").filter(Boolean).pop();
      if (routeName) {
        const path = require("path");
        const guess = path.join(this.cwd, "server", "routes", routeName + ".js");
        if (require("fs").existsSync(guess)) { file = guess; line = 1; }
      }
    }

    const msg = errorDetails.message || "Unknown error";
    const hasErrorPrefix = /^\w*Error:/.test(msg);
    const stderr = [
      file ? `${file}:${line}` : "",
      hasErrorPrefix ? msg : `Error: ${msg}`,
      errorDetails.stack || "",
      file ? `    at ${file}:${line}:1` : "",
    ].filter(Boolean).join("\n");

    try {
      const result = await heal({
        stderr,
        cwd: this.cwd,
        sandbox: this.sandbox,
        redactor: this.redactor,
        notifier: this.notifier,
        rateLimiter: this.rateLimiter,
        backupManager: this.backupManager,
        logger: this.logger,
        brain: this.brain,
        mcp: this.mcp,
        skills: this.skills,
        repairHistory: this.repairHistory,
        routeContext: { path: routePath, method: errorDetails?.method },
      });

      clearTimeout(healTimeout);
      if (result.healed) {
        console.log(chalk.green(`\n🐺 Wolverine healed ${routePath} via ${result.mode}! Restarting...\n`));
        this.retryCount = 0; // Fresh start after successful heal
        this.errorMonitor.clearRoute(routePath);

        // Broadcast heal success to dashboard SSE
        if (this.logger) {
          this.logger.info("heal.success", `Healed ${routePath} via ${result.mode}: ${result.explanation?.slice(0, 100)}`, {
            mode: result.mode, route: routePath, duration: Date.now() - (this._healStatus?.startedAt || Date.now()),
          });
        }

        this._healInProgress = false;
        this._healStatus = null;
        this.restart();
      } else {
        console.log(chalk.red(`\n🐺 Could not heal ${routePath}: ${result.explanation}`));
        this._healInProgress = false;
        this._healStatus = null;
      }
    } catch (err) {
      clearTimeout(healTimeout);
      console.log(chalk.red(`\n🐺 Error during heal: ${err.message}`));
      this._healInProgress = false;
      this._healStatus = null;
    }
  }

  _processPendingErrorHeal() {
    if (this._pendingErrorHeal) {
      const { routePath, errorDetails } = this._pendingErrorHeal;
      this._pendingErrorHeal = null;
      console.log(chalk.yellow(`  🔄 Processing queued IPC error on ${routePath}`));
      // Small delay to let the new child process start
      setTimeout(() => this._healFromError(routePath, errorDetails), 2000);
    }
  }

  _startStabilityTimer() {
    this._clearStabilityTimer();
    // Capture backup ID in closure — prevents race where a new heal overwrites _lastBackupId
    // before this timer fires, causing the wrong backup to be promoted.
    const backupId = this._lastBackupId;
    this._stabilityTimer = setTimeout(() => {
      if (backupId && this.running) {
        this.backupManager.markStable(backupId);
        this.retryCount = 0;
        const healthStats = this.healthMonitor.getStats();
        if (healthStats.totalChecks > 0) {
          console.log(chalk.green(`  📊 Uptime: ${healthStats.uptimePercent}% (${healthStats.totalPasses}/${healthStats.totalChecks} checks passed)`));
        }
        this.logger.info(EVENT_TYPES.BACKUP_STABLE, `Backup ${backupId} promoted to stable`, { backupId });
      }
    }, STABILITY_THRESHOLD_MS);
  }

  _clearStabilityTimer() {
    if (this._stabilityTimer) {
      clearTimeout(this._stabilityTimer);
      this._stabilityTimer = null;
    }
  }

  /**
   * Kill a process and all its children (process tree kill).
   * Handles servers that fork workers internally — prevents orphaned processes.
   */
  _killProcessTree(pid, signal = "SIGTERM") {
    if (!pid) return;
    try {
      if (process.platform === "win32") {
        // taskkill /T kills the process tree
        execSync(`taskkill /PID ${pid} /T /F`, { timeout: 3000, stdio: "ignore" });
      } else {
        // Kill the process group (negative PID)
        try { process.kill(-pid, signal); } catch {}
        // Also kill individual PID in case it's not a group leader
        try { process.kill(pid, signal); } catch {}
        // Find and kill children via pgrep
        try {
          const children = execSync(`pgrep -P ${pid} 2>/dev/null`, { encoding: "utf-8", timeout: 3000 }).trim();
          if (children) {
            for (const cpid of children.split("\n").map(p => parseInt(p, 10)).filter(Boolean)) {
              try { process.kill(cpid, signal); } catch {}
            }
          }
        } catch { /* no children or pgrep not available */ }
      }
    } catch { /* process already dead */ }
  }

  _ensurePortFree() {
    const port = parseInt(process.env.PORT, 10) || 3000;
    try {
      if (process.platform === "win32") {
        const output = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: "utf-8", timeout: 3000 }).trim();
        if (output) {
          const lines = output.split("\n");
          const pids = new Set();
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[parts.length - 1], 10);
            if (pid && pid !== process.pid) pids.add(pid);
          }
          for (const pid of pids) {
            try {
              execSync(`taskkill /PID ${pid} /F`, { timeout: 3000 });
              console.log(chalk.gray(`  🔌 Killed stale process on port ${port} (PID ${pid})`));
            } catch { /* already dead */ }
          }
        }
      } else {
        const output = execSync(`lsof -ti:${port}`, { encoding: "utf-8", timeout: 3000 }).trim();
        if (output) {
          const pids = output.split("\n").map(p => parseInt(p, 10)).filter(p => p && p !== process.pid);
          for (const pid of pids) {
            try { process.kill(pid, "SIGKILL"); console.log(chalk.gray(`  🔌 Killed stale process on port ${port} (PID ${pid})`)); }
            catch { /* already dead */ }
          }
        }
      }
    } catch { /* no process on port */ }
  }

  _logRollbackHint() {
    const stats = this.backupManager.getStats();
    if (stats.total > 0) {
      console.log(chalk.yellow(`   Backups available: ${stats.total}. Rollback with:`));
      console.log(chalk.gray(`   node -e "const {BackupManager}=require('./src/backup/backup-manager');new BackupManager('.').rollbackLatest()"`));
    }
  }
}

module.exports = { WolverineRunner };
