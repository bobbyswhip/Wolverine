/**
 * Wolverine Bootstrap — auto-preload for OpenClaw processes.
 *
 * Loaded via: node --require ./wolverine-claw/bootstrap.js <openclaw-cmd>
 *
 * This file is injected into the OpenClaw process BEFORE any user code runs.
 * It makes the full wolverine API available globally without any imports:
 *
 *   // In any OpenClaw skill, plugin, or gateway code:
 *   const scan = wolverine.scanText(userInput);
 *   if (!scan.safe) throw new Error("Injection detected");
 *
 *   const results = await wolverine.brain.search("how to fix ECONNREFUSED");
 *   wolverine.backup.create("before risky change");
 *
 * Also patches:
 * - process.on("uncaughtException") → reports to wolverine heal pipeline
 * - process.on("unhandledRejection") → same
 * - Intercepts require("openclaw") → auto-registers wolverine plugin
 */

const path = require("path");
const Module = require("module");

// ── Initialize wolverine API ────────────────────────────────────

const projectRoot = process.cwd();
let api;

try {
  // Try loading from node_modules first (installed as dep)
  let initFn;
  try {
    initFn = require("wolverine-ai/src/claw/wolverine-api").init;
  } catch {
    // Fallback: relative path (running from wolverine repo)
    initFn = require(path.join(projectRoot, "src", "claw", "wolverine-api")).init;
  }

  api = initFn(projectRoot);

  // Make wolverine globally accessible — no imports needed anywhere
  global.wolverine = api;

  // Also set on process for structured access
  process.wolverine = api;

  console.log("[wolverine] Bootstrap loaded — global.wolverine available");
} catch (err) {
  console.warn(`[wolverine] Bootstrap warning: ${err.message}`);
  // Non-fatal — OpenClaw can still run without wolverine features
}

// ── Error handlers → wolverine heal pipeline ────────────────────

if (api) {
  // Catch uncaught exceptions and report to wolverine
  process.on("uncaughtException", (err) => {
    console.error(`[wolverine] Uncaught: ${err.message}`);
    _reportError(err, "uncaughtException");
    // Don't exit — let OpenClaw's own handler decide
  });

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error(`[wolverine] Unhandled rejection: ${err.message}`);
    _reportError(err, "unhandledRejection");
  });
}

// ── Auto-register wolverine plugin into OpenClaw ────────────────

const _originalLoad = Module._load;
let _openclawPatched = false;

Module._load = function (request, parent, isMain) {
  const result = _originalLoad.apply(this, arguments);

  // Hook into openclaw when it's first loaded
  if (request === "openclaw" && !_openclawPatched && api) {
    _openclawPatched = true;
    _patchOpenClaw(result);
  }

  return result;
};

function _patchOpenClaw(openclaw) {
  // Wrap gateway creation to auto-register wolverine plugin
  const factories = ["createGateway", "Gateway", "start"];

  for (const method of factories) {
    if (typeof openclaw[method] !== "function") continue;

    const original = openclaw[method];

    if (method === "Gateway") {
      // Constructor — wrap with class
      openclaw[method] = class extends original {
        constructor(...args) {
          super(...args);
          _autoRegisterPlugin(this);
        }
      };
    } else {
      // Factory function — wrap return value
      openclaw[method] = async function (...args) {
        const gateway = await original.apply(this, args);
        if (gateway) _autoRegisterPlugin(gateway);
        return gateway;
      };
    }
  }

  console.log("[wolverine] OpenClaw patched — plugin auto-registers on gateway start");
}

function _autoRegisterPlugin(gateway) {
  try {
    // Load and register the wolverine integration plugin
    let pluginPath;
    try {
      pluginPath = require.resolve("wolverine-ai/wolverine-claw/plugins/wolverine-integration.js");
    } catch {
      pluginPath = path.join(projectRoot, "wolverine-claw", "plugins", "wolverine-integration.js");
    }

    const plugin = require(pluginPath);
    const fs = require("fs");
    const configPath = path.join(projectRoot, "wolverine-claw", "config", "settings.json");
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch {}

    plugin.register(gateway, config);
    console.log("[wolverine] Plugin auto-registered into OpenClaw gateway");
  } catch (err) {
    console.warn(`[wolverine] Plugin auto-register warning: ${err.message}`);
  }
}

// ── Scan incoming text for injection (available as middleware) ───

/**
 * Express/Fastify middleware that scans all request bodies for injection.
 * Usage: app.use(wolverine.middleware.injectionGuard);
 */
if (api) {
  api.middleware = {
    injectionGuard: (req, res, next) => {
      // Fastify-style (req.body is already parsed)
      const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || "");
      if (body.length > 10) {
        const scan = api.scanText(body);
        if (!scan.safe) {
          const code = scan.injection?.safe === false ? 403 : 400;
          const msg = scan.injection?.safe === false ? "Blocked: injection detected" : "Blocked: contains secrets";
          if (res.code) {
            // Fastify
            res.code(code).send({ error: msg });
          } else {
            // Express
            res.status(code).json({ error: msg });
          }
          return;
        }
      }
      if (next) next();
    },
  };
}

// ── IPC error reporting ─────────────────────────────────────────

function _reportError(err, source) {
  if (typeof process.send !== "function") return;

  try {
    let file = null, line = null;
    if (err.stack) {
      const frames = err.stack.split("\n");
      for (const frame of frames) {
        const m = frame.match(/\(([^)]+):(\d+):(\d+)\)/) || frame.match(/at\s+([^\s(]+):(\d+):(\d+)/);
        if (m && !m[1].includes("node_modules") && !m[1].includes("node:")) {
          file = m[1]; line = parseInt(m[2], 10); break;
        }
      }
    }

    process.send({
      type: "route_error",
      path: `claw://${source}`,
      method: "INTERNAL",
      statusCode: 500,
      message: err.message?.slice(0, 500),
      stack: err.stack?.slice(0, 2000),
      file,
      line,
      timestamp: Date.now(),
    });
  } catch {}
}
