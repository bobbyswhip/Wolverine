/**
 * Rate Limiter — prevents error explosion from draining API budget.
 *
 * Uses a sliding window + token bucket approach:
 * - Tracks API calls in a rolling time window
 * - Enforces max calls per window
 * - Enforces minimum gap between calls
 * - Detects error loops (same error repeating) and backs off exponentially
 */
class RateLimiter {
  constructor(options = {}) {
    // Max API calls within the rolling window
    this.maxCallsPerWindow = options.maxCallsPerWindow || 10;
    // Window size in ms (default: 10 minutes)
    this.windowMs = options.windowMs || 10 * 60 * 1000;
    // Minimum gap between calls in ms (default: 5 seconds)
    this.minGapMs = options.minGapMs || 5000;
    // Max cost per hour in estimated tokens (rough budget protection)
    this.maxTokensPerHour = options.maxTokensPerHour || 100000;

    // Global heal cap — stops infinite heal loops regardless of error signature
    this.maxGlobalHealsPerWindow = options.maxGlobalHealsPerWindow || 5;
    this.globalWindowMs = options.globalWindowMs || 300000; // 5 minutes

    // Internal state
    this._callLog = [];          // timestamps of recent calls
    this._tokenLog = [];         // { timestamp, tokens } for budget tracking
    this._errorSignatures = {};  // signature -> { count, lastSeen, backoffMs }
    this._lastCallTime = 0;
    this._globalHealCount = 0;
    this._globalHealWindowStart = Date.now();
  }

  /**
   * Check if a call is allowed. Returns { allowed, reason, waitMs }.
   * If not allowed, waitMs indicates how long to wait before retrying.
   */
  check(errorSignature) {
    const now = Date.now();
    this._pruneOldEntries(now);

    // 0. Global heal cap — regardless of error signature
    const globalElapsed = now - this._globalHealWindowStart;
    if (globalElapsed > this.globalWindowMs) {
      this._globalHealCount = 0;
      this._globalHealWindowStart = now;
    }
    if (this._globalHealCount >= this.maxGlobalHealsPerWindow) {
      const waitMs = this.globalWindowMs - globalElapsed;
      return {
        allowed: false,
        reason: `Global heal limit: ${this.maxGlobalHealsPerWindow} heals in ${Math.round(this.globalWindowMs / 1000)}s. Wait ${Math.ceil(waitMs / 1000)}s.`,
        waitMs: Math.max(waitMs, 1000),
      };
    }

    // 1. Minimum gap between calls
    const sinceLast = now - this._lastCallTime;
    if (sinceLast < this.minGapMs) {
      const waitMs = this.minGapMs - sinceLast;
      return { allowed: false, reason: `Rate limit: minimum ${this.minGapMs}ms gap between calls. Wait ${waitMs}ms.`, waitMs };
    }

    // 2. Sliding window limit
    if (this._callLog.length >= this.maxCallsPerWindow) {
      const oldestInWindow = this._callLog[0];
      const waitMs = oldestInWindow + this.windowMs - now;
      return { allowed: false, reason: `Rate limit: ${this.maxCallsPerWindow} calls per ${this.windowMs / 1000}s window exceeded.`, waitMs };
    }

    // 3. Hourly token budget
    const hourAgo = now - 3600000;
    const recentTokens = this._tokenLog
      .filter(e => e.timestamp > hourAgo)
      .reduce((sum, e) => sum + e.tokens, 0);
    if (recentTokens >= this.maxTokensPerHour) {
      return { allowed: false, reason: `Budget limit: estimated ${recentTokens} tokens used in the last hour (max: ${this.maxTokensPerHour}).`, waitMs: 60000 };
    }

    // 4. Error loop detection — same error repeating gets exponential backoff
    if (errorSignature) {
      const sig = this._errorSignatures[errorSignature];
      if (sig && sig.count >= 2) {
        const timeSinceLast = now - sig.lastSeen;
        if (timeSinceLast < sig.backoffMs) {
          const waitMs = sig.backoffMs - timeSinceLast;
          return {
            allowed: false,
            reason: `Error loop detected: same error seen ${sig.count} times. Backing off ${sig.backoffMs / 1000}s.`,
            waitMs,
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Record a call was made. Call this after a successful API request.
   */
  record(errorSignature, estimatedTokens = 3000) {
    const now = Date.now();
    this._callLog.push(now);
    this._tokenLog.push({ timestamp: now, tokens: estimatedTokens });
    this._lastCallTime = now;
    this._globalHealCount++;

    // Track error signature for loop detection
    if (errorSignature) {
      if (!this._errorSignatures[errorSignature]) {
        this._errorSignatures[errorSignature] = { count: 0, lastSeen: 0, backoffMs: 5000 };
      }
      const sig = this._errorSignatures[errorSignature];
      sig.count++;
      sig.lastSeen = now;
      // Exponential backoff: 5s, 10s, 20s, 40s, 80s... capped at 5 min
      sig.backoffMs = Math.min(5000 * Math.pow(2, sig.count - 1), 300000);
    }
  }

  /**
   * Clear the error signature tracker (call after a successful fix that doesn't recur).
   */
  clearSignature(errorSignature) {
    delete this._errorSignatures[errorSignature];
  }

  /**
   * Generate a stable signature for an error (for loop detection).
   */
  static signature(errorMessage, filePath) {
    // Strip line numbers and paths to create a stable key
    const normalized = (errorMessage || "")
      .replace(/:\d+:\d+/g, "")
      .replace(/\(.+\)/g, "")
      .trim();
    return `${filePath || "unknown"}::${normalized}`;
  }

  /**
   * Get current state for debugging/logging.
   */
  getStats() {
    const now = Date.now();
    this._pruneOldEntries(now);
    return {
      callsInWindow: this._callLog.length,
      maxCallsPerWindow: this.maxCallsPerWindow,
      globalHealsInWindow: this._globalHealCount,
      maxGlobalHealsPerWindow: this.maxGlobalHealsPerWindow,
      trackedErrorSignatures: Object.keys(this._errorSignatures).length,
      estimatedTokensLastHour: this._tokenLog
        .filter(e => e.timestamp > now - 3600000)
        .reduce((sum, e) => sum + e.tokens, 0),
    };
  }

  _pruneOldEntries(now) {
    const windowStart = now - this.windowMs;
    this._callLog = this._callLog.filter(t => t > windowStart);

    const hourAgo = now - 3600000;
    this._tokenLog = this._tokenLog.filter(e => e.timestamp > hourAgo);

    // Clean stale error signatures (not seen in 30 min)
    const staleThreshold = now - 30 * 60 * 1000;
    for (const key of Object.keys(this._errorSignatures)) {
      if (this._errorSignatures[key].lastSeen < staleThreshold) {
        delete this._errorSignatures[key];
      }
    }
  }
}

module.exports = { RateLimiter };
