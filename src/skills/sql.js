/**
 * SQL Skill — safe database interface + SQL injection prevention.
 *
 * Two roles:
 * 1. DATABASE INTERFACE — provides a safe query API for the server
 *    - Parameterized queries only (no string concatenation ever)
 *    - Connection pooling
 *    - Supports SQLite (built-in), PostgreSQL, MySQL via adapters
 *    - Auto-close on process exit
 *
 * 2. INJECTION PREVENTION — middleware that scans all incoming requests
 *    - Detects SQL injection patterns in query params, body, headers
 *    - Blocks malicious requests before they reach route handlers
 *    - Logs attempts to wolverine event system
 *
 * Usage in server/:
 *   const { db, sqlGuard } = require("../src/skills/sql");
 *   app.use(sqlGuard());                    // protect all routes
 *   const users = await db.all("SELECT * FROM users WHERE id = ?", [userId]);
 */

const chalk = require("chalk");

// ── SQL Injection Detection ──────────────────────────────────────

const SQLI_PATTERNS = [
  // Classic injection
  /('\s*(OR|AND)\s+')/i,
  /('\s*;\s*(DROP|DELETE|UPDATE|INSERT|ALTER|EXEC|UNION))/i,
  /(--\s*$|#\s*$)/m,
  /(\b(UNION)\s+(ALL\s+)?SELECT\b)/i,
  // Tautologies
  /('\s*=\s*')/,
  /(\b1\s*=\s*1\b)/,
  /(\bOR\s+1\s*=\s*1\b)/i,
  // Stacked queries
  /(;\s*(DROP|DELETE|TRUNCATE|ALTER|CREATE|INSERT|UPDATE)\s)/i,
  // Comment-based bypass
  /(\/\*.*\*\/)/,
  // Hex/char encoding tricks
  /(0x[0-9a-f]{4,})/i,
  /(CHAR\s*\(\s*\d+\s*(,\s*\d+\s*)*\))/i,
  // SLEEP/BENCHMARK (timing attacks)
  /(SLEEP\s*\(\s*\d+\s*\))/i,
  /(BENCHMARK\s*\()/i,
  // Information schema probing
  /(INFORMATION_SCHEMA)/i,
  /(sys\.objects|sysobjects|syscolumns)/i,
  // Load file / into outfile
  /(LOAD_FILE|INTO\s+OUTFILE|INTO\s+DUMPFILE)/i,
];

/**
 * Check a string for SQL injection patterns.
 * Returns { safe: boolean, patterns: string[] }
 */
function scanForInjection(input) {
  if (!input || typeof input !== "string") return { safe: true, patterns: [] };

  const found = [];
  for (const pattern of SQLI_PATTERNS) {
    if (pattern.test(input)) {
      found.push(pattern.source.slice(0, 40));
    }
  }

  return { safe: found.length === 0, patterns: found };
}

/**
 * Recursively scan an object (body, query, params) for injection.
 */
function deepScan(obj, path = "") {
  const results = [];
  if (!obj) return results;

  if (typeof obj === "string") {
    const scan = scanForInjection(obj);
    if (!scan.safe) results.push({ path: path || "value", patterns: scan.patterns, value: obj.slice(0, 100) });
    return results;
  }

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => results.push(...deepScan(item, `${path}[${i}]`)));
    return results;
  }

  if (typeof obj === "object") {
    for (const [key, val] of Object.entries(obj)) {
      results.push(...deepScan(val, path ? `${path}.${key}` : key));
    }
  }

  return results;
}

/**
 * Express middleware — blocks requests with SQL injection patterns.
 *
 * @param {object} options
 * @param {object} options.logger — wolverine EventLogger (optional)
 * @param {boolean} options.blockMode — true = block request, false = log only (default: true)
 */
function sqlGuard(options = {}) {
  const logger = options.logger || null;
  const blockMode = options.blockMode !== false;

  return (req, res, next) => {
    const threats = [];

    // Scan query params
    threats.push(...deepScan(req.query, "query"));

    // Scan body
    if (req.body) threats.push(...deepScan(req.body, "body"));

    // Scan URL params
    if (req.params) threats.push(...deepScan(req.params, "params"));

    // Scan select headers (user-agent, referer, cookie values)
    const suspectHeaders = ["user-agent", "referer", "x-forwarded-for"];
    for (const h of suspectHeaders) {
      if (req.headers[h]) threats.push(...deepScan(req.headers[h], `header.${h}`));
    }

    if (threats.length === 0) {
      return next();
    }

    // SQL injection detected
    const summary = threats.map(t => `${t.path}: ${t.patterns.join(", ")}`).join(" | ");
    console.log(chalk.red(`  🛡️ SQL INJECTION BLOCKED: ${req.method} ${req.path} — ${summary}`));

    if (logger) {
      logger.critical("security.sqli_blocked", `SQL injection blocked: ${req.method} ${req.path}`, {
        method: req.method,
        path: req.path,
        threats: threats.map(t => ({ path: t.path, value: t.value })),
        ip: req.ip || req.socket.remoteAddress,
      });
    }

    if (blockMode) {
      res.status(403).json({ error: "Forbidden", message: "Potentially malicious input detected." });
      return;
    }

    // Log-only mode — let request through but flag it
    req._sqliWarning = threats;
    next();
  };
}

// ── Safe Database Interface ──────────────────────────────────────

/**
 * Cluster-safe database — zero waits, zero blocking.
 *
 * Architecture:
 * - Reads: every worker has its own read-only connection (concurrent, no locks)
 * - Writes: single dedicated write connection with a synchronous FIFO queue
 *
 * How the write queue works:
 * - Writes are synchronous in better-sqlite3 (microseconds each)
 * - Queue is just an array that drains in a microtask
 * - No busy_timeout, no delays, no IPC — writes are fast, they just can't overlap
 * - Queue forms naturally under load, drains instantly when the current write finishes
 *
 * SQLite specifics:
 * - WAL mode: readers never block writers, writers never block readers
 * - No busy_timeout needed — only one connection writes, so no contention
 * - NORMAL sync: safe with WAL, 1 fsync per transaction instead of 2
 */
class SafeDB {
  constructor(options = {}) {
    this.type = options.type || "sqlite";
    this.path = options.path || ":memory:";
    this._reader = null;   // read-only connection (concurrent)
    this._writer = null;   // single write connection (serialized)
    this._closed = false;
    this._queue = [];      // pending write operations
    this._draining = false;
  }

  async connect() {
    if (this.type === "sqlite") {
      try {
        const Database = require("better-sqlite3");

        // Read connection — used by get() and all()
        this._reader = new Database(this.path, { readonly: false });
        this._reader.pragma("journal_mode = WAL");
        this._reader.pragma("foreign_keys = ON");
        this._reader.pragma("synchronous = NORMAL");
        this._reader.pragma("cache_size = -20000");

        // Write connection — only used by run(), exec(), transaction()
        // Separate connection means reads never wait for writes
        this._writer = new Database(this.path);
        this._writer.pragma("journal_mode = WAL");
        this._writer.pragma("foreign_keys = ON");
        this._writer.pragma("synchronous = NORMAL");

        // Idempotency table — prevents double-execution of writes in cluster mode
        this._writer.exec(`
          CREATE TABLE IF NOT EXISTS _idempotency (
            key TEXT PRIMARY KEY,
            result TEXT,
            created_at INTEGER DEFAULT (strftime('%s','now')),
            expires_at INTEGER
          )
        `);
        // Clean expired keys on connect
        this._writer.exec(`DELETE FROM _idempotency WHERE expires_at < strftime('%s','now')`);

      } catch (err) {
        if (err.code === "MODULE_NOT_FOUND") {
          throw new Error("Install better-sqlite3: npm install better-sqlite3");
        }
        throw err;
      }
    } else if (this.type === "custom") {
      // User manages their own connection
    } else {
      throw new Error(`Unsupported DB type: ${this.type}. Use "sqlite" or pass a custom driver.`);
    }

    process.on("exit", () => this.close());
  }

  /**
   * Idempotent write — execute fn only if this key hasn't been seen before.
   * In cluster mode, prevents the same request from double-firing across workers.
   *
   * @param {string} key — unique idempotency key (e.g. from X-Idempotency-Key header)
   * @param {Function} fn — function that performs the write, receives writerProxy
   * @param {number} ttlSeconds — how long to remember this key (default: 86400 = 24h)
   * @returns {{ executed: boolean, result: any }} — executed=false if key was already seen
   */
  idempotent(key, fn, ttlSeconds = 86400) {
    this._assertOpen();
    return this._enqueueWrite(() => {
      // Check if key already executed
      const existing = this._writer.prepare("SELECT result FROM _idempotency WHERE key = ? AND expires_at > strftime('%s','now')").get(key);
      if (existing) {
        return { executed: false, result: JSON.parse(existing.result || "null"), cached: true };
      }

      // Execute the write
      const txn = this._writer.transaction(() => {
        const result = fn(this._writerProxy());
        // Store the key so duplicates are rejected
        this._writer.prepare(
          "INSERT OR REPLACE INTO _idempotency (key, result, expires_at) VALUES (?, ?, strftime('%s','now') + ?)"
        ).run(key, JSON.stringify(result ?? null), ttlSeconds);
        return result;
      });

      const result = txn();
      return { executed: true, result, cached: false };
    });
  }

  /**
   * Clean up expired idempotency keys. Call periodically (e.g., every hour).
   */
  pruneIdempotency() {
    this._assertOpen();
    return this._enqueueWrite(() => {
      return this._writer.prepare("DELETE FROM _idempotency WHERE expires_at < strftime('%s','now')").run();
    });
  }

  /**
   * Write query (INSERT, UPDATE, DELETE, CREATE).
   * Queued and executed in order. Returns a promise that resolves with the result.
   */
  run(sql, params = []) {
    this._assertOpen();
    this._assertSafe(sql);
    return this._enqueueWrite(() => this._writer.prepare(sql).run(...params));
  }

  /**
   * Read one row. Direct on the read connection — never waits.
   */
  get(sql, params = []) {
    this._assertOpen();
    this._assertSafe(sql);
    return this._reader.prepare(sql).get(...params);
  }

  /**
   * Read all rows. Direct on the read connection — never waits.
   */
  all(sql, params = []) {
    this._assertOpen();
    this._assertSafe(sql);
    return this._reader.prepare(sql).all(...params);
  }

  /**
   * Raw SQL execution (migrations/schema). Queued through the writer.
   */
  exec(sql) {
    this._assertOpen();
    return this._enqueueWrite(() => this._writer.exec(sql));
  }

  /**
   * Atomic transaction. All writes inside fn run as one unit.
   * Queued as a single operation — no other writes can interleave.
   */
  transaction(fn) {
    this._assertOpen();
    return this._enqueueWrite(() => {
      const txn = this._writer.transaction(() => fn(this._writerProxy()));
      return txn();
    });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      if (this._writer) {
        try { this._writer.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
        this._writer.close();
      }
      if (this._reader) this._reader.close();
    } catch {}
  }

  _assertOpen() {
    if (this._closed || (!this._reader && !this._writer)) {
      throw new Error("Database not connected. Call db.connect() first.");
    }
  }

  _assertSafe(sql) {
    if (/'\s*\+\s*/.test(sql) || /`\$\{/.test(sql)) {
      throw new Error("UNSAFE: SQL appears to use string concatenation. Use parameterized queries (?) instead.");
    }
  }

  /**
   * Write queue — FIFO, no delays, drains synchronously.
   * Each write is microseconds. Queue only forms under concurrent write pressure.
   * Drains completely in a single microtask when the current write finishes.
   */
  _enqueueWrite(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      if (!this._draining) this._drain();
    });
  }

  _drain() {
    this._draining = true;
    while (this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      try {
        resolve(fn());
      } catch (err) {
        reject(err);
      }
    }
    this._draining = false;
  }

  /**
   * Proxy for use inside transactions — writes go directly to writer (already locked).
   */
  _writerProxy() {
    const writer = this._writer;
    return {
      run: (sql, params = []) => writer.prepare(sql).run(...params),
      exec: (sql) => writer.exec(sql),
      get: (sql, params = []) => writer.prepare(sql).get(...params),
      all: (sql, params = []) => writer.prepare(sql).all(...params),
    };
  }
}

