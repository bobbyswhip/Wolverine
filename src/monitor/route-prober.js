const http = require("http");
const chalk = require("chalk");

/**
 * Route Prober — discovers and tests ALL server routes periodically.
 *
 * Instead of only checking /health, probes every route discovered
 * in the function map. Tracks response times per endpoint over time.
 *
 * Adapts automatically: when the function map updates (new routes added),
 * the prober picks them up on the next cycle.
 */

class RouteProber {
  constructor(options = {}) {
    this.port = options.port || parseInt(process.env.PORT, 10) || 3000;
    this.logger = options.logger;
    this.brain = options.brain;
    this.intervalMs = options.intervalMs || 30000; // probe every 30s

    // Per-route analytics
    this._routeMetrics = {}; // path → { samples[], avg, min, max, errors, lastStatus }
    this._timer = null;
    this._running = false;
  }

  start() {
    this._running = true;
    // First probe after a delay to let server boot
    setTimeout(() => {
      this._probe();
      this._timer = setInterval(() => this._probe(), this.intervalMs);
    }, 15000);
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Get analytics for all probed routes.
   */
  getMetrics() {
    const result = {};
    for (const [path, m] of Object.entries(this._routeMetrics)) {
      const samples = m.samples;
      const avg = samples.length > 0 ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : 0;
      result[path] = {
        avgMs: avg,
        minMs: m.min,
        maxMs: m.max,
        samples: samples.length,
        errors: m.errors,
        lastStatus: m.lastStatus,
        lastProbe: m.lastProbe,
        healthy: m.lastStatus >= 200 && m.lastStatus < 400,
        // Response time trend (last 5 vs overall)
        trend: this._calcTrend(samples),
      };
    }
    return result;
  }

  /**
   * Get a summary suitable for the dashboard.
   */
  getSummary() {
    const metrics = this.getMetrics();
    const routes = Object.keys(metrics);
    const healthy = routes.filter(r => metrics[r].healthy).length;
    const unhealthy = routes.filter(r => !metrics[r].healthy).length;
    const slowest = routes.sort((a, b) => (metrics[b].avgMs || 0) - (metrics[a].avgMs || 0))[0];

    return {
      totalRoutes: routes.length,
      healthy,
      unhealthy,
      slowest: slowest ? { path: slowest, avgMs: metrics[slowest].avgMs } : null,
    };
  }

  async _probe() {
    if (!this._running) return;

    // Get current routes from brain's function map
    let routes = [];
    if (this.brain && this.brain.functionMap) {
      routes = (this.brain.functionMap.routes || [])
        .filter(r => r.method === "GET" || r.method === "*")
        .map(r => r.path);
    }

    // Always include root and health
    if (!routes.includes("/")) routes.unshift("/");
    if (!routes.includes("/health")) routes.push("/health");

    // Deduplicate
    routes = [...new Set(routes)];

    for (const routePath of routes) {
      await this._probeRoute(routePath);
    }
  }

  _probeRoute(routePath) {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const req = http.get({
        hostname: "127.0.0.1",
        port: this.port,
        path: routePath,
        timeout: 5000,
      }, (res) => {
        const responseTime = Date.now() - startTime;
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          this._record(routePath, responseTime, res.statusCode);
          resolve();
        });
      });

      req.on("timeout", () => {
        req.destroy();
        const responseTime = Date.now() - startTime;
        this._record(routePath, responseTime, 0);
        resolve();
      });

      req.on("error", () => {
        const responseTime = Date.now() - startTime;
        this._record(routePath, responseTime, 0);
        resolve();
      });
    });
  }

  _record(routePath, responseTime, statusCode) {
    if (!this._routeMetrics[routePath]) {
      this._routeMetrics[routePath] = {
        samples: [],
        min: Infinity,
        max: 0,
        errors: 0,
        lastStatus: 0,
        lastProbe: 0,
      };
    }

    const m = this._routeMetrics[routePath];
    m.samples.push(responseTime);
    if (m.samples.length > 60) m.samples.shift(); // keep last 60 samples
    m.min = Math.min(m.min, responseTime);
    m.max = Math.max(m.max, responseTime);
    m.lastStatus = statusCode;
    m.lastProbe = Date.now();

    if (statusCode === 0 || statusCode >= 500) {
      m.errors++;
    }

    // Log slow routes
    if (responseTime > 2000) {
      console.log(chalk.yellow(`  ⚡ Slow route: ${routePath} took ${responseTime}ms`));
      if (this.logger) {
        this.logger.warn("perf.slow_route", `${routePath}: ${responseTime}ms`, { path: routePath, ms: responseTime, status: statusCode });
      }
    }
  }

  _calcTrend(samples) {
    if (samples.length < 6) return "stable";
    const recent = samples.slice(-5);
    const older = samples.slice(-10, -5);
    if (older.length === 0) return "stable";

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

    if (recentAvg > olderAvg * 1.5) return "degrading";
    if (recentAvg < olderAvg * 0.7) return "improving";
    return "stable";
  }
}

module.exports = { RouteProber };
