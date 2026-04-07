/**
 * Wolverine Claw Setup — Onboarding for OpenClaw users.
 *
 * Detects an existing OpenClaw installation, reads its config, merges with
 * wolverine defaults, scaffolds wolverine-claw/, validates the environment,
 * and produces a ready-to-run dev setup.
 *
 * Run via:
 *   wolverine-claw --setup
 *   wolverine --setup-claw
 *   npx wolverine-ai --setup-claw
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const chalk = require("chalk");
const os = require("os");

// ── Detection ────────────────────────────────────────────────────

/**
 * Detect environment: Node version, OpenClaw installation, API keys, OS.
 */
function detectEnvironment(cwd) {
  const env = {
    node: {
      version: process.version,
      major: parseInt(process.version.slice(1), 10),
      ok: parseInt(process.version.slice(1), 10) >= 22,
    },
    os: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
    },
    openclaw: detectOpenClaw(cwd),
    keys: detectApiKeys(),
    wolverine: detectWolverine(cwd),
    existingClaw: fs.existsSync(path.join(cwd, "wolverine-claw", "index.js")),
  };

  return env;
}

/**
 * Find OpenClaw installation — checks npm, global, config file.
 */
function detectOpenClaw(cwd) {
  const result = {
    found: false,
    source: null,
    version: null,
    configPath: null,
    config: null,
    globalInstall: false,
    localInstall: false,
  };

  // 1. Check local node_modules
  try {
    const pkgPath = require.resolve("openclaw/package.json", { paths: [cwd] });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    result.found = true;
    result.localInstall = true;
    result.version = pkg.version;
    result.source = "npm (local)";
  } catch {}

  // 2. Check global install
  if (!result.found) {
    try {
      const ver = execSync("npx --yes openclaw --version 2>/dev/null", {
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (ver && /\d+\.\d+/.test(ver)) {
        result.found = true;
        result.globalInstall = true;
        result.version = ver;
        result.source = "npm (global/npx)";
      }
    } catch {}
  }

  // 3. Check package.json for openclaw dependency
  if (!result.found) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
      if (deps.openclaw) {
        result.found = true;
        result.source = "package.json (not installed yet)";
        result.version = deps.openclaw;
      }
    } catch {}
  }

  // 4. Look for OpenClaw config file
  const configLocations = [
    path.join(os.homedir(), ".openclaw", "config.yml"),
    path.join(os.homedir(), ".openclaw", "config.yaml"),
    path.join(cwd, ".openclaw", "config.yml"),
    path.join(cwd, "openclaw.yml"),
    path.join(cwd, "openclaw.yaml"),
    path.join(cwd, ".openclaw.yml"),
  ];

  for (const loc of configLocations) {
    if (fs.existsSync(loc)) {
      result.configPath = loc;
      result.config = parseOpenClawConfig(loc);
      if (!result.found) {
        result.found = true;
        result.source = `config file (${path.basename(loc)})`;
      }
      break;
    }
  }

  return result;
}

/**
 * Parse OpenClaw config YAML (simple line-based parser, no dep needed).
 */
function parseOpenClawConfig(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const config = {};
    let currentSection = null;
    let currentSubsection = null;

    for (const line of raw.split("\n")) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Top-level key (no indent)
      const topMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)?$/);
      if (topMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
        currentSection = topMatch[1];
        currentSubsection = null;
        const val = topMatch[2]?.trim();
        if (val && val !== "") {
          config[currentSection] = parseYamlValue(val);
        } else {
          config[currentSection] = {};
        }
        continue;
      }

      // Second-level key (2-space indent)
      const subMatch = trimmed.match(/^\s{2}(\w[\w-]*):\s*(.*)?$/);
      if (subMatch && currentSection) {
        if (typeof config[currentSection] !== "object") config[currentSection] = {};
        const key = subMatch[1];
        const val = subMatch[2]?.trim();
        if (val && val !== "") {
          config[currentSection][key] = parseYamlValue(val);
        } else {
          config[currentSection][key] = {};
          currentSubsection = key;
        }
        continue;
      }

      // Third-level key (4-space indent)
      const deepMatch = trimmed.match(/^\s{4}(\w[\w-]*):\s*(.*)?$/);
      if (deepMatch && currentSection && currentSubsection) {
        if (typeof config[currentSection][currentSubsection] !== "object") {
          config[currentSection][currentSubsection] = {};
        }
        config[currentSection][currentSubsection][deepMatch[1]] = parseYamlValue(deepMatch[2]?.trim() || "");
      }
    }

    return config;
  } catch {
    return null;
  }
}

