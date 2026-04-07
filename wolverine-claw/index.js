/**
 * Wolverine Claw — OpenClaw agentic agent with Wolverine self-healing.
 *
 * This is the entry point for the claw environment. It bootstraps the OpenClaw
 * gateway and Pi agent runtime, wrapped by Wolverine's process manager for
 * automatic crash recovery, healing, and workspace backup.
 *
 * Usage:
 *   node bin/wolverine-claw.js              (under wolverine healing)
 *   node wolverine-claw/index.js            (direct, no healing)
 */

const path = require("path");
const fs = require("fs");

// Load claw-specific config
function loadClawConfig() {
  const configPath = path.join(__dirname, "config", "settings.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    // Strip comment keys (keys starting with _)
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    console.error(`[CLAW] Failed to load config: ${err.message}`);
    process.exit(1);
  }
}

const config = loadClawConfig();

// Gateway state
let gateway = null;
let shutdownCalled = false;

/**
 * Start the OpenClaw gateway with wolverine integration.
 */
async function start() {
  const gatewayPort = config.gateway?.port || 18789;
  const gatewayHost = config.gateway?.host || "127.0.0.1";

  console.log(`[CLAW] Starting Wolverine Claw...`);
  console.log(`[CLAW] Gateway: ws://${gatewayHost}:${gatewayPort}`);
  console.log(`[CLAW] Workspace: ${path.resolve(config.workspace?.path || "wolverine-claw/workspace")}`);

  // Ensure workspace directory exists
  const workspacePath = path.resolve(config.workspace?.path || "wolverine-claw/workspace");
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  try {
    // Try to use openclaw as npm dependency
    const openclaw = require("openclaw");

    // Configure OpenClaw with our settings
    const clawConfig = {
      gateway: {
        port: gatewayPort,
        host: gatewayHost,
      },
      agent: {
        model: config.agent?.model || config.models?.coding || "claude-sonnet-4-6",
        maxTurns: config.agent?.maxTurns || 25,
      },
      channels: buildChannelConfig(config.channels),
      skills: config.skills || {},
      security: config.security || {},
    };

    // Start gateway via openclaw SDK
    if (openclaw.createGateway) {
      gateway = await openclaw.createGateway(clawConfig);
      await gateway.start();
    } else if (openclaw.Gateway) {
      gateway = new openclaw.Gateway(clawConfig);
      await gateway.start();
    } else if (openclaw.start) {
      gateway = await openclaw.start(clawConfig);
    } else {
      // Fallback: spawn openclaw CLI as child process
      console.log("[CLAW] OpenClaw SDK API not found, falling back to CLI mode...");
      await startClawCLI(gatewayPort, gatewayHost);
      return;
    }

    console.log(`[CLAW] Gateway running on ws://${gatewayHost}:${gatewayPort}`);

    // Register wolverine integration plugin
    await registerWolverinePlugin(gateway);

    // Report health to wolverine parent via IPC
    reportHealth("running");

  } catch (err) {
    if (err.code === "MODULE_NOT_FOUND" && err.message.includes("openclaw")) {
      console.log("[CLAW] OpenClaw not installed, starting standalone agent...");
      await startStandaloneAgent();
    } else {
      console.error(`[CLAW] Startup failed: ${err.message}`);
      console.error(err.stack);
      reportHealth("error", err.message);
      process.exit(1);
    }
  }
}

/**
 * Fallback: start wolverine's built-in standalone agent.
 * No external deps needed — uses wolverine's own AI client + tools.
 */
async function startStandaloneAgent() {
  try {
    // Load dotenv for AI keys
    const dotenv = require("dotenv");
    dotenv.config({ path: path.resolve(__dirname, "..", ".env.local") });
    dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

    const { startRepl } = require("../src/claw/standalone-agent");
    reportHealth("running");
    await startRepl(config, { cwd: path.resolve(__dirname, "..") });
  } catch (err) {
    console.error(`[CLAW] Standalone agent failed: ${err.message}`);
    console.error(err.stack);

    // Last resort: try CLI mode
    const gatewayPort = config.gateway?.port || 18789;
    const gatewayHost = config.gateway?.host || "127.0.0.1";
    await startClawCLI(gatewayPort, gatewayHost);
  }
}

/**
 * Fallback: spawn openclaw gateway via CLI (npx openclaw gateway).
 */
