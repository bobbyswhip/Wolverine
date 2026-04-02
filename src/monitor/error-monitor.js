const chalk = require("chalk");

/**
 * Error Monitor — detects caught 500 errors that don't crash the process.
 *
 * Most production bugs are caught by Fastify/Express error handlers.
 * The server stays alive but routes return 500. Wolverine's crash-based
 * heal pipeline never triggers. This module bridges that gap.
 *
 * Tracks 5xx errors per route. After N consecutive failures within
 * a time window, triggers the heal pipeline — without killing the server.
 *
 * Error flow: server error handler → IPC message → ErrorMonitor.record()
 *   → threshold reached → onError callback → heal()
 */

class ErrorMonitor {
  constructor({ threshold = 3, windowMs = 30000, cooldownMs = 60000, onError, logger } = {}) {
    this.threshold = threshold;     // consecutive 5xx before triggering heal
    this.windowMs = windowMs;       // time window for counting errors
    this.cooldownMs = cooldownMs;   // cooldown after triggering (prevent heal spam)
    this.onError = onError;         // callback: (routePath, errorDetails) => heal()
    this.logger = logger;
    this.routes = new Map();        // path → { count, firstSeen, lastError }
    this._cooldowns = new Map();    // path → timestamp of last heal trigger
    this._totalErrors = 0;
    this._totalHeals = 0;
  }

  /**
   * Record a route response. Call on every response from the child.
   * @param {string} routePath — e.g. "/api/users"
   * @param {number} statusCode — HTTP status
   * @param {object} errorDetails — { message, stack, file, line }
   */
  record(routePath, statusCode, errorDetails) {
    if (statusCode < 500) {
      // Success — reset the error counter for this route
      if (this.routes.has(routePath)) {
        this.routes.delete(routePath);
      }
      return;
    }

    this._totalErrors++;

    // Check cooldown — don't trigger heal for same route too quickly
    const lastHeal = this._cooldowns.get(routePath);
    if (lastHeal && Date.now() - lastHeal < this.cooldownMs) {
      return;
    }

    const entry = this.routes.get(routePath) || { count: 0, firstSeen: Date.now(), lastError: null };
    entry.count++;
    entry.lastError = errorDetails;

    // Reset if outside time window
    if (Date.now() - entry.firstSeen > this.windowMs) {
      entry.count = 1;
      entry.firstSeen = Date.now();
    }

    this.routes.set(routePath, entry);

    if (entry.count >= this.threshold) {
      this._totalHeals++;
      console.log(chalk.yellow(`\n🔍 ErrorMonitor: ${routePath} failed ${entry.count}x in ${Math.round((Date.now() - entry.firstSeen) / 1000)}s — triggering heal`));

      if (this.logger) {
        this.logger.warn("error_monitor.threshold", `Route ${routePath} hit ${this.threshold} consecutive 500s`, {
          route: routePath,
          count: entry.count,
          error: errorDetails?.message?.slice(0, 200),
        });
      }

      // Set cooldown and reset counter
      this._cooldowns.set(routePath, Date.now());
      this.routes.delete(routePath);

      // Trigger the heal callback
      if (this.onError) {
        this.onError(routePath, errorDetails);
      }
    }
  }

  /**
   * Clear a route's error state (e.g., after a successful heal).
   */
  clearRoute(routePath) {
    this.routes.delete(routePath);
    this._cooldowns.delete(routePath);
  }

  /**
   * Get stats for dashboard/telemetry.
   */
  getStats() {
    const activeRoutes = {};
    for (const [path, entry] of this.routes) {
      activeRoutes[path] = { count: entry.count, lastError: entry.lastError?.message?.slice(0, 100) };
    }
    return {
      totalErrors: this._totalErrors,
      totalHeals: this._totalHeals,
      activeRoutes,
      trackedRoutes: this.routes.size,
    };
  }

  /**
   * Reset all state (e.g., after server restart).
   */
  reset() {
    this.routes.clear();
    // Keep cooldowns — don't re-trigger immediately after restart
  }
}

module.exports = { ErrorMonitor };
