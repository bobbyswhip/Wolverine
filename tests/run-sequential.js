#!/usr/bin/env node

/**
 * Sequential test runner — runs each example one at a time,
 * restores buggy originals from fixtures between tests, and reports.
 */

const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "bin", "wolverine.js");
const FIXTURES = path.join(__dirname, "fixtures");
const TIMEOUT = 75000;

const TESTS = [
  {
    name: "01-basic-typo",
    script: "examples/01-basic-typo.js",
    reset: [{ from: "01-basic-typo.js", to: "examples/01-basic-typo.js" }],
    expectHeal: true,
  },
  {
    name: "02-multi-file",
    script: "examples/02-multi-file/server.js",
    reset: [{ from: "02-multi-file/server.js", to: "examples/02-multi-file/server.js" }],
    expectHeal: true,
  },
  {
    name: "03-syntax-error",
    script: "examples/03-syntax-error.js",
    reset: [{ from: "03-syntax-error.txt", to: "examples/03-syntax-error.js" }],
    expectHeal: true,
  },
  {
    name: "04-secret-leak",
    script: "examples/04-secret-leak.js",
    reset: [{ from: "04-secret-leak.js", to: "examples/04-secret-leak.js" }],
    expectHeal: true,
    expectRedacted: true,
  },
  {
    name: "05-expired-key",
    script: "examples/05-expired-key.js",
    reset: [{ from: "05-expired-key.js", to: "examples/05-expired-key.js" }],
    expectHeal: true,
    expectNotify: true,
  },
  {
    name: "06-json-config",
    script: "examples/06-json-config/server.js",
    reset: [
      { from: "06-json-config/server.js", to: "examples/06-json-config/server.js" },
      { from: "06-json-config/config.json", to: "examples/06-json-config/config.json" },
    ],
    expectHeal: true,
  },
  {
    name: "07-rate-limit",
    script: "examples/07-rate-limit-loop.js",
    reset: [{ from: "07-rate-limit-loop.js", to: "examples/07-rate-limit-loop.js" }],
    expectHeal: false,
    expectRateLimit: true,
  },
  {
    name: "08-sandbox",
    script: "examples/08-sandbox-escape.js",
    reset: [{ from: "08-sandbox-escape.js", to: "examples/08-sandbox-escape.js" }],
    expectHeal: true,
  },
];

function killPorts() {
  try {
    const out = execSync('netstat -ano | findstr ":6968 :6969 :6970" | findstr "LISTENING"', { encoding: "utf-8", timeout: 3000 });
    const pids = new Set();
    for (const line of out.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      if (pid && pid !== process.pid) pids.add(pid);
    }
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /F`, { timeout: 3000 }); } catch {}
    }
  } catch {}
}

function resetFixtures(test) {
  for (const r of test.reset) {
    const src = path.join(FIXTURES, r.from);
    const dst = path.join(ROOT, r.to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function runTest(test) {
  return new Promise((resolve) => {
    killPorts();
    const wolv = path.join(ROOT, ".wolverine");
    if (fs.existsSync(wolv)) fs.rmSync(wolv, { recursive: true, force: true });

    // Restore original buggy files from fixtures
    resetFixtures(test);

    let output = "";
    let settled = false;

    const child = spawn("node", [BIN, test.script], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { output += d.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      finish();
    }, TIMEOUT);

    child.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    });

    function finish() {
      const secret = process.env.TEST_PHRASE;
      const healed = output.includes("healed the error");
      const serverRunning = output.includes("Server on") || output.includes("server on");
      const notified = output.includes("HUMAN ACTION REQUIRED");
      const rateLimited = output.includes("Rate limit") || output.includes("error loop");
      const secretLeaked = secret ? (output.includes(secret) && !output.includes("process.env.TEST_PHRASE")) : false;
      const verified = output.includes("Process booted successfully");
      const backupCreated = output.includes("Backup created");
      const brainLoaded = output.includes("Brain ready");

      let passed = true;
      const notes = [];

      if (test.expectHeal && !healed) { passed = false; notes.push("expected heal"); }
      if (test.expectHeal && healed && !verified) { passed = false; notes.push("healed but not verified"); }
      if (test.expectRedacted && secretLeaked) { passed = false; notes.push("SECRET LEAKED"); }
      if (secretLeaked) { passed = false; notes.push("SECRET LEAKED"); }

      if (healed) notes.push("healed");
      if (serverRunning) notes.push("running");
      if (notified) notes.push("notified");
      if (rateLimited) notes.push("rate-limited");
      if (backupCreated) notes.push("backup");
      if (brainLoaded) notes.push("brain");
      if (verified) notes.push("verified");

      resolve({ passed, notes });
    }
  });
}

async function main() {
  console.log("\n🐺 Wolverine Test Suite\n");
  console.log("═".repeat(80));

  let totalPassed = 0;
  let totalFailed = 0;

  for (const test of TESTS) {
    process.stdout.write(`  ${test.name.padEnd(20)}`);
    const result = await runTest(test);

    const icon = result.passed ? "✅" : "❌";
    console.log(`${icon}  [${result.notes.join(", ")}]`);

    if (result.passed) totalPassed++;
    else totalFailed++;
  }

  console.log("═".repeat(80));

  // Run pentest
  console.log("\n  Running secret redaction pen test...\n");
  const pentest = spawn("node", ["tests/pentest-secrets.js"], { cwd: ROOT, stdio: "inherit" });

  pentest.on("exit", (code) => {
    console.log("═".repeat(80));
    const pentestOk = code === 0;
    if (pentestOk) totalPassed++;
    else totalFailed++;

    console.log(`\n  Results: ${totalPassed}/${totalPassed + totalFailed} passed, ${totalFailed} failed\n`);
    killPorts();
    process.exit(totalFailed > 0 ? 1 : 0);
  });
}

main().catch(console.error);