function parseYamlValue(val) {
  if (!val || val === "") return "";
  if (val === "true") return true;
  if (val === "false") return false;
  if (/^\d+$/.test(val)) return parseInt(val, 10);
  if (/^\d+\.\d+$/.test(val)) return parseFloat(val);
  // Strip quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  // Array
  if (val.startsWith("[") && val.endsWith("]")) {
    try { return JSON.parse(val); } catch {}
    return val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
  }
  return val;
}

/**
 * Detect API keys from environment and .env files.
 */
function detectApiKeys() {
  const keys = {
    OPENAI_API_KEY: { set: false, source: null },
    ANTHROPIC_API_KEY: { set: false, source: null },
    WOLVERINE_API_KEY: { set: false, source: null },
    WOLVERINE_ADMIN_KEY: { set: false, source: null },
  };

  // Check process.env (already loaded from dotenv)
  for (const key of Object.keys(keys)) {
    if (process.env[key]) {
      keys[key].set = true;
      keys[key].source = "environment";
    }
  }

  // Check .env.local if not already loaded
  const envLocalPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envLocalPath)) {
    try {
      const envContent = fs.readFileSync(envLocalPath, "utf-8");
      for (const key of Object.keys(keys)) {
        const match = envContent.match(new RegExp(`^${key}=(.+)$`, "m"));
        if (match && match[1].trim()) {
          keys[key].set = true;
          keys[key].source = keys[key].source || ".env.local";
        }
      }
    } catch {}
  }

  return keys;
}

/**
 * Detect existing wolverine installation.
 */
function detectWolverine(cwd) {
  const result = {
    installed: false,
    version: null,
    serverExists: fs.existsSync(path.join(cwd, "server", "index.js")),
    brainExists: fs.existsSync(path.join(cwd, ".wolverine", "brain")),
  };

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
    if (pkg.name === "wolverine-ai" || pkg.dependencies?.["wolverine-ai"]) {
      result.installed = true;
      result.version = pkg.version || pkg.dependencies?.["wolverine-ai"];
    }
    // Also check if we're inside the wolverine repo itself
    if (fs.existsSync(path.join(cwd, "src", "core", "wolverine.js"))) {
      result.installed = true;
      result.version = pkg.version;
    }
  } catch {}

  return result;
}

// ── Config Merge ────────────────────────────────────────────────

/**
 * Merge OpenClaw config with wolverine-claw defaults.
 * OpenClaw values take precedence where they exist.
 */
function mergeConfig(openclawConfig, defaults) {
  const merged = JSON.parse(JSON.stringify(defaults));

  if (!openclawConfig) return merged;

  // Gateway
  if (openclawConfig.gateway) {
    if (openclawConfig.gateway.port) merged.gateway.port = openclawConfig.gateway.port;
    if (openclawConfig.gateway.host) merged.gateway.host = openclawConfig.gateway.host;
  }

  // Agent / model
  if (openclawConfig.agent) {
    if (openclawConfig.agent.model) merged.agent.model = openclawConfig.agent.model;
    if (openclawConfig.agent.maxTurns) merged.agent.maxTurns = openclawConfig.agent.maxTurns;
  }

  // Models — if openclaw specifies a model, use it across all roles
  if (openclawConfig.model) {
    merged.agent.model = openclawConfig.model;
    merged.models.reasoning = openclawConfig.model;
    merged.models.coding = openclawConfig.model;
    merged.models.chat = openclawConfig.model;
  }

  // Channels — merge any configured channels
  if (openclawConfig.channels && typeof openclawConfig.channels === "object") {
    for (const [name, cfg] of Object.entries(openclawConfig.channels)) {
      if (typeof cfg !== "object") continue;
      if (merged.channels[name]) {
        merged.channels[name] = { ...merged.channels[name], ...cfg, enabled: true };
      } else {
        merged.channels[name] = { enabled: true, ...cfg };
      }
    }
  }

  // Skills
  if (openclawConfig.skills && typeof openclawConfig.skills === "object") {
    for (const [name, cfg] of Object.entries(openclawConfig.skills)) {
      if (typeof cfg === "object") {
        merged.skills[name] = { ...merged.skills[name], ...cfg };
      }
    }
  }

  // Security
  if (openclawConfig.security && typeof openclawConfig.security === "object") {
    merged.security = { ...merged.security, ...openclawConfig.security };
  }

  return merged;
}