async function startClawCLI(port, host) {
  const { spawn } = require("child_process");

  // Build the config file for openclaw CLI
  const clawConfigPath = path.join(__dirname, ".claw-runtime-config.yml");
  const yamlConfig = buildClawYaml(config, port, host);
  fs.writeFileSync(clawConfigPath, yamlConfig);

  console.log(`[CLAW] Spawning: npx openclaw gateway --port ${port}`);

  const child = spawn("npx", ["openclaw", "gateway", "--port", String(port)], {
    cwd: path.resolve(__dirname, ".."),
    stdio: ["inherit", "inherit", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_CONFIG: clawConfigPath,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_GATEWAY_HOST: host,
    },
    shell: true,
  });

  let stderrBuffer = "";
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    process.stderr.write(chunk);

    // Report errors to wolverine parent
    if (text.includes("Error") || text.includes("FATAL")) {
      reportError(text, stderrBuffer);
    }
  });

  child.on("exit", (code, signal) => {
    if (!shutdownCalled) {
      console.error(`[CLAW] Gateway exited unexpectedly (code=${code}, signal=${signal})`);
      reportHealth("crashed", `exit code ${code}`);
      process.exit(code || 1);
    }
  });

  gateway = child;
  reportHealth("running");
}

/**
 * Build channel config from settings, filtering to enabled channels only.
 */
function buildChannelConfig(channels) {
  if (!channels) return {};
  const result = {};
  for (const [name, cfg] of Object.entries(channels)) {
    if (name.startsWith("_")) continue;
    if (cfg.enabled) {
      result[name] = { ...cfg };
      delete result[name].enabled;
    }
  }
  return result;
}

/**
 * Build a YAML config string for openclaw CLI fallback.
 */
function buildClawYaml(cfg, port, host) {
  const lines = [
    `# Auto-generated by Wolverine Claw — do not edit manually`,
    `gateway:`,
    `  port: ${port}`,
    `  host: "${host}"`,
    ``,
  ];

  if (cfg.agent?.model) {
    lines.push(`agent:`);
    lines.push(`  model: "${cfg.agent.model}"`);
    lines.push(`  maxTurns: ${cfg.agent.maxTurns || 25}`);
    lines.push(``);
  }

  // Add enabled channels
  const channels = cfg.channels || {};
  const enabledChannels = Object.entries(channels).filter(([k, v]) => !k.startsWith("_") && v.enabled);
  if (enabledChannels.length > 0) {
    lines.push(`channels:`);
    for (const [name, chanCfg] of enabledChannels) {
      lines.push(`  ${name}:`);
      for (const [key, val] of Object.entries(chanCfg)) {
        if (key === "enabled") continue;
        if (typeof val === "string") lines.push(`    ${key}: "${val}"`);
        else if (Array.isArray(val)) lines.push(`    ${key}: [${val.map(v => `"${v}"`).join(", ")}]`);
        else lines.push(`    ${key}: ${val}`);
      }
    }
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * Register wolverine self-healing integration as an OpenClaw plugin.
 */
async function registerWolverinePlugin(gw) {
  try {
    const pluginPath = path.join(__dirname, "plugins", "wolverine-integration.js");
    if (fs.existsSync(pluginPath)) {
      const plugin = require(pluginPath);
      if (typeof plugin.register === "function") {
        await plugin.register(gw, config);
        console.log("[CLAW] Wolverine integration plugin loaded");
      }
    }
  } catch (err) {
    console.warn(`[CLAW] Plugin load warning: ${err.message}`);
  }
}

/**
 * Report health status to wolverine parent process via IPC.
 */
function reportHealth(status, detail) {
  if (typeof process.send === "function") {
    try {
      process.send({
        type: "claw_health",
        status,
        detail: detail || null,
        timestamp: Date.now(),
        gateway: {
          port: config.gateway?.port || 18789,
          host: config.gateway?.host || "127.0.0.1",
        },
      });
    } catch {}
  }
}

/**
 * Report errors to wolverine parent process via IPC for healing.
 */
function reportError(message, stderr) {
  if (typeof process.send === "function") {
    try {
      process.send({
        type: "route_error",
        path: "claw://gateway",
        method: "INTERNAL",
        statusCode: 500,
        message: message.trim().slice(0, 500),
        stack: stderr.slice(-2000),
        file: null,
        line: null,
        timestamp: Date.now(),
      });
    } catch {}
  }
}

// Graceful shutdown
function shutdown(signal) {
  if (shutdownCalled) return;
  shutdownCalled = true;
  console.log(`\n[CLAW] Shutting down (${signal})...`);

  if (gateway) {
    if (typeof gateway.stop === "function") {
      gateway.stop();
    } else if (typeof gateway.kill === "function") {
      gateway.kill("SIGTERM");
    }
  }

  reportHealth("stopped");
  setTimeout(() => process.exit(0), 2000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Start
start().catch((err) => {
  console.error(`[CLAW] Fatal: ${err.message}`);
  process.exit(1);
});
