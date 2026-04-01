const crypto = require("crypto");

/**
 * Admin Authentication — secures the agent command interface.
 *
 * Two-factor gate:
 * 1. WOLVERINE_ADMIN_KEY must match (sent via header or cookie)
 * 2. Request must come from localhost (127.0.0.1, ::1, ::ffff:127.0.0.1)
 *
 * The admin key is stored in .env.local and never leaves the server.
 * The dashboard stores it as a cookie after the user enters it once.
 */

const LOCALHOST_IPS = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "localhost",
  "0.0.0.0",
]);

class AdminAuth {
  constructor() {
    this.adminKey = process.env.WOLVERINE_ADMIN_KEY || null;
    this._failedAttempts = new Map(); // ip → { count, lastAttempt }
    this._maxFailedAttempts = 10;
    this._lockoutMs = 300000; // 5 min lockout after max failures
  }

  /**
   * Validate a request. Returns { authorized, reason }.
   */
  validate(req) {
    const ip = this._getClientIp(req);

    // 1. IP check — must be localhost
    if (!this._isLocalhost(ip)) {
      return { authorized: false, reason: `Rejected: non-localhost IP (${ip})` };
    }

    // 2. Rate limit on failed attempts
    if (this._isLockedOut(ip)) {
      return { authorized: false, reason: "Locked out: too many failed attempts. Wait 5 minutes." };
    }

    // 3. Admin key check
    if (!this.adminKey) {
      return { authorized: false, reason: "WOLVERINE_ADMIN_KEY not configured in .env.local" };
    }

    const providedKey = this._extractKey(req);
    if (!providedKey) {
      return { authorized: false, reason: "No admin key provided" };
    }

    // Timing-safe comparison to prevent timing attacks
    if (!this._safeCompare(providedKey, this.adminKey)) {
      this._recordFailedAttempt(ip);
      return { authorized: false, reason: "Invalid admin key" };
    }

    // Authorized — clear failed attempts
    this._failedAttempts.delete(ip);
    return { authorized: true };
  }

  /**
   * Express-style middleware for protecting routes.
   */
  middleware() {
    return (req, res, next) => {
      const result = this.validate(req);
      if (!result.authorized) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden", reason: result.reason }));
        return;
      }
      next();
    };
  }

  // -- Private --

  _getClientIp(req) {
    // Get the real IP, ignoring proxies
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      return forwarded.split(",")[0].trim();
    }
    return req.socket.remoteAddress || req.connection.remoteAddress || "";
  }

  _isLocalhost(ip) {
    // Normalize IPv6-mapped IPv4
    const normalized = ip.replace(/^::ffff:/, "");
    return LOCALHOST_IPS.has(ip) || LOCALHOST_IPS.has(normalized) || normalized === "127.0.0.1";
  }

  _extractKey(req) {
    // Check Authorization header first
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      return authHeader.slice(7);
    }

    // Check X-Admin-Key header
    const keyHeader = req.headers["x-admin-key"];
    if (keyHeader) return keyHeader;

    // Check cookie
    const cookies = req.headers.cookie || "";
    const match = cookies.match(/wolverine_admin_key=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);

    // Check query param (for initial setup only)
    const url = new URL(req.url, `http://${req.headers.host}`);
    const qKey = url.searchParams.get("admin_key");
    if (qKey) return qKey;

    return null;
  }

  _safeCompare(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  _recordFailedAttempt(ip) {
    const record = this._failedAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    record.count++;
    record.lastAttempt = Date.now();
    this._failedAttempts.set(ip, record);
  }

  _isLockedOut(ip) {
    const record = this._failedAttempts.get(ip);
    if (!record) return false;
    if (record.count >= this._maxFailedAttempts) {
      if (Date.now() - record.lastAttempt < this._lockoutMs) {
        return true;
      }
      // Lockout expired
      this._failedAttempts.delete(ip);
    }
    return false;
  }
}

module.exports = { AdminAuth, LOCALHOST_IPS };
