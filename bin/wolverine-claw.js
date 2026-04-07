#!/usr/bin/env node

const path = require("path");
const dotenv = require("dotenv");
const chalk = require("chalk");

// Global error handlers — prevent parent process death
process.on("uncaughtException", (err) => {
  console.error(chalk.red(`\n  ⚠️  Uncaught exception (wolverine-claw survived): ${err.message}`));
  console.error(chalk.gray(`  ${err.stack?.split("\n")[1]?.trim() || ""}`));
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(chalk.red(`\n  ⚠️  Unhandled rejection (wolverine-claw survived): ${msg}`));
});

// Load secrets
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const args = process.argv.slice(2);
const fs = require("fs");

// --help
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
${chalk.blue("🐾 Wolverine Claw")} — Agentic AI agent with self-healing

${chalk.bold("Usage:")}
  wolverine-claw [options]

${chalk.bold("Options:")}
  --help, -h       Show this help
  --setup          Full guided setup (detects OpenClaw, merges config, validates)
  --setup --dry    Preview setup without making changes
  --info           Show claw configuration and status
  --init           Initialize wolverine-claw/ directory (first run)
  --direct         Run claw directly without wolverine healing wrapper

${chalk.bold("Configuration:")}
  wolverine-claw/config/settings.json    Gateway, channels, agent, healing
  .env.local                             Secrets (API keys)

${chalk.bold("Examples:")}
  wolverine-claw --setup          Full guided onboarding
  wolverine-claw                  Start with self-healing
  wolverine-claw --direct         Start without healing (debugging)
  wolverine-claw --info           Show configuration
`);
  process.exit(0);
}

// --setup: full guided setup
if (args.includes("--setup")) {
  const { setup } = require("../src/claw/setup");
  const dryRun = args.includes("--dry") || args.includes("--dry-run");
  const force = args.includes("--force");

  (async () => {
    const result = await setup(process.cwd(), { dryRun, force });
    process.exit(result.success ? 0 : 1);
  })();
  return;
}

// --init: scaffold wolverine-claw directory if missing
if (args.includes("--init")) {
  const clawDir = path.resolve(process.cwd(), "wolverine-claw");

  if (fs.existsSync(path.join(clawDir, "index.js"))) {
    console.log(chalk.green("\n  ✅ wolverine-claw/ already exists.\n"));
    process.exit(0);
  }

  console.log(chalk.blue("\n  🐾 Initializing wolverine-claw/ ...\n"));

  // Copy from templates if available, otherwise the files should already exist
  const dirs = ["config", "plugins", "workspace"];
  for (const d of dirs) {
    const dirPath = path.join(clawDir, d);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(chalk.gray(`  Created: wolverine-claw/${d}/`));
    }
  }

  console.log(chalk.green("\n  ✅ wolverine-claw/ initialized."));
  console.log(chalk.gray("  Edit wolverine-claw/config/settings.json to configure.\n"));
  process.exit(0);
}

// --info: show claw config and status
if (args.includes("--info")) {
  const configPath = path.resolve(process.cwd(), "wolverine-claw", "config", "settings.json");

  if (!fs.existsSync(configPath)) {
    console.log(chalk.yellow("\n  ⚠️  wolverine-claw/ not found. Run: wolverine-claw --init\n"));
    process.exit(1);
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const gw = config.gateway || {};
    const agent = config.agent || {};
    const channels = config.channels || {};
    const healing = config.healing || {};

    console.log(chalk.blue.bold("\n  🐾 Wolverine Claw — Configuration\n"));
    console.log(chalk.gray(`  Gateway:      ws://${gw.host || "127.0.0.1"}:${gw.port || 18789}`));
    console.log(chalk.gray(`  Agent model:  ${agent.model || "claude-sonnet-4-6"}`));
    console.log(chalk.gray(`  Max turns:    ${agent.maxTurns || 25}`));
    console.log(chalk.gray(`  Healing:      ${healing.enabled !== false ? "enabled" : "disabled"}`));
    console.log(chalk.gray(`  Max heals:    ${healing.maxHealsPerWindow || 5} per ${Math.round((healing.windowMs || 300000) / 60000)}min`));

    const enabledChannels = Object.entries(channels)
      .filter(([k, v]) => !k.startsWith("_") && v.enabled)
      .map(([k]) => k);
    console.log(chalk.gray(`  Channels:     ${enabledChannels.length > 0 ? enabledChannels.join(", ") : "terminal only"}`));

    // Check for API keys
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    console.log(chalk.gray(`  OpenAI key:   ${hasOpenAI ? "set" : "missing"}`));
    console.log(chalk.gray(`  Anthropic:    ${hasAnthropic ? "set" : "missing"}`));

    // Check openclaw installation
    let openclawVersion = "not installed";
    try {
      const pkg = require("openclaw/package.json");
      openclawVersion = pkg.version;
    } catch {
      try {
        const { execSync } = require("child_process");
        const ver = execSync("npx openclaw --version 2>/dev/null", { encoding: "utf-8" }).trim();
        openclawVersion = ver || "available via npx";
      } catch {
        openclawVersion = "not installed (will use npx)";
      }
    }
    console.log(chalk.gray(`  OpenClaw:     ${openclawVersion}`));
    console.log("");
  } catch (err) {
    console.error(chalk.red(`  Config error: ${err.message}\n`));
    process.exit(1);
  }
  process.exit(0);
}

// --direct: run without wolverine healing wrapper
if (args.includes("--direct")) {
  console.log(chalk.blue("\n  🐾 Starting Wolverine Claw (direct mode — no healing)\n"));
  require("../wolverine-claw/index");
  return;
}

// Default: start with wolverine self-healing
const { ClawRunner } = require("../src/claw/claw-runner");

console.log(chalk.blue.bold("\n  🐾 Wolverine Claw — Starting with Self-Healing\n"));

const runner = new ClawRunner({ cwd: process.cwd() });

// Grace period: ignore SIGTERM for 3s after startup
let startupGrace = true;
setTimeout(() => { startupGrace = false; }, 3000);

process.on("SIGINT", () => {
  console.log(chalk.blue("\n\n  👋 Shutting down Wolverine Claw..."));
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
