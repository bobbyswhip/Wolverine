const fs = require("fs");
const path = require("path");

const BREAKABLE = path.join(__dirname, "breakable.js");
const DEMO_DB = path.join(__dirname, "..", "data", "demo.db");

const CLEAN_BREAKABLE = 'let counter = 0;\n\nmodule.exports = function handler() {\n  counter++;\n  return { message: "Process running", counter, pid: process.pid, timestamp: new Date().toISOString() };\n};\n';

if (!fs.existsSync(BREAKABLE)) fs.writeFileSync(BREAKABLE, CLEAN_BREAKABLE);

async function routes(fastify) {

  fastify.get("/", async () => {
    const code = fs.existsSync(BREAKABLE) ? fs.readFileSync(BREAKABLE, "utf8") : "";
    const hasDemoDB = fs.existsSync(DEMO_DB);
    return {
      demos: [
        { id: "crash", name: "TypeError Crash", description: "Inject undefined.name bug — caught 500, healed via fast path", broken: code.includes("INTENTIONAL_BUG") || code.includes("user.name") },
        { id: "sql", name: "Bad SQL Data", description: "Script crashes on NaN from DB — agent traces to database and fixes data", ready: hasDemoDB },
        { id: "missing-module", name: "Wrong Import Path", description: "Wrong require path — fast path fixes the import (zero npm install needed)" },
        { id: "syntax", name: "Syntax Error", description: "Broken template literal — caught at runtime, fast path patches it" },
        { id: "env", name: "Missing Config", description: "Config file missing a required field — agent creates/fixes the config" },
      ],
      route: "/breakable",
    };
  });

  // ── Demo 1: TypeError Crash ──
  fastify.post("/break", async () => {
    const buggy = 'let counter = 0;\n\nmodule.exports = function handler() {\n  counter++;\n  // INTENTIONAL_BUG: TypeError on undefined\n  const user = undefined;\n  return { message: "Process running", counter, name: user.name, pid: process.pid };\n};\n';
    fs.writeFileSync(BREAKABLE, buggy);
    return { demo: "crash", broken: true, message: "TypeError bug injected. Hit /breakable to trigger." };
  });

  // ── Demo 2: Bad SQL Data ──
  fastify.post("/break-sql", async () => {
    try {
      fs.mkdirSync(path.join(__dirname, "..", "data"), { recursive: true });
      let Database;
      try { Database = require("better-sqlite3"); } catch {
        return { demo: "sql", error: "better-sqlite3 not installed" };
      }
      const db = new Database(DEMO_DB);
      db.exec("DROP TABLE IF EXISTS users");
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, age TEXT, role TEXT DEFAULT 'user')");
      db.exec("INSERT INTO users (name, email, age, role) VALUES ('Alice', 'alice@example.com', '30', 'admin')");
      db.exec("INSERT INTO users (name, email, age, role) VALUES ('Bob', 'bob@example.com', 'not_a_number', 'user')");
      db.exec("INSERT INTO users (name, email, age, role) VALUES ('Charlie', 'charlie@test.com', '25', 'editor')");
      db.close();

      const sqlBug = [
        'const path = require("path");',
        'module.exports = function handler() {',
        '  let Database;',
        '  try { Database = require("better-sqlite3"); } catch { return { error: "better-sqlite3 not installed" }; }',
        '  const dbPath = path.join(__dirname, "..", "data", "demo.db");',
        '  const db = new Database(dbPath, { readonly: true });',
        '  const users = db.prepare("SELECT * FROM users").all();',
        '  db.close();',
        '  let totalAge = 0;',
        '  for (const user of users) {',
        '    const age = parseInt(user.age, 10);',
        '    if (isNaN(age)) {',
        '      throw new TypeError("Cannot calculate stats: user \'" + user.name + "\' has invalid age \'" + user.age + "\' in database " + dbPath + ". Expected integer, got string.");',
        '    }',
        '    totalAge += age;',
        '  }',
        '  return { users: users.length, averageAge: totalAge / users.length, status: "healthy" };',
        '};',
      ].join("\n") + "\n";
      fs.writeFileSync(BREAKABLE, sqlBug);
      return { demo: "sql", broken: true, message: "Bad data injected (age='not_a_number'). Agent must fix DB, not code." };
    } catch (e) {
      return { demo: "sql", error: e.message };
    }
  });

  // ── Demo 3: Wrong Import Path ──
  // Uses a wrong relative path — fixable by editing the require statement.
  // Does NOT crash the process (caught by error handler), just returns 500.
  fastify.post("/break-module", async () => {
    const moduleBug = [
      'module.exports = function handler() {',
      '  // INTENTIONAL_BUG: wrong import path (should be ./health not ./healht)',
      '  const health = require("./healht");',
      '  return { status: health(), pid: process.pid };',
      '};',
    ].join("\n") + "\n";
    fs.writeFileSync(BREAKABLE, moduleBug);
    return { demo: "missing-module", broken: true, message: "Wrong import path injected (./healht instead of ./health). Fast path will fix the require." };
  });

  // ── Demo 4: Syntax Error (runtime, not load-time) ──
  // Bad string operation at runtime — doesn't crash on require, crashes on call.
  fastify.post("/break-syntax", async () => {
    const syntaxBug = [
      'let counter = 0;',
      '',
      'module.exports = function handler() {',
      '  counter++;',
      '  // INTENTIONAL_BUG: calling .split on a number (TypeError at runtime)',
      '  const port = 3000;',
      '  const parts = port.split(":");',
      '  return { message: "Process running", counter, parts, pid: process.pid };',
      '};',
    ].join("\n") + "\n";
    fs.writeFileSync(BREAKABLE, syntaxBug);
    return { demo: "syntax", broken: true, message: "Type error injected (calling .split on number). Fast path will fix it." };
  });

  // ── Demo 5: Missing Config File ──
  // Script reads a config file that doesn't exist. Agent needs to create it.
  fastify.post("/break-env", async () => {
    // Delete the config file if it exists
    const configPath = path.join(__dirname, "..", "data", "app-config.json");
    try { fs.unlinkSync(configPath); } catch {}

    const envBug = [
      'const fs = require("fs");',
      'const path = require("path");',
      'module.exports = function handler() {',
      '  // Reads required config file',
      '  const configPath = path.join(__dirname, "..", "data", "app-config.json");',
      '  if (!fs.existsSync(configPath)) {',
      '    throw new Error("Missing required config file: " + configPath + ". Expected JSON with { apiUrl, timeout } fields.");',
      '  }',
      '  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));',
      '  if (!config.apiUrl) throw new Error("Config missing required field: apiUrl");',
      '  return { config, pid: process.pid };',
      '};',
    ].join("\n") + "\n";
    fs.writeFileSync(BREAKABLE, envBug);
    return { demo: "env", broken: true, message: "Config file deleted. Script expects app-config.json — agent must create it." };
  });

  // ── Repair Cost ──
  fastify.get("/cost", async () => {
    try {
      const usagePath = path.join(__dirname, "..", "..", ".wolverine", "usage.json");
      const repairPath = path.join(__dirname, "..", "..", ".wolverine", "repair-history.json");
      const usage = JSON.parse(fs.readFileSync(usagePath, "utf-8"));
      let lastRepair = null;
      try {
        const repairs = JSON.parse(fs.readFileSync(repairPath, "utf-8"));
        if (repairs.length > 0) lastRepair = repairs[repairs.length - 1];
      } catch {}
      return {
        totalCost: Math.round((usage.totalCostUsd || 0) * 10000) / 10000,
        totalTokens: usage.totalTokens || 0,
        totalCalls: usage.totalCalls || 0,
        lastRepair: lastRepair ? {
          tokens: lastRepair.tokens || 0,
          cost: Math.round((lastRepair.cost || 0) * 1000000) / 1000000,
          model: lastRepair.model || "unknown",
          mode: lastRepair.mode || "unknown",
          success: lastRepair.success,
          duration: lastRepair.duration || 0,
          error: (lastRepair.error || "").slice(0, 80),
        } : null,
      };
    } catch { return { totalCost: 0, totalTokens: 0, lastRepair: null }; }
  });

  // ── Reset All ──
  fastify.post("/reset", async () => {
    fs.writeFileSync(BREAKABLE, CLEAN_BREAKABLE);
    try { fs.unlinkSync(DEMO_DB); } catch {}
    try { fs.unlinkSync(path.join(__dirname, "..", "data", "app-config.json")); } catch {}
    return { broken: false, message: "All demos reset to clean state." };
  });
}
module.exports = routes;