// ── Scaffolding ─────────────────────────────────────────────────

/**
 * Scaffold the wolverine-claw directory from template + merged config.
 */
function scaffold(cwd, mergedConfig, env) {
  const clawDir = path.join(cwd, "wolverine-claw");
  const results = { created: [], skipped: [], errors: [] };

  // Create directories
  const dirs = ["config", "plugins", "workspace", "skills"];
  for (const d of dirs) {
    const dirPath = path.join(clawDir, d);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      results.created.push(`wolverine-claw/${d}/`);
    }
  }

  // Write config/settings.json (never overwrite if exists)
  const configPath = path.join(clawDir, "config", "settings.json");
  if (fs.existsSync(configPath)) {
    results.skipped.push("config/settings.json (already exists)");
  } else {
    fs.writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2) + "\n");
    results.created.push("config/settings.json");
  }

  // Copy index.js from template
  const indexSrc = path.join(cwd, "wolverine-claw", "index.js");
  if (!fs.existsSync(indexSrc)) {
    // Copy from our built-in template
    const templateIndex = path.join(__dirname, "..", "..", "wolverine-claw", "index.js");
    if (fs.existsSync(templateIndex)) {
      fs.copyFileSync(templateIndex, indexSrc);
      results.created.push("index.js");
    }
  } else {
    results.skipped.push("index.js (already exists)");
  }

  // Copy plugin
  const pluginDest = path.join(clawDir, "plugins", "wolverine-integration.js");
  if (!fs.existsSync(pluginDest)) {
    const pluginSrc = path.join(cwd, "wolverine-claw", "plugins", "wolverine-integration.js");
    if (fs.existsSync(pluginSrc)) {
      results.skipped.push("plugins/wolverine-integration.js (already exists at source)");
    } else {
      const templatePlugin = path.join(__dirname, "..", "..", "wolverine-claw", "plugins", "wolverine-integration.js");
      if (fs.existsSync(templatePlugin)) {
        fs.copyFileSync(templatePlugin, pluginDest);
        results.created.push("plugins/wolverine-integration.js");
      }
    }
  } else {
    results.skipped.push("plugins/wolverine-integration.js (already exists)");
  }

  // Create workspace/.gitkeep
  const gitkeep = path.join(clawDir, "workspace", ".gitkeep");
  if (!fs.existsSync(gitkeep)) {
    fs.writeFileSync(gitkeep, "");
    results.created.push("workspace/.gitkeep");
  }

  // Create .gitignore for workspace (agent-generated files shouldn't pollute git)
  const wsGitignore = path.join(clawDir, "workspace", ".gitignore");
  if (!fs.existsSync(wsGitignore)) {
    fs.writeFileSync(wsGitignore, [
      "# Wolverine Claw workspace — agent-generated files",
      "# Keep .gitkeep but ignore everything else",
      "*",
      "!.gitkeep",
      "!.gitignore",
      "",
    ].join("\n"));
    results.created.push("workspace/.gitignore");
  }

  // Create skills/.gitkeep for custom user skills
  const skillsGitkeep = path.join(clawDir, "skills", ".gitkeep");
  if (!fs.existsSync(skillsGitkeep)) {
    fs.writeFileSync(skillsGitkeep, "");
    results.created.push("skills/.gitkeep");
  }

  return results;
}

