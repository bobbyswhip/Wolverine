/**
 * Wolverine Claw Runner — Process manager for OpenClaw gateway.
 *
 * Extends wolverine's self-healing to the claw environment:
 * - Spawns wolverine-claw/index.js as a child process
 * - Monitors for crashes and gateway errors via IPC
 * - Triggers AI-powered healing on failures
 * - Manages workspace backups and rollbacks
 * - Health monitoring via WebSocket probe (not HTTP)
 *
 * This is the claw equivalent of src/core/runner.js.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const chalk = require("chalk");
const { heal } = require("../core/wolverine");
const { BackupManager } = require("../backup/backup-manager");
const { EventLogger, EVENT_TYPES } = require("../logger/event-logger");
const { Brain } = require("../brain/brain");
const { initRedactor } = require("../security/secret-redactor");
const { RateLimiter } = require("../security/rate-limiter");
const { TokenTracker } = require("../logger/token-tracker");
const { setTokenTracker } = require("../core/ai-client");
const { LoopGuard, ensureSingleProcess } = require("../skills/loop-guard");
const { loadConfig } = require("../core/config");

class ClawRunner {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.clawDir = path.join(this.cwd, "wolverine-claw");
    this.scriptPath = path.join(this.clawDir, "index.js");
    this.child = null;
    this.running = false;
    this.retryCount = 0;
    this.maxRetries = options.maxRetries || 5;

    // Healing state
    this._healInProgress = false;
    this._stderrBuffer = "";
    this._lastStartTime = null;
    this._lastBackupId = null;

    // Load claw-specific config
    this.clawConfig = this._loadClawConfig();

    // Load wolverine core config for shared settings
    this.config = loadConfig();

    this._initSubsystems();
  }

  /**
   * Load claw configuration from wolverine-claw/config/settings.json.
   */
  _loadClawConfig() {
    const configPath = path.join(this.clawDir, "config", "settings.json");
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (err) {
      console.error(chalk.red(`[CLAW] Config not found at ${configPath}`));
      return {};
    }
  }

  /**
   * Initialize subsystems — backup, brain, logging, rate limiting.
   */
  _initSubsystems() {
    this.redactor = initRedactor(this.cwd);
    this.backupManager = new BackupManager(this.cwd);
    this.logger = new EventLogger(this.cwd);
    this.logger.setRedactor(this.redactor);
    this.tokenTracker = new TokenTracker(this.cwd);
    setTokenTracker(this.tokenTracker);
    this.brain = new Brain(this.cwd);

    const healCfg = this.clawConfig.healing || {};
    this.rateLimiter = new RateLimiter({
      maxCallsPerWindow: this.config.rateLimiting?.maxCallsPerWindow || 32,
      windowMs: this.config.rateLimiting?.windowMs || 100000,
      minGapMs: this.config.rateLimiting?.minGapMs || 5000,
      maxTokensPerHour: this.config.rateLimiting?.maxTokensPerHour || 1000000,
      maxGlobalHealsPerWindow: healCfg.maxHealsPerWindow || 5,
      globalWindowMs: healCfg.windowMs || 300000,
    });

    this.loopGuard = new LoopGuard(this.cwd, {
      maxAttempts: healCfg.loopMaxAttempts || 3,
      windowMs: healCfg.loopWindowMs || 600000,
    });
  }

  /**
   * Start the claw process.
   */
  async start() {
    // Validate claw directory exists
    if (!fs.existsSync(this.scriptPath)) {
      console.error(chalk.red(`\n  [CLAW] Entry point not found: ${this.scriptPath}`));
      console.log(chalk.gray("  Run wolverine --init-claw to scaffold the wolverine-claw directory.\n"));
      process.exit(1);
    }

    this.running = true;
    this.retryCount = 0;

    console.log(chalk.blue.bold("\n  🐾 Wolverine Claw — Agentic Agent with Self-Healing\n"));

    // Initialize brain
    try {
      await this.brain.init();
      console.log(chalk.gray("  🧠 Brain: initialized"));
    } catch (err) {
      console.log(chalk.yellow(`  ⚠️  Brain init: ${err.message}`));
    }

    // Log config
    const gw = this.clawConfig.gateway || {};
    console.log(chalk.gray(`  Gateway:    ws://${gw.host || "127.0.0.1"}:${gw.port || 18789}`));
    console.log(chalk.gray(`  Agent:      ${this.clawConfig.agent?.model || "claude-sonnet-4-6"}`));
    console.log(chalk.gray(`  Workspace:  ${path.resolve(this.clawConfig.workspace?.path || "wolverine-claw/workspace")}`));
    console.log(chalk.gray(`  Healing:    ${this.clawConfig.healing?.enabled !== false ? "enabled" : "disabled"}`));
    console.log(chalk.gray(`  Max heals:  ${this.clawConfig.healing?.maxHealsPerWindow || 5} per ${Math.round((this.clawConfig.healing?.windowMs || 300000) / 60000)}min`));

    // Enabled channels
    const channels = this.clawConfig.channels || {};
    const enabledChannels = Object.entries(channels)
      .filter(([k, v]) => !k.startsWith("_") && v.enabled)
      .map(([k]) => k);
    console.log(chalk.gray(`  Channels:   ${enabledChannels.length > 0 ? enabledChannels.join(", ") : "terminal only"}`));
    console.log("");

    // Create startup backup
    try {
      this._lastBackupId = this.backupManager.createBackup("claw-pre-start");
      console.log(chalk.gray(`  📸 Startup backup: ${this._lastBackupId}`));
    } catch (err) {
      console.log(chalk.yellow(`  ⚠️  Backup failed: ${err.message}`));
    }

    console.log("");
    this._spawn();
  }

  /**
   * Spawn the claw child process.
   */
  _spawn() {
    if (!this.running) return;

    this._lastStartTime = Date.now();
    this._stderrBuffer = "";

    // Spawn wolverine-claw/index.js with IPC channel
    const errorHookPath = path.join(this.cwd, "src", "core", "error-hook.js");
    this.child = spawn(process.execPath, [this.scriptPath], {
      cwd: this.cwd,
      stdio: ["inherit", "inherit", "pipe", "ipc"],
      env: {
        ...process.env,
        WOLVERINE_MANAGED: "1",
        WOLVERINE_CLAW: "1",
        NODE_ENV: process.env.NODE_ENV || "development",
      },
    });

    console.log(chalk.green(`  🐾 Claw started (PID ${this.child.pid})`));

    // Collect stderr
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      this._stderrBuffer += text;
      process.stderr.write(chunk);

      // Cap buffer size
      if (this._stderrBuffer.length > 10000) {
        this._stderrBuffer = this._stderrBuffer.slice(-8000);
      }
    });

    // IPC messages from claw process
    this.child.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "route_error") {
        this._handleError(msg);
      } else if (msg.type === "claw_health") {
        this._handleHealthReport(msg);
      } else if (msg.type === "claw_heartbeat") {
        // Healthy heartbeat — reset retry count if stable
        if (Date.now() - this._lastStartTime > 60000) {
          this.retryCount = 0;
        }
      }
    });

    // Process exit
    this.child.on("exit", (code, signal) => {
      this.child = null;

      if (!this.running) {
        console.log(chalk.gray("\n  🐾 Claw stopped."));
        return;
      }

      console.log(chalk.red(`\n  💥 Claw crashed (code=${code}, signal=${signal})`));

      this.logger.info("claw.crash", `Claw process exited`, {
        code, signal,
        uptime: Date.now() - this._lastStartTime,
        retryCount: this.retryCount,
      });

      this._handleCrash(code, signal);
    });

    // Start gateway health probe
    this._startGatewayProbe();
  }

  /**
   * Handle a crash — heal and restart.
   */
  async _handleCrash(code, signal) {
    this.retryCount++;

    if (this.retryCount > this.maxRetries) {
      console.log(chalk.red(`\n  ❌ Max retries (${this.maxRetries}) reached. Stopping.`));

      // Rollback to startup backup if available
      if (this._lastBackupId) {
        try {
          this.backupManager.rollback(this._lastBackupId);
          console.log(chalk.yellow(`  ↩️  Rolled back to startup snapshot: ${this._lastBackupId}`));
        } catch {}
      }
      return;
    }

    console.log(chalk.yellow(`  🔄 Retry ${this.retryCount}/${this.maxRetries}...`));

    // If healing is enabled and we have an error, try to heal
    const healingEnabled = this.clawConfig.healing?.enabled !== false;
    if (healingEnabled && this._stderrBuffer.trim()) {
      await this._tryHeal(this._stderrBuffer, null);
    }

    // Restart with delay
    const delay = Math.min(1000 * this.retryCount, 5000);
    setTimeout(() => this._spawn(), delay);
  }

  /**
   * Handle an IPC error from the claw process.
   */
  async _handleError(errorMsg) {
    console.log(chalk.red(`  ⚡ Claw error: ${errorMsg.message?.slice(0, 100)}`));

    const healingEnabled = this.clawConfig.healing?.enabled !== false;
    if (!healingEnabled) return;

    const errorText = `${errorMsg.message}\n${errorMsg.stack || ""}`;
    await this._tryHeal(errorText, errorMsg.file);
  }

  /**
   * Try to heal an error using wolverine's AI pipeline.
   */
  async _tryHeal(errorText, file) {
    if (this._healInProgress) {
      console.log(chalk.gray("  ⏳ Heal already in progress, skipping..."));
      return;
    }

    // Empty stderr → just restart, no AI
    if (!errorText.trim()) return;

    // Rate limit check
    if (!this.rateLimiter.canHeal()) {
      console.log(chalk.yellow("  ⚠️  Heal rate limit reached"));
      return;
    }

    // Loop guard check
    const errorSig = errorText.slice(0, 200);
    if (this.loopGuard.isLooping(errorSig)) {
      console.log(chalk.red("  🔁 Loop detected — same error failed too many times. Stopping."));
      this.loopGuard.generateBugReport(errorSig, errorText);
      return;
    }

    this._healInProgress = true;

    try {
      console.log(chalk.blue("\n  🩺 Healing claw..."));

      // Create backup before healing
      try {
        this._lastBackupId = this.backupManager.createBackup("claw-pre-heal");
      } catch {}

      // Run wolverine heal pipeline
      const healTimeoutMs = this.clawConfig.healing?.healTimeoutMs || 300000;
      const result = await Promise.race([
        heal({
          stderr: errorText,
          scriptPath: this.scriptPath,
          cwd: this.cwd,
          brain: this.brain,
          rateLimiter: this.rateLimiter,
          backupManager: this.backupManager,
          logger: this.logger,
          sandbox: { isAllowed: (p) => !p.includes("node_modules") && !p.includes("src/") },
          redactor: this.redactor,
          loopGuard: this.loopGuard,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Heal timeout")), healTimeoutMs)
        ),
      ]);

      if (result?.success) {
        console.log(chalk.green("  ✅ Heal succeeded!"));
        this.retryCount = 0;
      } else {
        console.log(chalk.yellow(`  ⚠️  Heal did not succeed: ${result?.reason || "unknown"}`));

        // Rollback
        if (this._lastBackupId) {
          try {
            this.backupManager.rollback(this._lastBackupId);
            console.log(chalk.yellow(`  ↩️  Rolled back`));
          } catch {}
        }
      }
    } catch (err) {
      console.log(chalk.red(`  ❌ Heal failed: ${err.message}`));
    } finally {
      this._healInProgress = false;
    }
  }

  /**
   * Handle health status reports from the claw process.
   */
  _handleHealthReport(msg) {
    if (msg.status === "error" || msg.status === "crashed") {
      console.log(chalk.yellow(`  ⚠️  Claw health: ${msg.status} — ${msg.detail || "unknown"}`));
    }
  }

  /**
   * Probe the gateway WebSocket port to check if it's alive.
   */
  _startGatewayProbe() {
    const port = this.clawConfig.gateway?.port || 18789;
    const host = this.clawConfig.gateway?.host || "127.0.0.1";
    const probeInterval = 30000; // every 30s

    // Wait 10s for gateway to start before probing
    this._gatewayProbeTimer = setTimeout(() => {
      this._gatewayProbeTimer = setInterval(() => {
        if (!this.running || !this.child) return;

        const socket = new net.Socket();
        socket.setTimeout(5000);

        socket.on("connect", () => {
          socket.destroy();
          // Gateway is alive
        });

        socket.on("error", () => {
          socket.destroy();
          console.log(chalk.yellow(`  ⚠️  Gateway probe failed (port ${port})`));
        });

        socket.on("timeout", () => {
          socket.destroy();
          console.log(chalk.yellow(`  ⚠️  Gateway probe timeout (port ${port})`));
        });

        socket.connect(port, host);
      }, probeInterval);
    }, 10000);
  }

  /**
   * Stop the claw process and all monitors.
   */
  stop() {
    this.running = false;

    if (this._gatewayProbeTimer) {
      clearTimeout(this._gatewayProbeTimer);
      clearInterval(this._gatewayProbeTimer);
    }

    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {}
    }
  }

  /**
   * Restart the claw process.
   */
  restart() {
    this.stop();
    setTimeout(() => {
      this.running = true;
      this.retryCount = 0;
      this._spawn();
    }, 2000);
  }
}

module.exports = { ClawRunner };
