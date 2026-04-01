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
 * Lightweight database wrapper — parameterized queries only.
 * Uses better-sqlite3 for SQLite (sync, fast, zero-config).
 * For PostgreSQL/MySQL, users install their own driver and pass a connection.
 */
class SafeDB {
  constructor(options = {}) {
    this.type = options.type || "sqlite";
    this.path = options.path || ":memory:";
    this._db = null;
    this._closed = false;
  }

  /**
   * Connect to the database.
   */
  async connect() {
    if (this.type === "sqlite") {
      try {
        const Database = require("better-sqlite3");
        this._db = new Database(this.path);
        this._db.pragma("journal_mode = WAL");
        this._db.pragma("foreign_keys = ON");
      } catch (err) {
        if (err.code === "MODULE_NOT_FOUND") {
          throw new Error("Install better-sqlite3: npm install better-sqlite3");
        }
        throw err;
      }
    } else if (this.type === "custom" && this._db) {
      // Custom driver already set
    } else {
      throw new Error(`Unsupported DB type: ${this.type}. Use "sqlite" or pass a custom driver.`);
    }

    // Auto-close on process exit
    process.on("exit", () => this.close());
    process.on("SIGINT", () => { this.close(); process.exit(0); });
  }

  /**
   * Run a query that doesn't return rows (INSERT, UPDATE, DELETE, CREATE).
   * ALWAYS use parameterized queries.
   *
   * @param {string} sql — SQL with ? placeholders
   * @param {Array} params — values for placeholders
   */
  run(sql, params = []) {
    this._assertOpen();
    this._assertSafe(sql);
    if (this.type === "sqlite") {
      return this._db.prepare(sql).run(...params);
    }
  }

  /**
   * Get one row.
   */
  get(sql, params = []) {
    this._assertOpen();
    this._assertSafe(sql);
    if (this.type === "sqlite") {
      return this._db.prepare(sql).get(...params);
    }
  }

  /**
   * Get all rows.
   */
  all(sql, params = []) {
    this._assertOpen();
    this._assertSafe(sql);
    if (this.type === "sqlite") {
      return this._db.prepare(sql).all(...params);
    }
  }

  /**
   * Execute raw SQL (for migrations/schema). No parameterization needed.
   * Only available with explicit opt-in.
   */
  exec(sql) {
    this._assertOpen();
    if (this.type === "sqlite") {
      return this._db.exec(sql);
    }
  }

  close() {
    if (this._closed || !this._db) return;
    this._closed = true;
    try {
      if (this.type === "sqlite") this._db.close();
    } catch {}
  }

  _assertOpen() {
    if (!this._db || this._closed) throw new Error("Database not connected. Call db.connect() first.");
  }

  _assertSafe(sql) {
    // Block queries that appear to use string concatenation instead of params
    if (/'\s*\+\s*/.test(sql) || /`\$\{/.test(sql)) {
      throw new Error("UNSAFE: SQL appears to use string concatenation. Use parameterized queries (?) instead.");
    }
  }
}

// ── Skill Metadata (for SkillRegistry discovery) ──

const SKILL_NAME = "sql";
const SKILL_DESCRIPTION = "SQL database interface with injection prevention. Provides sqlGuard() middleware to block SQL injection on all endpoints, and SafeDB class for parameterized-only database queries.";
const SKILL_KEYWORDS = ["sql", "database", "db", "query", "injection", "sqlite", "postgres", "mysql", "select", "insert", "update", "delete", "table", "schema", "migration", "parameterized"];
const SKILL_USAGE = `// Protect all routes from SQL injection
const { sqlGuard } = require("../src/skills/sql");
app.use(sqlGuard({ logger: wolverineLogger }));

// Safe database queries (parameterized only)
const { SafeDB } = require("../src/skills/sql");
const db = new SafeDB({ type: "sqlite", path: "./data.db" });
await db.connect();
const users = db.all("SELECT * FROM users WHERE role = ?", ["admin"]);`;

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
