const os = require("os");

/**
 * Adaptive Rate Limiter — auto-protects server based on system resources.
 *
 * Injected into child server via error-hook.js. Monitors CPU and memory
 * in real-time and throttles incoming requests when the server is under
 * pressure, reserving ~20% headroom for wolverine's heal tools.
 *
 * Three zones:
 *   GREEN  (< 70% resources) — no limiting, full throughput
 *   YELLOW (70-85%)          — shed new connections gradually
 *   RED    (> 85%)           — reject non-essential requests with 503
 *
 * Enable: WOLVERINE_ADAPTIVE_LIMIT=true (or settings.json adaptiveLimiter.enabled)
 * Disable: WOLVERINE_ADAPTIVE_LIMIT=false (default: enabled)
 *
 * The limiter NEVER blocks:
 *   - Health check routes (/health, /healthz, /ready)
 *   - Wolverine internal routes (/api/v1/heartbeat, /api/v1/register)
 *   - Requests with X-Wolverine-Internal header
 */

const SAMPLE_INTERVAL_MS = 5000;
const HISTORY_SIZE = 12; // 1 minute of samples at 5s intervals
const EXEMPT_PATHS = new Set(["/health", "/healthz", "/ready", "/api/v1/heartbeat", "/api/v1/register"]);

class AdaptiveLimiter {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.thresholdYellow = opts.thresholdYellow || 70; // % — start shedding
    this.thresholdRed = opts.thresholdRed || 85;       // % — reject non-essential
    this.reserveMB = opts.reserveMB || 200;             // MB reserved for wolverine tools

    this._cpuHistory = [];
    this._memHistory = [];
    this._lastCpuTimes = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b) }));
    this._zone = "green";
    this._requestCount = 0;
    this._rejectedCount = 0;
    this._timer = null;

    if (this.enabled) {
      this._timer = setInterval(() => this._sample(), SAMPLE_INTERVAL_MS);
      this._timer.unref(); // don't prevent process exit
    }
  }

  _sample() {
    // CPU usage
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    for (let i = 0; i < cpus.length; i++) {
      const prev = this._lastCpuTimes[i] || { idle: 0, total: 0 };
      const total = Object.values(cpus[i].times).reduce((a, b) => a + b);
      const idle = cpus[i].times.idle;
      totalIdle += idle - prev.idle;
      totalTick += total - prev.total;
      this._lastCpuTimes[i] = { idle, total };
    }
    const cpuPct = totalTick > 0 ? Math.round((1 - totalIdle / totalTick) * 100) : 0;

    // Memory usage (% of total, accounting for reserve)
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const reserveBytes = this.reserveMB * 1048576;
    const effectiveFree = Math.max(0, freeMem - reserveBytes);
    const memPct = Math.round((1 - effectiveFree / totalMem) * 100);

    this._cpuHistory.push(cpuPct);
    this._memHistory.push(memPct);
    if (this._cpuHistory.length > HISTORY_SIZE) this._cpuHistory.shift();
    if (this._memHistory.length > HISTORY_SIZE) this._memHistory.shift();

    // Use max of CPU and memory pressure
    const avgCpu = this._cpuHistory.reduce((a, b) => a + b, 0) / this._cpuHistory.length;
    const avgMem = this._memHistory.reduce((a, b) => a + b, 0) / this._memHistory.length;
    const pressure = Math.max(avgCpu, avgMem);

    if (pressure >= this.thresholdRed) this._zone = "red";
    else if (pressure >= this.thresholdYellow) this._zone = "yellow";
    else this._zone = "green";
  }

  /**
   * Middleware function for Fastify (onRequest hook) or Express.
   * Returns true if request should be allowed, false if rejected.
   */
  shouldAllow(url, headers) {
    if (!this.enabled) return true;

    this._requestCount++;

    // Always allow exempt paths and internal requests
    const path = (url || "").split("?")[0];
    if (EXEMPT_PATHS.has(path)) return true;
    if (headers?.["x-wolverine-internal"]) return true;

    if (this._zone === "green") return true;

    if (this._zone === "yellow") {
      // Probabilistic shedding — reject ~30% of requests
      if (Math.random() < 0.3) {
        this._rejectedCount++;
        return false;
      }
      return true;
    }

    // RED zone — reject all non-exempt
    this._rejectedCount++;
    return false;
  }

  /**
   * Get current limiter status for health endpoints / dashboard.
   */
  getStatus() {
    return {
      enabled: this.enabled,
      zone: this._zone,
      cpuAvg: this._cpuHistory.length > 0 ? Math.round(this._cpuHistory.reduce((a, b) => a + b, 0) / this._cpuHistory.length) : 0,
      memAvg: this._memHistory.length > 0 ? Math.round(this._memHistory.reduce((a, b) => a + b, 0) / this._memHistory.length) : 0,
      totalRequests: this._requestCount,
      rejectedRequests: this._rejectedCount,
      reserveMB: this.reserveMB,
    };
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

// Singleton — shared across the child process
let _instance = null;
function getLimiter(opts) {
  if (!_instance) _instance = new AdaptiveLimiter(opts);
  return _instance;
}

module.exports = { AdaptiveLimiter, getLimiter };
