const cluster = require("cluster");
const path = require("path");
const chalk = require("chalk");
const { detect, logSystemInfo } = require("./system-info");

/**
 * Cluster Manager — auto-scaling worker management.
 *
 * Detects machine capabilities and forks the optimal number of workers.
 * Each worker runs a wolverine instance managing the server process.
 * The master manages workers, restarts crashed ones, and balances load.
 *
 * Modes:
 * - single:  1 worker (small machines, dev, containers)
 * - auto:    detect cores → fork optimal workers
 * - fixed:   user specifies exact worker count
 *
 * Load balancing uses Node's built-in round-robin (default on Linux)
 * or OS-level distribution (Windows).
 */

class ClusterManager {
  constructor(options = {}) {
    this.scriptPath = options.scriptPath;
    this.mode = options.mode || "auto";       // single, auto, fixed
    this.fixedWorkers = options.workers || 0;
    this.logger = options.logger;

    this._systemInfo = null;
    this._workerCount = 0;
    this._workers = new Map();  // pid → { id, startTime, restarts }
    this._shuttingDown = false;
  }

  /**
   * Initialize — detect system, decide worker count, fork if needed.
   * Returns true if this process is the master, false if it's a worker.
   */
  init() {
    this._systemInfo = detect();

    if (this.mode === "single" || !cluster.isPrimary) {
      return { isMaster: cluster.isPrimary, workers: 1, systemInfo: this._systemInfo };
    }

    // Determine worker count
    if (this.mode === "fixed" && this.fixedWorkers > 0) {
      this._workerCount = this.fixedWorkers;
    } else {
      this._workerCount = this._systemInfo.recommended.workers;
    }

    // Single core / small machine — don't cluster
    if (this._workerCount <= 1) {
      return { isMaster: true, workers: 1, systemInfo: this._systemInfo, clustered: false };
    }

    console.log(chalk.blue.bold("\n  🔄 Cluster Mode"));
    logSystemInfo(this._systemInfo);
    console.log(chalk.blue(`  🔄 Forking ${this._workerCount} workers...\n`));

    // Fork workers
    for (let i = 0; i < this._workerCount; i++) {
      this._forkWorker();
    }

    // Handle worker exits
    cluster.on("exit", (worker, code, signal) => {
      if (this._shuttingDown) return;

      const info = this._workers.get(worker.process.pid);
      const restarts = info ? info.restarts : 0;

      console.log(chalk.yellow(`  🔄 Worker ${worker.process.pid} died (code: ${code}, signal: ${signal})`));

      if (this.logger) {
        this.logger.warn("cluster.worker_died", `Worker ${worker.process.pid} died`, {
          pid: worker.process.pid, code, signal, restarts,
        });
      }

      this._workers.delete(worker.process.pid);

      // Respawn with backoff if crashing repeatedly
      if (restarts < 5) {
        const delay = Math.min(1000 * Math.pow(2, restarts), 30000);
        console.log(chalk.gray(`  🔄 Respawning in ${delay / 1000}s (restart #${restarts + 1})`));
        setTimeout(() => this._forkWorker(restarts + 1), delay);
      } else {
        console.log(chalk.red(`  🔄 Worker exceeded max restarts (5) — not respawning`));
      }
    });

    // Graceful shutdown
    const shutdown = () => {
      this._shuttingDown = true;
      console.log(chalk.yellow("\n  🔄 Shutting down cluster..."));
      for (const [pid] of this._workers) {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
      setTimeout(() => process.exit(0), 5000);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    return { isMaster: true, workers: this._workerCount, systemInfo: this._systemInfo, clustered: true };
  }

  /**
   * Get cluster status for dashboard.
   */
  getStatus() {
    return {
      clustered: this._workerCount > 1,
      mode: this.mode,
      totalWorkers: this._workerCount,
      activeWorkers: this._workers.size,
      workers: Array.from(this._workers.entries()).map(([pid, info]) => ({
        pid,
        id: info.id,
        uptime: Math.round((Date.now() - info.startTime) / 1000),
        restarts: info.restarts,
      })),
      system: this._systemInfo,
    };
  }

  _forkWorker(restarts = 0) {
    const worker = cluster.fork({
      WOLVERINE_WORKER_ID: this._workers.size + 1,
    });

    this._workers.set(worker.process.pid, {
      id: this._workers.size + 1,
      startTime: Date.now(),
      restarts,
    });

    console.log(chalk.green(`  🔄 Worker ${worker.process.pid} started`));
  }
}

module.exports = { ClusterManager };