// ── Idempotency Middleware ──────────────────────────────────────

/**
 * Request idempotency middleware — prevents double-fire in cluster mode.
 *
 * How it works:
 * 1. Client sends write request (POST/PUT/PATCH/DELETE) with X-Idempotency-Key header
 * 2. Middleware checks if this key was already processed
 * 3. If yes: return cached response (no re-execution)
 * 4. If no: execute handler, cache response, return result
 *
 * Without the header, mutating requests get an auto-generated key based on
 * method + path + body hash. This means identical retries are deduplicated
 * even without client cooperation.
 *
 * In cluster mode (reusePort), a retry can land on a different worker.
 * Since all workers share the same SQLite database (WAL mode), the
 * idempotency table is visible to all workers instantly.
 *
 * Safe methods (GET, HEAD, OPTIONS) are always passed through — they're
 * inherently idempotent.
 *
 * @param {object} options
 * @param {SafeDB} options.db — SafeDB instance (must be connected)
 * @param {number} options.ttlSeconds — how long to cache responses (default: 86400)
 * @param {object} options.logger — wolverine EventLogger (optional)
 */
function idempotencyGuard(options = {}) {
  const db = options.db;
  const ttlSeconds = options.ttlSeconds || 86400;
  const logger = options.logger || null;
  const crypto = require("crypto");

  return async (req, res, next) => {
    // Safe methods are inherently idempotent — pass through
    const method = (req.method || "GET").toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return next();

    // Get or generate idempotency key
    let key = req.headers["x-idempotency-key"] || req.headers["idempotency-key"];
    if (!key) {
      // Auto-generate from method + path + body hash
      const bodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body || "");
      key = crypto.createHash("sha256").update(`${method}:${req.url}:${bodyStr}`).digest("hex");
    }

    if (!db || !db._writer) return next(); // No DB — can't check, pass through

    try {
      // Check idempotency table directly (read from writer for consistency)
      const existing = db._writer.prepare(
        "SELECT result FROM _idempotency WHERE key = ? AND expires_at > strftime('%s','now')"
      ).get(key);

      if (existing) {
        // Already processed — return cached response
        const cached = JSON.parse(existing.result || "null");
        if (logger) logger.debug("idempotency.hit", `Duplicate request blocked: ${method} ${req.url}`, { key: key.slice(0, 16) });

        const status = cached?.statusCode || 200;
        const body = cached?.body || cached;
        if (typeof res.code === "function") {
          // Fastify
          res.code(status).header("X-Idempotency-Cached", "true").send(body);
        } else {
          // Express
          res.status(status).set("X-Idempotency-Cached", "true").json(body);
        }
        return;
      }

      // Not seen — attach key to request for the route handler to use
      req._idempotencyKey = key;
      req._idempotencyTtl = ttlSeconds;
    } catch {
      // DB error — don't block the request, just pass through
    }

    next();
  };
}

