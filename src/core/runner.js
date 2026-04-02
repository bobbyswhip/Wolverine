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

    // Core subsystems
    this.sandbox = new Sandbox(this.cwd);
    this.redactor = initRedactor(this.cwd);
    this.rateLimiter = new RateLimiter({
      maxCallsPerWindow: parseInt(process.env.WOLVERINE_RATE_MAX_CALLS, 10) || 10,
      windowMs: parseInt(process.env.WOLVERINE_RATE_WINDOW_MS, 10) || 600000,
      minGapMs: parseInt(process.env.WOLVERINE_RATE_MIN_GAP_MS, 10) || 5000,
      maxTokensPerHour: parseInt(process.env.WOLVERINE_RATE_MAX_TOKENS_HOUR, 10) || 100000,
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
    const port = parseInt(process.env.PORT, 10) || 3000;
    this.healthMonitor = new HealthMonitor({
      port,
      path: options.healthPath || "/health",
      intervalMs: parseInt(process.env.WOLVERINE_HEALTH_INTERVAL_MS, 10) || 15000,
      timeoutMs: parseInt(process.env.WOLVERINE_HEALTH_TIMEOUT_MS, 10) || 5000,
      failThreshold: parseInt(process.env.WOLVERINE_HEALTH_FAIL_THRESHOLD, 10) || 3,
      startDelayMs: parseInt(process.env.WOLVERINE_HEALTH_START_DELAY_MS, 10) || 10000,
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

    // Route prober — tests all routes periodically
    this.routeProber = new RouteProber({
      port,
      logger: this.logger,
      brain: this.brain,
    });

    // Brain — semantic memory + project context
    this.brain = new Brain(this.cwd);

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
    });

    // Stability tracking
    this._lastStartTime = null;
    this._lastBackupId = null;
    this._stabilityTimer = null;
    this._stderrBuffer = "";
    this._healInProgress = false;
  }

  async start() {
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

    this._spawn();
  }

  restart() {
    console.log(chalk.blue("\n  🔄 Restarting server..."));
    this.healthMonitor.stop();
    this._clearStabilityTimer();

    if (this.child) {
      const oldChild = this.child;
      this.child = null;

      // Wait for old process to actually exit before spawning new one
      const onExit = () => {
        // Give port time to fully release (TIME_WAIT)
        setTimeout(() => {
          this._ensurePortFree();
          setTimeout(() => this._spawn(), 200);
        }, 300);
      };

      oldChild.removeAllListeners("exit");
      oldChild.once("exit", onExit);
      oldChild.kill("SIGTERM");

      // Force kill if it doesn't exit in 3s
      setTimeout(() => {
        try { oldChild.kill("SIGKILL"); } catch {}
        onExit();
      }, 3000);
    } else {
      this._ensurePortFree();
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
    this.mcp.shutdown();
    this.tokenTracker.save();
    this.dashboard.stop();

    this.logger.info(EVENT_TYPES.PROCESS_STOP, "Wolverine stopped (graceful shutdown)");

    // Kill child — remove exit listener first so it doesn't trigger heal
    if (this.child) {
      this.child.removeAllListeners("exit");
      this.child.kill("SIGTERM");
      // Force kill after 3s if it doesn't respond
      setTimeout(() => {
        try { if (this.child) this.child.kill("SIGKILL"); } catch {}
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

    this.child = spawn("node", [this.scriptPath], {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ["inherit", "inherit", "pipe"],
    });

    this.child.stderr.on("data", (data) => {
      const text = data.toString();
      this._stderrBuffer += text;
      process.stderr.write(text);
    });

    this._startStabilityTimer();

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
    this.healthMonitor.start((reason) => {
      if (this._healInProgress) return;
      console.log(chalk.red(`\n🚨 Health check triggered restart (reason: ${reason})`));
      this.logger.error(EVENT_TYPES.HEALTH_UNRESPONSIVE, `Server unresponsive: ${reason}`, { reason });
      if (this.child) {
        this.child.kill("SIGKILL");
      }
    });

    this.child.on("exit", async (code, signal) => {
      this._clearStabilityTimer();
      this.healthMonitor.stop();

      if (!this.running) return;

      if (code === 0 || signal === "SIGTERM") {
        console.log(chalk.green("\n✅ Process exited cleanly."));
        this.logger.info(EVENT_TYPES.PROCESS_HEALTHY, "Process exited cleanly");
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
      await this._healAndRestart();
    });

    this.child.on("error", (err) => {
      console.log(chalk.red(`Failed to start process: ${err.message}`));
      this.logger.error(EVENT_TYPES.PROCESS_CRASH, `Failed to start: ${err.message}`);
      this.running = false;
    });
  }

  async _healAndRestart() {
    if (this._healInProgress) return;
    this._healInProgress = true;

    try {
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

      if (result.healed) {
        this._lastBackupId = result.backupId;
        const mode = result.mode === "agent" ? "multi-file agent" : "fast path";
        console.log(chalk.green(`\n🐺 Wolverine healed the error via ${mode}! Restarting...\n`));

        if (result.agentStats) {
          console.log(chalk.gray(`   Agent stats: ${result.agentStats.turns} turns, ${result.agentStats.tokens} tokens, ${result.agentStats.filesModified.length} files modified`));
        }

        this._healInProgress = false;
        this._spawn();
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
          console.log(chalk.red("   Max retries reached."));
          this._logRollbackHint();
          this.running = false;
        }
      }
    } catch (err) {
      console.log(chalk.red(`\n🐺 Wolverine encountered an error: ${err.message}`));
      this._healInProgress = false;
      this.running = false;
    }
  }

  _startStabilityTimer() {
    this._clearStabilityTimer();
    this._stabilityTimer = setTimeout(() => {
      if (this._lastBackupId && this.running) {
        this.backupManager.markStable(this._lastBackupId);
        this.retryCount = 0;
        const healthStats = this.healthMonitor.getStats();
        if (healthStats.totalChecks > 0) {
          console.log(chalk.green(`  📊 Uptime: ${healthStats.uptimePercent}% (${healthStats.totalPasses}/${healthStats.totalChecks} checks passed)`));
        }
        this.logger.info(EVENT_TYPES.BACKUP_STABLE, `Backup ${this._lastBackupId} promoted to stable`, { backupId: this._lastBackupId });
      }
    }, STABILITY_THRESHOLD_MS);
  }

  _clearStabilityTimer() {
    if (this._stabilityTimer) {
      clearTimeout(this._stabilityTimer);
      this._stabilityTimer = null;
    }
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
