#!/usr/bin/env node

const path = require("path");
const dotenv = require("dotenv");
const chalk = require("chalk");

// Load .env.local first, then .env
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const { WolverineRunner } = require("../src/core/runner");
const { logModelConfig } = require("../src/core/models");

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`
${chalk.yellow("🐺 Wolverine Node.js")} — Self-healing Node.js backend

${chalk.bold("Usage:")}
  wolverine <script.js> [options]

${chalk.bold("Options:")}
  --help, -h     Show this help message

${chalk.bold("Model Configuration (in .env.local):")}
  REASONING_MODEL    Deep analysis, complex debugging      (default: gpt-4o)
  CODING_MODEL       Code repair generation                (default: gpt-4o)
  CHAT_MODEL         Explanations, summaries               (default: gpt-4o-mini)
  AUDIT_MODEL        Security scans, injection detection   (default: gpt-4o-mini)
  UTILITY_MODEL      JSON formatting, simple tasks         (default: gpt-4o-mini)

${chalk.bold("Other Environment Variables:")}
  OPENAI_API_KEY                Your OpenAI API key (required)
  WOLVERINE_MAX_RETRIES         Max repair attempts (default: 3)
  WOLVERINE_RATE_MAX_CALLS      Max API calls per window (default: 10)
  WOLVERINE_RATE_WINDOW_MS      Rate limit window in ms (default: 600000)
  WOLVERINE_RATE_MIN_GAP_MS     Min gap between API calls (default: 5000)
  WOLVERINE_RATE_MAX_TOKENS_HOUR  Max tokens per hour (default: 100000)

${chalk.bold("Examples:")}
  wolverine server.js
  wolverine examples/buggy-server.js
  node bin/wolverine.js examples/buggy-server.js
`);
  process.exit(0);
}

const scriptPath = args[0];

console.log(chalk.yellow.bold("\n  🐺 Wolverine Node.js — Autonomous Server Agent v3\n"));
console.log(chalk.bold("  Models:"));
logModelConfig(chalk);
console.log("");
console.log(chalk.gray(`  Retries:    ${process.env.WOLVERINE_MAX_RETRIES || 3}`));
console.log(chalk.gray(`  Script:     ${scriptPath}`));
console.log(chalk.gray(`  Sandbox:    ${path.resolve(process.cwd())} (locked)`));
console.log(chalk.gray(`  Rate limit: ${process.env.WOLVERINE_RATE_MAX_CALLS || 10} calls / ${(parseInt(process.env.WOLVERINE_RATE_WINDOW_MS, 10) || 600000) / 1000}s`));
console.log(chalk.gray(`  Security:   sandbox + AI injection audit (every error) + rate limiting`));
console.log(chalk.gray(`  Backups:    .wolverine/backups/ (auto-managed)`));
console.log(chalk.gray(`  Agent:      multi-file repair with tool use (escalation from fast path)`));
console.log(chalk.gray(`  Logging:    .wolverine/events/ (persistent JSONL)`));
console.log(chalk.gray(`  Dashboard:  http://localhost:${parseInt(process.env.WOLVERINE_DASHBOARD_PORT, 10) || (parseInt(process.env.PORT, 10) || 3000) + 1}\n`));

const runner = new WolverineRunner(scriptPath, {
  cwd: process.cwd(),
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log(chalk.yellow("\n\n👋 Shutting down Wolverine..."));
  runner.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  runner.stop();
  process.exit(0);
});

runner.start();
