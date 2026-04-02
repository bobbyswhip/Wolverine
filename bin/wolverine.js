#!/usr/bin/env node

const path = require("path");
const dotenv = require("dotenv");
const chalk = require("chalk");

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

const scriptPath = args.find(a => !a.startsWith("--")) || "server/index.js";

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

console.log(chalk.bold("  Models:"));
logModelConfig(chalk);
console.log("");
console.log(chalk.gray(`  Script:     ${scriptPath}`));
console.log(chalk.gray(`  Port:       ${config.server.port}`));
console.log(chalk.gray(`  Retries:    ${config.server.maxRetries}`));
console.log(chalk.gray(`  Sandbox:    ${path.resolve(process.cwd())} (locked)`));
console.log(chalk.gray(`  Telemetry:  ${config.telemetry.enabled ? "on" : "off"}`));
console.log("");

const runner = new WolverineRunner(scriptPath, { cwd: process.cwd() });

process.on("SIGINT", () => {
  console.log(chalk.yellow(`\n\n👋 Shutting down Wolverine${workerLabel}...`));
  runner.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  runner.stop();
  process.exit(0);
});

runner.start();
