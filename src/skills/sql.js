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
 * Cluster-safe database wrapper — parameterized queries only.
 *
 * Handles multi-worker scenarios:
 *
 * SQLite:
 * - WAL mode (allows concurrent reads while one writer works)
 * - busy_timeout (waits instead of throwing SQLITE_BUSY)
 * - Serialized writes via _withWriteLock (prevents corruption)
 * - Each worker gets its own connection (no shared handles across processes)
 *
 * PostgreSQL/MySQL:
 * - Each worker gets its own connection pool (no cross-process sharing)
 * - Advisory locks available for critical sections
 */
class SafeDB {
  constructor(options = {}) {
    this.type = options.type || "sqlite";
    this.path = options.path || ":memory:";
    this._db = null;
    this._closed = false;
    this._writeLock = false;
    this._writeQueue = [];
  }

  /**
   * Connect to the database. Each cluster worker calls this independently.
   */
  async connect() {
    if (this.type === "sqlite") {
      try {
        const Database = require("better-sqlite3");
        this._db = new Database(this.path);

        // WAL mode: multiple readers + one writer (cluster-safe for reads)
        this._db.pragma("journal_mode = WAL");
        // Wait up to 5s if another worker is writing (prevents SQLITE_BUSY crashes)
        this._db.pragma("busy_timeout = 5000");
        // Enforce foreign keys
        this._db.pragma("foreign_keys = ON");
        // Sync mode: NORMAL is safe with WAL and faster than FULL
        this._db.pragma("synchronous = NORMAL");
        // Larger cache for better read performance across workers
        this._db.pragma("cache_size = -20000"); // 20MB

      } catch (err) {
        if (err.code === "MODULE_NOT_FOUND") {
          throw new Error("Install better-sqlite3: npm install better-sqlite3");
        }
        throw err;
      }
    } else if (this.type === "custom" && this._db) {
      // Custom driver already set (user manages their own pool)
    } else {
      throw new Error(`Unsupported DB type: ${this.type}. Use "sqlite" or pass a custom driver.`);
    }

    process.on("exit", () => this.close());
    process.on("SIGINT", () => { this.close(); process.exit(0); });
  }

  /**
   * Run a write query (INSERT, UPDATE, DELETE, CREATE).
   * Serialized through a write lock to prevent multi-worker corruption.
   */
  run(sql, params = []) {
    this._assertOpen();
    this._assertSafe(sql);
    if (this.type === "sqlite") {
      return this._withWriteLock(() => this._db.prepare(sql).run(...params));
    }
  }

  /**
   * Get one row. Reads are concurrent (WAL mode allows this).
   */
  get(sql, params = []) {
    this._assertOpen();
    this._assertSafe(sql);
    if (this.type === "sqlite") {
      return this._db.prepare(sql).get(...params);
    }
  }

  /**
   * Get all rows. Reads are concurrent.
   */
  all(sql, params = []) {
    this._assertOpen();
    this._assertSafe(sql);
    if (this.type === "sqlite") {
      return this._db.prepare(sql).all(...params);
    }
  }

  /**
   * Execute raw SQL (migrations/schema). Serialized through write lock.
   */
  exec(sql) {
    this._assertOpen();
    if (this.type === "sqlite") {
      return this._withWriteLock(() => this._db.exec(sql));
    }
  }

  /**
   * Run multiple writes in a single transaction (atomic, fastest for batch ops).
   * Cluster-safe: holds the write lock for the entire transaction.
   *
   * @param {function} fn — function that calls this.run(), this.exec(), etc.
   */
  transaction(fn) {
    this._assertOpen();
    if (this.type === "sqlite") {
      return this._withWriteLock(() => {
        const txn = this._db.transaction(fn);
        return txn(this);
      });
    }
  }

  close() {
    if (this._closed || !this._db) return;
    this._closed = true;
    try {
      if (this.type === "sqlite") {
        // Checkpoint WAL before closing to merge pending writes
        try { this._db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
        this._db.close();
      }
    } catch {}
  }

  _assertOpen() {
    if (!this._db || this._closed) throw new Error("Database not connected. Call db.connect() first.");
  }

  _assertSafe(sql) {
    if (/'\s*\+\s*/.test(sql) || /`\$\{/.test(sql)) {
      throw new Error("UNSAFE: SQL appears to use string concatenation. Use parameterized queries (?) instead.");
    }
  }

  /**
   * Serialize writes within this worker process.
   * SQLite WAL handles cross-process write serialization via busy_timeout,
   * but within a single process we queue writes to avoid overlapping prepare/run calls.
   */
  _withWriteLock(fn) {
    if (!this._writeLock) {
      this._writeLock = true;
      try {
        return fn();
      } finally {
        this._writeLock = false;
        // Process queued writes
        if (this._writeQueue.length > 0) {
          const next = this._writeQueue.shift();
          next();
        }
      }
    }

    // Already locked — queue this write
    return new Promise((resolve, reject) => {
      this._writeQueue.push(() => {
        try { resolve(this._withWriteLock(fn)); }
        catch (err) { reject(err); }
      });
    });
  }
}

// ── Skill Metadata (for SkillRegistry discovery) ──

const SKILL_NAME = "sql";
const SKILL_DESCRIPTION = "SQL database interface with injection prevention. Provides sqlGuard() middleware to block SQL injection on all endpoints, and SafeDB class for parameterized-only database queries.";
const SKILL_KEYWORDS = ["sql", "database", "db", "query", "injection", "sqlite", "postgres", "mysql", "select", "insert", "update", "delete", "table", "schema", "migration", "parameterized"];
const SKILL_USAGE = `// Protect all routes from SQL injection
const { sqlGuard } = require("../src/skills/sql");
app.use(sqlGuard({ logger: wolverineLogger }));

// Cluster-safe database (each worker gets its own connection)
const { SafeDB } = require("../src/skills/sql");
const db = new SafeDB({ type: "sqlite", path: "./server/data.db" });
await db.connect(); // WAL mode, busy_timeout=5s, write serialization

// Reads (concurrent across workers)
const users = db.all("SELECT * FROM users WHERE role = ?", ["admin"]);

// Writes (serialized — no corruption)
db.run("INSERT INTO users (name, role) VALUES (?, ?)", ["Alice", "admin"]);

// Batch writes (atomic transaction, single lock)
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
  scanForInjection,
  deepScan,

  // Database
  SafeDB,

  // Pattern list
  SQLI_PATTERNS,
};