// ── Environment Setup ───────────────────────────────────────────

/**
 * Ensure .env.local exists with required keys for claw.
 */
function ensureEnvFile(cwd, env) {
  const envPath = path.join(cwd, ".env.local");
  const result = { created: false, keysAdded: [] };

  if (fs.existsSync(envPath)) {
    // Check if claw-specific keys need to be appended
    const content = fs.readFileSync(envPath, "utf-8");
    const clawKeys = [];

    if (!content.includes("OPENCLAW_")) {
      clawKeys.push("");
      clawKeys.push("# ── Wolverine Claw (OpenClaw Integration) ───────────────────────");
      clawKeys.push("# Channel tokens — add these if you enable messaging channels");
      clawKeys.push("# DISCORD_BOT_TOKEN=");
      clawKeys.push("# SLACK_BOT_TOKEN=");
      clawKeys.push("# SLACK_APP_TOKEN=");
      clawKeys.push("# TELEGRAM_BOT_TOKEN=");
    }

    if (clawKeys.length > 0) {
      fs.appendFileSync(envPath, clawKeys.join("\n") + "\n");
      result.keysAdded = clawKeys.filter(k => k.startsWith("# ") && k.includes("="));
    }
  } else {
    // Create fresh .env.local
    const lines = [
      "# Wolverine + Claw — Secrets Only",
      "# All other settings in wolverine-claw/config/settings.json",
      "",
      "# ── AI API Keys (at least one required) ──────────────────────────",
      "OPENAI_API_KEY=",
      "ANTHROPIC_API_KEY=",
      "",
      "# ── Dashboard Admin Key ──────────────────────────────────────────",
      "WOLVERINE_ADMIN_KEY=",
      "",
      "# ── Wolverine Platform (optional) ────────────────────────────────",
      "WOLVERINE_API_KEY=",
      "",
      "# ── Wolverine Claw (OpenClaw Integration) ───────────────────────",
      "# Channel tokens — add these if you enable messaging channels",
      "# DISCORD_BOT_TOKEN=",
      "# SLACK_BOT_TOKEN=",
      "# SLACK_APP_TOKEN=",
      "# TELEGRAM_BOT_TOKEN=",
      "",
    ];
    fs.writeFileSync(envPath, lines.join("\n"));
    result.created = true;
  }

  return result;
}

/**
 * Ensure openclaw is installed as a dependency.
 */
