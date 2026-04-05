const fs = require("fs");
const path = require("path");

/**
 * Server Context Scanner — builds a structured map of the server/ directory.
 *
 * Scans routes, middleware, config, database, dependencies, and file structure
 * to give the AI agent full context when diagnosing errors.
 *
 * Runs automatically on startup (stored in .wolverine/server-context.json).
 * Can be triggered manually: wolverine --init or require('./server-context').scan(cwd)
 *
 * The context is injected into the agent's system prompt so it knows the
 * server's structure without re-scanning on every heal.
 */

const CONTEXT_PATH = ".wolverine/server-context.json";
const MAX_FILE_SCAN = 200; // don't scan more than 200 files
const SKIP_DIRS = new Set(["node_modules", ".git", ".wolverine", "dist", ".next", ".cache", "coverage", "__pycache__"]);

function scan(cwd) {
  const serverDir = path.join(cwd, "server");
  if (!fs.existsSync(serverDir)) return null;

  const context = {
    scannedAt: new Date().toISOString(),
    routes: [],
    middleware: [],
    database: { tables: [], config: null },
    config: {},
    dependencies: {},
    structure: [],
    exports: [],
    envVars: [],
  };

  // 1. Scan routes
  const routesDir = path.join(serverDir, "routes");
  if (fs.existsSync(routesDir)) {
    for (const file of _listFiles(routesDir, ".js")) {
      try {
        const code = fs.readFileSync(file, "utf-8");
        const relPath = path.relative(cwd, file);
        const methods = [];
        // Match fastify.get/post/put/delete/patch or app.get/post etc
        const routeRegex = /(?:fastify|app|router)\.(get|post|put|delete|patch|options|head)\s*\(\s*['"`]([^'"`]+)/gi;
        let m;
        while ((m = routeRegex.exec(code)) !== null) {
          methods.push({ method: m[1].toUpperCase(), path: m[2] });
        }
        // Match fastify.register with prefix
        const registerRegex = /register\s*\(.*?prefix\s*:\s*['"`]([^'"`]+)/gi;
        while ((m = registerRegex.exec(code)) !== null) {
          methods.push({ method: "REGISTER", path: m[1] });
        }
        if (methods.length > 0) {
          context.routes.push({ file: relPath, endpoints: methods });
        }
      } catch {}
    }
  }

  // 2. Scan middleware
  const indexFile = path.join(serverDir, "index.js");
  if (fs.existsSync(indexFile)) {
    try {
      const code = fs.readFileSync(indexFile, "utf-8");
      // Find app.use() or fastify.register() calls
      const mwRegex = /(?:app\.use|fastify\.register)\s*\(\s*(?:require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|(\w+))/gi;
      let m;
      while ((m = mwRegex.exec(code)) !== null) {
        context.middleware.push(m[1] || m[2]);
      }
    } catch {}
  }

  // 3. Scan database
  const dbFiles = [
    path.join(serverDir, "lib", "db.js"),
    path.join(serverDir, "db.js"),
    path.join(serverDir, "models", "index.js"),
    path.join(serverDir, "database.js"),
  ];
  for (const dbFile of dbFiles) {
    if (!fs.existsSync(dbFile)) continue;
    try {
      const code = fs.readFileSync(dbFile, "utf-8");
      // Detect database type
      if (/require\s*\(\s*['"]pg['"]/.test(code)) context.database.type = "postgresql";
      else if (/require\s*\(\s*['"]better-sqlite3['"]/.test(code)) context.database.type = "sqlite";
      else if (/require\s*\(\s*['"]mysql/.test(code)) context.database.type = "mysql";
      else if (/require\s*\(\s*['"]mongoose['"]/.test(code)) context.database.type = "mongodb";
      else if (/require\s*\(\s*['"]ioredis['"]/.test(code)) context.database.hasRedis = true;
      // Find CREATE TABLE statements
      const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi;
      let m;
      while ((m = tableRegex.exec(code)) !== null) {
        context.database.tables.push(m[1]);
      }
      context.database.config = path.relative(cwd, dbFile);
    } catch {}
  }

  // 4. Scan config
  const settingsPath = path.join(serverDir, "config", "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      // Only include non-secret top-level keys
      context.config = Object.keys(settings).reduce((acc, k) => {
        if (typeof settings[k] === "object") acc[k] = Object.keys(settings[k]);
        else acc[k] = typeof settings[k];
        return acc;
      }, {});
    } catch {}
  }

  // 5. Dependencies
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      context.dependencies = {
        production: Object.keys(pkg.dependencies || {}),
        dev: Object.keys(pkg.devDependencies || {}),
        optional: Object.keys(pkg.optionalDependencies || {}),
      };
      context.nodeVersion = pkg.engines?.node || "unknown";
      context.version = pkg.version;
    } catch {}
  }

  // 6. File structure (server/ tree)
  const tree = [];
  let fileCount = 0;
  const walk = (dir, depth) => {
    if (depth > 4 || fileCount > MAX_FILE_SCAN) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const rel = path.relative(cwd, path.join(dir, entry.name));
        if (entry.isDirectory()) {
          tree.push(rel + "/");
          walk(path.join(dir, entry.name), depth + 1);
        } else {
          tree.push(rel);
          fileCount++;
        }
      }
    } catch {}
  };
  walk(serverDir, 0);
  context.structure = tree;

  // 7. Env vars used (scan for process.env.X patterns)
  const envVars = new Set();
  const scanForEnv = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const file of _listFiles(dir, ".js")) {
      try {
        const code = fs.readFileSync(file, "utf-8");
        const envRegex = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
        let m;
        while ((m = envRegex.exec(code)) !== null) envVars.add(m[1]);
      } catch {}
    }
  };
  scanForEnv(serverDir);
  context.envVars = [...envVars].sort();

  // Save
  const outPath = path.join(cwd, CONTEXT_PATH);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(context, null, 2), "utf-8");

  return context;
}

/**
 * Load cached context (fast — no rescan).
 */
function load(cwd) {
  const ctxPath = path.join(cwd, CONTEXT_PATH);
  if (!fs.existsSync(ctxPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(ctxPath, "utf-8"));
  } catch { return null; }
}

/**
 * Get a compact text summary for injecting into AI prompts.
 */
function getSummary(cwd) {
  const ctx = load(cwd);
  if (!ctx) return "";

  const lines = [];
  if (ctx.routes.length > 0) {
    const allEndpoints = ctx.routes.flatMap(r => r.endpoints.map(e => `${e.method} ${e.path}`));
    lines.push(`Routes (${allEndpoints.length}): ${allEndpoints.slice(0, 20).join(", ")}${allEndpoints.length > 20 ? ` +${allEndpoints.length - 20} more` : ""}`);
  }
  if (ctx.middleware.length > 0) lines.push(`Middleware: ${ctx.middleware.join(", ")}`);
  if (ctx.database.type) lines.push(`Database: ${ctx.database.type}${ctx.database.tables.length > 0 ? ` (tables: ${ctx.database.tables.join(", ")})` : ""}${ctx.database.hasRedis ? " + Redis" : ""}`);
  if (ctx.envVars.length > 0) lines.push(`Env vars used: ${ctx.envVars.slice(0, 15).join(", ")}${ctx.envVars.length > 15 ? ` +${ctx.envVars.length - 15} more` : ""}`);
  if (ctx.structure.length > 0) lines.push(`Server files: ${ctx.structure.length}`);
  if (ctx.version) lines.push(`Version: ${ctx.version}`);

  return lines.length > 0 ? "SERVER CONTEXT:\n" + lines.join("\n") : "";
}

function _listFiles(dir, ext) {
  const results = [];
  let count = 0;
  const walk = (d) => {
    if (count > MAX_FILE_SCAN) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (!ext || entry.name.endsWith(ext)) { results.push(full); count++; }
      }
    } catch {}
  };
  walk(dir);
  return results;
}

module.exports = { scan, load, getSummary, CONTEXT_PATH };
