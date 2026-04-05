#!/usr/bin/env node

const path = require("path");
const dotenv = require("dotenv");
const chalk = require("chalk");

// Global error handlers — prevent parent process death from unhandled errors
process.on("uncaughtException", (err) => {
  console.error(chalk.red(`\n  ⚠️  Uncaught exception (wolverine survived): ${err.message}`));
  console.error(chalk.gray(`  ${err.stack?.split("\n")[1]?.trim() || ""}`));
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(chalk.red(`\n  ⚠️  Unhandled rejection (wolverine survived): ${msg}`));
});

// Load secrets
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const { loadConfig } = require("../src/core/config");
const { detect, logSystemInfo } = require("../src/core/system-info");
const { logModelConfig } = require("../src/core/models");

const args = process.argv.slice(2);
const config = loadConfig();

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
${chalk.yellow("🐺 Wolverine Node.js")} — Autonomous self-healing server framework

${chalk.bold("Usage:")}
  wolverine <script.js> [options]

${chalk.bold("Options:")}
  --help, -h       Show this help
  --single         Force single-worker mode (no clustering)
  --workers <n>    Force specific worker count
  --info           Show system info and exit
  --init           Scan server/ and build context map (routes, DB, config, deps)
  --x402-info      Show x402 payment configuration

${chalk.bold("Configuration:")}
  server/config/settings.json    Models, telemetry, limits, health checks
  .env.local                     Secrets only (API keys, admin key)

${chalk.bold("Examples:")}
  wolverine server/index.js
  wolverine server/index.js --single
  wolverine server/index.js --workers 4
  wolverine --info
`);
  process.exit(0);
}

// --info: show system info and exit
if (args.includes("--info")) {
  const info = detect();
  console.log(chalk.yellow.bold("\n  🐺 Wolverine — System Info\n"));
  logSystemInfo(info);
  console.log(chalk.gray(`\n  Node: ${info.nodeVersion}`));
  console.log(chalk.gray(`  Hostname: ${info.hostname}`));
  console.log(chalk.gray(`  Disk: ${info.disk.totalGB}GB total, ${info.disk.freeGB}GB free (${info.disk.usedPercent}% used)`));
  console.log(chalk.gray(`  Memory: ${info.memory.totalGB}GB total, ${info.memory.freeGB}GB free (${info.memory.usedPercent}% used)`));
  console.log("");
  process.exit(0);
}

// --init: scan server/ and build context map
// --x402-info: show payment configuration
if (args.includes("--x402-info")) {
  (async () => {
    let payTo = "not configured";
    try {
      const { getWalletAddress } = require("../src/vault/wallet-ops");
      payTo = await getWalletAddress();
    } catch {}
    console.log(chalk.blue("\n  💰 x402 Payment Configuration\n"));
    console.log(chalk.gray(`     Wallet:      ${payTo}`));
    console.log(chalk.gray(`     Network:     Base (eip155:8453)`));
    console.log(chalk.gray(`     Token:       USDC`));
    console.log(chalk.gray(`     Protocol:    x402 (HTTP 402 Payment Required)`));
    console.log(chalk.gray(`     Facilitator: x402.org`));
    console.log(chalk.gray(`\n     Add to any Fastify route:`));
    console.log(chalk.cyan(`       { config: { x402: { price: "$0.10" } } }`));
    console.log(chalk.gray(`\n     Variable pricing (credit purchases):`));
    console.log(chalk.cyan(`       { config: { x402: { variable: true, min: "$1", max: "$10000", priceField: "dollars" } } }\n`));
    process.exit(0);
  })();
  return;
}

if (args.includes("--init")) {
  const { scan } = require("../src/core/server-context");
  console.log(chalk.blue("\n  🔍 Scanning server/ directory...\n"));
  const ctx = scan(process.cwd());
  if (!ctx) {
    console.log(chalk.yellow("  No server/ directory found."));
    process.exit(1);
  }
  console.log(chalk.green(`  ✅ Server context built:`));
  console.log(chalk.gray(`     Routes: ${ctx.routes.reduce((s, r) => s + r.endpoints.length, 0)}`));
  console.log(chalk.gray(`     Middleware: ${ctx.middleware.length}`));
  console.log(chalk.gray(`     Database: ${ctx.database.type || "none"}${ctx.database.tables.length > 0 ? ` (${ctx.database.tables.length} tables)` : ""}`));
  console.log(chalk.gray(`     Env vars: ${ctx.envVars.length}`));
  console.log(chalk.gray(`     Files: ${ctx.structure.length}`));
  console.log(chalk.gray(`     Saved to: .wolverine/server-context.json`));
  if (ctx.warnings && ctx.warnings.length > 0) {
    console.log(chalk.yellow(`\n  ⚠️  Security warnings (${ctx.warnings.length}):`));
    const seen = new Set();
    for (const w of ctx.warnings) {
      const key = `${w.file}:${w.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(chalk.yellow(`     ${w.file}: ${w.label}`));
    }
  } else {
    console.log(chalk.green(`     No security warnings`));
  }
  console.log("");
  process.exit(0);
}