function ensureOpenClawDep(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return { installed: false, reason: "no package.json" };

  try {
    // Check if already resolvable
    require.resolve("openclaw", { paths: [cwd] });
    return { installed: true, alreadyPresent: true };
  } catch {}

  // Try npm install
  try {
    console.log(chalk.gray("  Installing openclaw..."));
    execSync("npm install openclaw --save-optional 2>&1", {
      cwd,
      encoding: "utf-8",
      timeout: 120000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { installed: true, alreadyPresent: false };
  } catch (err) {
    return {
      installed: false,
      reason: `npm install failed: ${err.message?.split("\n")[0] || "unknown"}`,
      fallback: "Will use npx openclaw (downloads on first run)",
    };
  }
}

// ── Validation ──────────────────────────────────────────────────

/**
 * Validate the setup is complete and functional.
 */
function validate(cwd, env) {
  const checks = [];

  // Node version — not critical since standalone agent works on Node 20+
  const nodeMinOk = env.node.major >= 20;
  checks.push({
    name: "Node.js",
    pass: nodeMinOk,
    detail: env.node.ok
      ? `${env.node.version} (full OpenClaw support)`
      : nodeMinOk
        ? `${env.node.version} (standalone agent mode — upgrade to 22+ for OpenClaw)`
        : `${env.node.version} (need >= 20)`,
    critical: !nodeMinOk,
  });

  // OpenClaw available
  checks.push({
    name: "OpenClaw",
    pass: env.openclaw.found,
    detail: env.openclaw.found
      ? `${env.openclaw.version || "found"} (${env.openclaw.source})`
      : "not found — will install or use npx",
    critical: false,
  });

  // API keys
  const hasAnyKey = env.keys.ANTHROPIC_API_KEY.set || env.keys.OPENAI_API_KEY.set || env.keys.WOLVERINE_API_KEY.set;
  checks.push({
    name: "AI API key",
    pass: hasAnyKey,
    detail: hasAnyKey
      ? [
          env.keys.ANTHROPIC_API_KEY.set && "Anthropic",
          env.keys.OPENAI_API_KEY.set && "OpenAI",
          env.keys.WOLVERINE_API_KEY.set && "Wolverine",
        ].filter(Boolean).join(" + ")
      : "none set — add to .env.local",
    critical: false,
  });

  // Config file
  const configExists = fs.existsSync(path.join(cwd, "wolverine-claw", "config", "settings.json"));
  checks.push({
    name: "Claw config",
    pass: configExists,
    detail: configExists ? "wolverine-claw/config/settings.json" : "missing",
    critical: true,
  });

  // Entry point
  const indexExists = fs.existsSync(path.join(cwd, "wolverine-claw", "index.js"));
  checks.push({
    name: "Entry point",
    pass: indexExists,
    detail: indexExists ? "wolverine-claw/index.js" : "missing",
    critical: true,
  });

  // Plugin
  const pluginExists = fs.existsSync(path.join(cwd, "wolverine-claw", "plugins", "wolverine-integration.js"));
  checks.push({
    name: "Wolverine plugin",
    pass: pluginExists,
    detail: pluginExists ? "wolverine-claw/plugins/wolverine-integration.js" : "missing",
    critical: false,
  });

  // Wolverine core
  checks.push({
    name: "Wolverine core",
    pass: env.wolverine.installed,
    detail: env.wolverine.installed
      ? `v${env.wolverine.version || "?"}`
      : "not detected",
    critical: true,
  });

  return checks;
}

// ── Main Setup Flow ─────────────────────────────────────────────

/**
 * Run the full setup flow. Returns a result object.
 */
async function setup(cwd, options = {}) {
  const quiet = options.quiet || false;
  const dryRun = options.dryRun || false;
  const forceReinstall = options.force || false;

  const log = quiet ? () => {} : (...a) => console.log(...a);
  const LINE = "━".repeat(52);

  log(chalk.blue.bold("\n  🐾 Wolverine Claw — Setup"));
  log(chalk.blue(`  ${LINE}\n`));

  // ── Step 1: Detect environment ──────────────────────────────
  log(chalk.bold("  Detecting environment...\n"));

  const env = detectEnvironment(cwd);

  // Node
  const nodeIcon = env.node.ok ? chalk.green("  ✅") : chalk.red("  ❌");
  log(`${nodeIcon} Node.js ${env.node.version}${env.node.ok ? "" : " (need >= 22)"}`);

  // OS
  log(chalk.gray(`     ${env.os.platform}/${env.os.arch} — ${env.os.hostname}`));

  // OpenClaw
  if (env.openclaw.found) {
    log(chalk.green(`  ✅ OpenClaw ${env.openclaw.version || "detected"} (${env.openclaw.source})`));
    if (env.openclaw.configPath) {
      log(chalk.gray(`     Config: ${env.openclaw.configPath}`));
    }
  } else {
    log(chalk.yellow(`  ⚠️  OpenClaw not found — will install as dependency`));
  }

  // Wolverine
  if (env.wolverine.installed) {
    log(chalk.green(`  ✅ Wolverine v${env.wolverine.version || "?"}`));
  } else {
    log(chalk.yellow(`  ⚠️  Wolverine not detected in this directory`));
  }

  // API keys
  for (const [key, info] of Object.entries(env.keys)) {
    if (key === "WOLVERINE_ADMIN_KEY") continue; // not critical for claw
    if (info.set) {
      log(chalk.green(`  ✅ ${key} (${info.source})`));
    } else {
      log(chalk.yellow(`  ⚠️  ${key} not set`));
    }
  }

  // Existing claw
  if (env.existingClaw && !forceReinstall) {
    log(chalk.green(`  ✅ wolverine-claw/ already exists`));
  }

  log("");

  // ── Step 2: Node version check ──────────────────────────────
  if (!env.node.ok) {
    log(chalk.yellow("  ⚠️  Node.js 22+ recommended (required for OpenClaw multi-channel)."));
    log(chalk.gray("     Standalone agent mode works on Node 20+.\n"));
  }

  if (dryRun) {
    log(chalk.gray("  [dry run] Would scaffold wolverine-claw/ here.\n"));
    return { success: true, dryRun: true, env };
  }

  // ── Step 3: Merge config ────────────────────────────────────
  log(chalk.bold("  Configuring...\n"));

  // Load default config template
  const defaultConfigPath = path.join(__dirname, "..", "..", "wolverine-claw", "config", "settings.json");
  let defaults;
  try {
    defaults = JSON.parse(fs.readFileSync(defaultConfigPath, "utf-8"));
  } catch {
    // Fallback: build minimal defaults inline
    defaults = buildMinimalDefaults();
  }

  const mergedConfig = mergeConfig(env.openclaw.config, defaults);

  if (env.openclaw.config) {
    log(chalk.green("  ✅ Merged OpenClaw config with wolverine defaults"));
    // Log what was imported
    if (env.openclaw.config.gateway?.port) {
      log(chalk.gray(`     Gateway port: ${env.openclaw.config.gateway.port}`));
    }
    if (env.openclaw.config.agent?.model || env.openclaw.config.model) {
      log(chalk.gray(`     Agent model: ${env.openclaw.config.agent?.model || env.openclaw.config.model}`));
    }
    const importedChannels = env.openclaw.config.channels
      ? Object.keys(env.openclaw.config.channels)
      : [];
    if (importedChannels.length > 0) {
      log(chalk.gray(`     Channels: ${importedChannels.join(", ")}`));
    }
  } else {
    log(chalk.gray("  Using wolverine defaults (no OpenClaw config found to merge)"));
  }

  log("");

  // ── Step 4: Scaffold ────────────────────────────────────────
  log(chalk.bold("  Scaffolding wolverine-claw/...\n"));

  const scaffoldResult = scaffold(cwd, mergedConfig, env);

  for (const f of scaffoldResult.created) {
    log(chalk.green(`  + ${f}`));
  }
  for (const f of scaffoldResult.skipped) {
    log(chalk.gray(`  ○ ${f}`));
  }
  for (const f of scaffoldResult.errors) {
    log(chalk.red(`  ✗ ${f}`));
  }

  log("");

  // ── Step 5: Environment file ────────────────────────────────
  log(chalk.bold("  Environment...\n"));

  const envResult = ensureEnvFile(cwd, env);
  if (envResult.created) {
    log(chalk.green("  + .env.local created (add your API keys)"));
  } else {
    log(chalk.gray("  ○ .env.local exists"));
    if (envResult.keysAdded.length > 0) {
      log(chalk.green(`    + Added ${envResult.keysAdded.length} claw key templates`));
    }
  }

  log("");

  // ── Step 6: Install OpenClaw ────────────────────────────────
  if (!env.openclaw.localInstall) {
    log(chalk.bold("  Dependencies...\n"));
    const depResult = ensureOpenClawDep(cwd);
    if (depResult.installed) {
      log(chalk.green(`  ✅ openclaw ${depResult.alreadyPresent ? "already installed" : "installed"}`));
    } else {
      log(chalk.yellow(`  ⚠️  openclaw: ${depResult.reason}`));
      if (depResult.fallback) {
        log(chalk.gray(`     ${depResult.fallback}`));
      }
    }
    log("");
  }

  // ── Step 7: Validate ───────────────────────────────────────
  log(chalk.bold("  Validating...\n"));

  // Re-detect after setup
  const postEnv = detectEnvironment(cwd);
  const checks = validate(cwd, postEnv);

  let allCriticalPass = true;
  for (const check of checks) {
    const icon = check.pass ? chalk.green("  ✅") : (check.critical ? chalk.red("  ❌") : chalk.yellow("  ⚠️ "));
    log(`${icon} ${check.name}: ${check.detail}`);
    if (check.critical && !check.pass) allCriticalPass = false;
  }

  log("");

  // ── Step 8: Next steps ─────────────────────────────────────
  log(chalk.blue(`  ${LINE}`));

  if (allCriticalPass) {
    log(chalk.green.bold("\n  ✅ Wolverine Claw is ready!\n"));
  } else {
    log(chalk.yellow.bold("\n  ⚠️  Setup completed with warnings.\n"));
  }

  log(chalk.bold("  Next steps:\n"));

  // Check what the user still needs to do
  const todos = [];

  if (!postEnv.keys.ANTHROPIC_API_KEY.set && !postEnv.keys.OPENAI_API_KEY.set) {
    todos.push({
      step: "Add API keys to .env.local",
      cmd: null,
      detail: "ANTHROPIC_API_KEY or OPENAI_API_KEY required for AI healing",
    });
  }

  todos.push({
    step: "Start Wolverine Claw",
    cmd: "npm run claw",
    detail: "Launches OpenClaw gateway with wolverine self-healing",
  });

  todos.push({
    step: "Check configuration",
    cmd: "npm run claw:info",
    detail: "Shows current config, channels, and API key status",
  });

  todos.push({
    step: "Enable channels (optional)",
    cmd: null,
    detail: "Edit wolverine-claw/config/settings.json → channels section",
  });

  for (let i = 0; i < todos.length; i++) {
    const t = todos[i];
    log(chalk.white(`  ${i + 1}. ${t.step}`));
    if (t.cmd) {
      log(chalk.cyan(`     $ ${t.cmd}`));
    }
    if (t.detail) {
      log(chalk.gray(`     ${t.detail}`));
    }
  }

  log("");
  log(chalk.gray("  Config:   wolverine-claw/config/settings.json"));
  log(chalk.gray("  Secrets:  .env.local"));
  log(chalk.gray("  Docs:     https://github.com/bobbyswhip/Wolverine"));
  log("");

  return {
    success: allCriticalPass,
    env: postEnv,
    scaffoldResult,
    checks,
    todos,
  };
}

/**
 * Build minimal default config when template file isn't available.
 */
function buildMinimalDefaults() {
  return {
    "_": "Wolverine Claw Configuration",
    gateway: { port: 18789, host: "127.0.0.1" },
    agent: { model: "claude-sonnet-4-6", maxTurns: 25, timeoutMs: 120000 },
    models: {
      reasoning: "claude-sonnet-4-6",
      coding: "claude-sonnet-4-6",
      chat: "claude-sonnet-4-6",
      embedding: "text-embedding-3-small",
    },
    channels: { terminal: { enabled: true } },
    healing: {
      enabled: true,
      healTimeoutMs: 300000,
      maxHealsPerWindow: 5,
      windowMs: 300000,
      loopMaxAttempts: 3,
      loopWindowMs: 600000,
    },
    skills: {
      codingAgent: { enabled: true, defaultAgent: "pi", sandbox: true, allowedPaths: ["wolverine-claw/workspace/"] },
      browserControl: { enabled: false },
      cron: { enabled: true, maxJobs: 10 },
      canvas: { enabled: false },
    },
    workspace: { path: "wolverine-claw/workspace", maxFileSizeMB: 50, allowedExtensions: ["*"] },
    security: { dmPairing: true, sandbox: true, blockedCommands: ["rm -rf /", "format", "shutdown", "reboot"], maxConcurrentSessions: 5 },
    logging: { level: "info", logFile: ".wolverine/claw.log", maxLogSizeMB: 50 },
    remoteAccess: { enabled: false, method: "tailscale" },
    backup: { enabled: true, stabilityMs: 1800000, retentionDays: 7 },
  };
}

module.exports = {
  setup,
  detectEnvironment,
  detectOpenClaw,
  mergeConfig,
  scaffold,
  validate,
  ensureEnvFile,
  ensureOpenClawDep,
};
