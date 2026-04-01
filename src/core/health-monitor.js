const http = require("http");
const chalk = require("chalk");

/**
 * Health Monitor — periodically pings the server to detect hangs, freezes,
 * and unresponsive states that don't produce a crash/exit.
 *
 * Works like PM2's health check: if the server stops responding,
 * wolverine treats it as a crash and triggers the heal cycle.
 */
class HealthMonitor {
  constructor(options = {}) {
    this.port = options.port || parseInt(process.env.PORT, 10) || 3000;
    this.path = options.path || "/health";
    this.intervalMs = options.intervalMs || 15000;       // check every 15s
    this.timeoutMs = options.timeoutMs || 5000;          // 5s timeout per check
    this.failThreshold = options.failThreshold || 3;     // 3 consecutive fails = dead
    this.startDelayMs = options.startDelayMs || 10000;   // wait 10s before first check

    this._timer = null;
    this._consecutiveFailures = 0;
    this._onUnhealthy = null;
    this._running = false;
    this._totalChecks = 0;
    this._totalPasses = 0;
  }

  /**
   * Start monitoring. Calls onUnhealthy callback when the server is deemed dead.
   */
  start(onUnhealthy) {
    this._onUnhealthy = onUnhealthy;
    this._consecutiveFailures = 0;
    this._running = true;

    // Delay first check to let the server boot
    this._timer = setTimeout(() => {
      if (!this._running) return;
      this._check();
      this._timer = setInterval(() => this._check(), this.intervalMs);
    }, this.startDelayMs);
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  reset() {
    this._consecutiveFailures = 0;
  }

  getStats() {
    return {
      totalChecks: this._totalChecks,
      totalPasses: this._totalPasses,
      consecutiveFailures: this._consecutiveFailures,
      uptimePercent: this._totalChecks > 0
        ? Math.round((this._totalPasses / this._totalChecks) * 100)
        : 100,
    };
  }

  _check() {
    if (!this._running) return;
    this._totalChecks++;

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: this.port,
        path: this.path,
        method: "GET",
        timeout: this.timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 400) {
            this._onPass();
          } else {
            this._onFail(`HTTP ${res.statusCode}`);
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      this._onFail("timeout");
    });

    req.on("error", (err) => {
      // ECONNREFUSED means the server isn't listening — this is expected
      // right after a crash/restart, so only count it if we've been checking a while
      this._onFail(err.code || err.message);
    });

    req.end();
  }

  _onPass() {
    if (this._consecutiveFailures > 0) {
      console.log(chalk.green(`  💓 Health check passed (recovered after ${this._consecutiveFailures} failures)`));
    }
    this._consecutiveFailures = 0;
    this._totalPasses++;
  }

  _onFail(reason) {
    this._consecutiveFailures++;
    console.log(chalk.yellow(`  💔 Health check failed (${this._consecutiveFailures}/${this.failThreshold}): ${reason}`));

    if (this._consecutiveFailures >= this.failThreshold) {
      console.log(chalk.red(`\n🚨 Server unresponsive after ${this.failThreshold} consecutive health check failures.`));
      this._consecutiveFailures = 0; // reset to avoid re-triggering immediately
      if (this._onUnhealthy) {
        this._onUnhealthy(reason);
      }
    }
  }
}

module.exports = { HealthMonitor };