// --update: safe framework update
if (args.includes("--update")) {
  const { safeUpdate } = require("../src/skills/update");
  const dryRun = args.includes("--dry-run");
  const result = safeUpdate(process.cwd(), { dryRun });
  process.exit(result.success ? 0 : 1);
}

// --restore: restore from safe backup
if (args.includes("--restore")) {
  const backupName = args[args.indexOf("--restore") + 1];
  if (!backupName) { console.log("Usage: wolverine --restore <backup-name>"); process.exit(1); }
  const { restoreFromSafeBackup } = require("../src/skills/update");
  const result = restoreFromSafeBackup(process.cwd(), backupName);
  console.log(chalk.green(`  ✅ Restored ${result.restored} files from ${backupName}`));
  process.exit(0);
}

// --backup: create server snapshot
if (args.includes("--backup")) {
  const reason = args[args.indexOf("--backup") + 1] || "manual";
  const { backup } = require("../src/skills/backup");
  backup(process.cwd(), reason);
  process.exit(0);
}

// --list-backups: list all server snapshots
if (args.includes("--list-backups")) {
  const { listBackups } = require("../src/skills/backup");
  listBackups(process.cwd());
  process.exit(0);
}

// --rollback: rollback to specific backup
if (args.includes("--rollback") && !args.includes("--rollback-latest") && !args.includes("--undo-rollback")) {
  const id = args[args.indexOf("--rollback") + 1];
  if (!id) { console.log("Usage: wolverine --rollback <backup-id>"); process.exit(1); }
  const { rollback } = require("../src/skills/backup");
  const result = rollback(process.cwd(), id);
  process.exit(result.success ? 0 : 1);
}

// --rollback-latest: rollback to most recent backup
if (args.includes("--rollback-latest")) {
  const { rollbackLatest } = require("../src/skills/backup");
  const result = rollbackLatest(process.cwd());
  process.exit(result.success ? 0 : 1);
}

// --undo-rollback: undo last rollback
if (args.includes("--undo-rollback")) {
  const { undoRollback } = require("../src/skills/backup");
  const result = undoRollback(process.cwd());
  process.exit(result.success ? 0 : 1);
}

// --backups: list safe backups (update snapshots)
if (args.includes("--backups")) {
  const { listSafeBackups } = require("../src/skills/update");
  const backups = listSafeBackups();
  if (backups.length === 0) { console.log("No safe backups found."); }
  else {
    console.log(chalk.bold("\n  Safe Backups (~/.wolverine-safe-backups/):\n"));
    for (const b of backups) {
      console.log(`  ${b.dir}  v${b.version || "?"}  ${b.fileCount || "?"} files  ${b.iso || ""}`);
    }
    console.log("");
  }
  process.exit(0);
}

const scriptPath = args.find(a => !a.startsWith("--")) || "server/index.js";

// Initialize server/ from template if it doesn't exist (first run)
const { initServer } = require("../src/core/init-server");
initServer(process.cwd(), scriptPath);

// System detection (for analytics + dashboard, NOT for forking)
// Wolverine runs as a single process manager. If users want clustering,
// they handle it inside their server (e.g. @fastify/cluster, pm2 cluster mode).
// Forking workers at the wolverine level causes port conflicts because each
// worker spawns its own child process on the same port.
const systemInfo = detect();

const { WolverineRunner } = require("../src/core/runner");

console.log(chalk.yellow.bold("\n  🐺 Wolverine Node.js — Autonomous Server Agent\n"));
logSystemInfo(systemInfo);
console.log("");

console.log(chalk.bold(`  Models (${config.provider}):`));
logModelConfig(chalk);
console.log("");
console.log(chalk.gray(`  Provider:   ${config.provider}`));
console.log(chalk.gray(`  Script:     ${scriptPath}`));
console.log(chalk.gray(`  Port:       ${config.server.port}`));
console.log(chalk.gray(`  Retries:    ${config.server.maxRetries}`));
console.log(chalk.gray(`  Sandbox:    ${path.resolve(process.cwd())} (locked)`));
console.log(chalk.gray(`  Telemetry:  ${config.telemetry.enabled ? "on" : "off"}`));
console.log("");

const runner = new WolverineRunner(scriptPath, { cwd: process.cwd() });

// Grace period: ignore SIGTERM for 3s after startup.
// Prevents restart scripts using `pkill -f wolverine.js` from killing
// both the old AND newly spawned process.
let startupGrace = true;
setTimeout(() => { startupGrace = false; }, 3000);

process.on("SIGINT", () => {
  console.log(chalk.yellow(`\n\n👋 Shutting down Wolverine...`));
  runner.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (startupGrace) {
    console.log(chalk.yellow("  ⚡ Ignoring SIGTERM during startup grace period (3s)"));
    return;
  }
  runner.stop();
  process.exit(0);
});

runner.start();