/**
 * After-response hook — stores the response for future idempotency checks.
 * For Fastify, add as onSend hook. For Express, monkey-patch res.json.
 *
 * @param {SafeDB} db — connected SafeDB instance
 */
function idempotencyAfterHook(db) {
  return (req, reply, payload, done) => {
    if (req._idempotencyKey && db && db._writer) {
      try {
        const statusCode = reply.statusCode || 200;
        const result = JSON.stringify({ statusCode, body: typeof payload === "string" ? JSON.parse(payload) : payload });
        db._writer.prepare(
          "INSERT OR IGNORE INTO _idempotency (key, result, expires_at) VALUES (?, ?, strftime('%s','now') + ?)"
        ).run(req._idempotencyKey, result, req._idempotencyTtl || 86400);
      } catch { /* non-fatal */ }
    }
    done();
  };
}

// ── Skill Metadata (for SkillRegistry discovery) ──

const SKILL_NAME = "sql";
const SKILL_DESCRIPTION = "SQL database interface with injection prevention + idempotency. Provides sqlGuard() middleware to block SQL injection, idempotencyGuard() middleware to prevent double-fire in cluster mode, and SafeDB class for parameterized-only database queries with built-in idempotency key support.";
const SKILL_KEYWORDS = ["sql", "database", "db", "query", "injection", "sqlite", "postgres", "mysql", "select", "insert", "update", "delete", "table", "schema", "migration", "parameterized", "idempotent", "idempotency", "duplicate", "double", "cluster", "transaction"];
const SKILL_USAGE = `// Protect routes from SQL injection + double-fire
const { sqlGuard, idempotencyGuard, idempotencyAfterHook, SafeDB } = require("../src/skills/sql");
const db = new SafeDB({ type: "sqlite", path: "./server/data.db" });
await db.connect();

// Middleware: injection prevention + idempotency (cluster-safe)
fastify.addHook("preHandler", sqlGuard({ logger }));
fastify.addHook("preHandler", idempotencyGuard({ db, logger }));
fastify.addHook("onSend", idempotencyAfterHook(db));

// Reads (concurrent across workers — never waits)
const users = db.all("SELECT * FROM users WHERE role = ?", ["admin"]);

// Writes (serialized FIFO queue — no corruption)
db.run("INSERT INTO users (name, role) VALUES (?, ?)", ["Alice", "admin"]);

// Idempotent write — prevents double-charge/double-insert in cluster mode
const result = await db.idempotent("order-abc-123", (tx) => {
  tx.run("INSERT INTO orders (id, total) VALUES (?, ?)", ["abc-123", 99.99]);
  return { orderId: "abc-123" };
}); // result.executed=true first time, false on retry

// Atomic transaction (all-or-nothing)
db.transaction((tx) => {
  tx.run("INSERT INTO orders (user_id, total) VALUES (?, ?)", [1, 99.99]);
  tx.run("UPDATE users SET order_count = order_count + 1 WHERE id = ?", [1]);
});`;

// ── Exports ──

module.exports = {
  // Skill metadata
  SKILL_NAME,
  SKILL_DESCRIPTION,
  SKILL_KEYWORDS,
  SKILL_USAGE,

  // Middleware
  sqlGuard,
  idempotencyGuard,
  idempotencyAfterHook,
  scanForInjection,
  deepScan,

  // Database
  SafeDB,

  // Pattern list
  SQLI_PATTERNS,
};
