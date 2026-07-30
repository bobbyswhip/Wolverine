/**
 * Error Hook — preloaded into the child server process via --require.
 *
 * Safety net: patches Fastify and Express to report caught errors
 * via IPC to the Wolverine parent process. Works even if the user's
 * server code doesn't call process.send() in its error handler.
 *
 * How it works:
 * 1. Runner spawns: node --require error-hook.js server/index.js
 * 2. This file intercepts require("fastify") and require("express")
 * 3. Wraps the constructor to add an onError hook (Fastify) or
 *    error middleware (Express) that sends IPC messages
 * 4. Parent's ErrorMonitor receives messages and triggers heal
 *
 * If the server already reports errors via process.send(), the hook
 * deduplicates by checking a timestamp flag on the error object.
 */

const Module = require("module");
const originalLoad = Module._load;

let _fastifyHooked = false;
let _expressHooked = false;

Module._load = function (request, parent, isMain) {
  const result = originalLoad.apply(this, arguments);

  // Hook Fastify
  if (request === "fastify" && typeof result === "function" && !_fastifyHooked) {
    _fastifyHooked = true;
    const originalFastify = result;
    const wrapped = function (...args) {
      const instance = originalFastify(...args);
      _hookFastify(instance);
      return instance;
    };
    // #23: Copy all own properties (including non-enumerable and symbols) to preserve prototype chain
    for (const key of Object.getOwnPropertyNames(originalFastify)) {
      if (key !== "length" && key !== "name" && key !== "prototype") {
        try { wrapped[key] = originalFastify[key]; } catch {}
      }
    }
    for (const sym of Object.getOwnPropertySymbols(originalFastify)) {
      try { wrapped[sym] = originalFastify[sym]; } catch {}
    }
    wrapped.default = wrapped; // ESM compat
    return wrapped;
  }

  // Hook Express
  if (request === "express" && typeof result === "function" && !_expressHooked) {
    _expressHooked = true;
    const originalExpress = result;
    const wrapped = function (...args) {
      const app = originalExpress(...args);
      _hookExpress(app);
      return app;
    };
    // #23: Copy all own properties (including non-enumerable and symbols)
    for (const key of Object.getOwnPropertyNames(originalExpress)) {
      if (key !== "length" && key !== "name" && key !== "prototype") {
        try { wrapped[key] = originalExpress[key]; } catch {}
      }
    }
    for (const sym of Object.getOwnPropertySymbols(originalExpress)) {
      try { wrapped[sym] = originalExpress[sym]; } catch {}
    }
    return wrapped;
  }

  return result;
};

function _hookFastify(fastify) {
  // Adaptive rate limiter — auto-protects based on CPU/memory pressure
  if (process.env.WOLVERINE_ADAPTIVE_LIMIT !== "false") {
    try {
      const { getLimiter } = require("../monitor/adaptive-limiter");
      const limiter = getLimiter();
      fastify.addHook("onRequest", function (request, reply, done) {
        if (!limiter.shouldAllow(request.url, request.headers)) {
          const status = limiter.getStatus();
          reply.code(503).header("Retry-After", "5").header("X-Wolverine-Zone", status.zone).send({
            error: "Service temporarily unavailable",
            zone: status.zone,
            cpu: status.cpuAvg + "%",
            memory: status.memAvg + "%",
            retry_after: 5,
          });
          return;
        }
        done();
      });
    } catch {}
  }

  // Wrap setErrorHandler so our IPC reporting runs BEFORE the user's handler
  const origSetError = fastify.setErrorHandler;
  let customErrorHandlerSet = false;
  fastify.setErrorHandler = function (userHandler) {
    customErrorHandlerSet = true;
    return origSetError.call(this, function (error, request, reply) {
      _reportError(request.url, request.method, error);
      return userHandler.call(this, error, request, reply);
    });
  };

  // Add onError hook as primary fallback — fires for all route errors in Fastify
  try {
    fastify.addHook("onError", function (request, reply, error, done) {
      _reportError(request.url, request.method, error);
      done();
    });
  } catch { /* addHook may fail if server is already started */ }

  // Register a default error handler if user never calls setErrorHandler
  // This ensures we catch async route throws even without a custom handler
  try {
    fastify.addHook("onReady", function (done) {
      if (!customErrorHandlerSet) {
        origSetError.call(fastify, function (error, request, reply) {
          _reportError(request.url, request.method, error);
          reply.code(error.statusCode || 500).send({ error: error.message });
        });
      }
      done();
    });
  } catch { /* non-fatal */ }
}

function _hookExpress(app) {
  // Adaptive rate limiter for Express
  if (process.env.WOLVERINE_ADAPTIVE_LIMIT !== "false") {
    try {
      const { getLimiter } = require("../monitor/adaptive-limiter");
      const limiter = getLimiter();
      app.use(function _wolverineAdaptiveLimiter(req, res, next) {
        if (!limiter.shouldAllow(req.url, req.headers)) {
          const status = limiter.getStatus();
          res.status(503).set("Retry-After", "5").set("X-Wolverine-Zone", status.zone).json({
            error: "Service temporarily unavailable", zone: status.zone, retry_after: 5,
          });
          return;
        }
        next();
      });
    } catch {}
  }

  // Wrap app.listen to inject error middleware AFTER all user middleware
  const originalListen = app.listen;
  app.listen = function (...args) {
    // #24: Use process.nextTick to ensure our error middleware is added AFTER
    // any middleware registered synchronously after listen() is called
    process.nextTick(() => {
      app.use(function _wolverineErrorHook(err, req, res, next) {
        _reportError(req.originalUrl || req.url, req.method, err);
        next(err);
      });
    });
    return originalListen.apply(this, args);
  };
}

// Dedup: skip if error was already reported in the same tick
const _reported = new WeakSet();

function _reportError(url, method, error) {
  if (typeof process.send !== "function") return;
  if (!error || _reported.has(error)) return;
  _reported.add(error);

  try {
    let file = null, line = null;
    if (error.stack) {
      for (const frame of error.stack.split("\n")) {
        // #25: Second regex uses (.+) instead of ([^\s(]+) to handle Windows paths with spaces
        const m = frame.match(/\(([^)]+):(\d+):(\d+)\)/) || frame.match(/at\s+(.+):(\d+):(\d+)/);
        if (m && !m[1].includes("node_modules") && !m[1].includes("node:")) {
          file = m[1]; line = parseInt(m[2], 10); break;
        }
      }
    }

    process.send({
      type: "route_error",
      path: url,
      method: method || "GET",
      statusCode: 500,
      message: error.message || "Unknown error",
      stack: (error.stack || "").slice(0, 2000),
      file,
      line,
      timestamp: Date.now(),
    });
  } catch { /* IPC send failed — non-fatal */ }
}


// ─────────── Process-level safety net for transient RPC errors ───────────
// Background tasks (keepers, x402/billing settlement) hit RPC endpoints
// (BASE_RPC_URL / CDP node) on intervals. When the upstream rate-limits, the
// client throws after exhausting its own retries; an uncaught rejection would
// otherwise crash the ENTIRE server (Node exits 1 on unhandledRejection),
// taking every keeper down with it. These errors are transient and self-heal on
// the next tick, so we log and continue. Anything NOT recognised as transient
// is still reported to the parent (for heal) and still crashes — preserving the
// normal crash-and-heal behaviour for real bugs.
const _TRANSIENT_RPC_RE = /rate.?limit|too many requests|\b429\b|\b50[23]\b|-3201[56]|-32005|max(?:imum)? retr|could not coalesce|request timed out|\btimeout\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|over rate limit|compute units|throughput|temporarily unavailable/i;

function _isTransientRpc(err) {
  try {
    const parts = [];
    if (err && typeof err === "object") {
      if (err.message) parts.push(String(err.message));
      if (err.shortMessage) parts.push(String(err.shortMessage));
      if (err.code != null) parts.push(String(err.code));
      if (err.info) { try { parts.push(JSON.stringify(err.info)); } catch (e) {} }
      if (err.cause) { try { parts.push(String((err.cause && err.cause.message) || err.cause)); } catch (e) {} }
    } else {
      parts.push(String(err));
    }
    return _TRANSIENT_RPC_RE.test(parts.join(" "));
  } catch (e) { return false; }
}

let _transientRpcCount = 0;
function _handleProcessError(kind, reason) {
  const err = reason instanceof Error ? reason : new Error(String((reason && reason.message) || reason));
  if (_isTransientRpc(err)) {
    _transientRpcCount++;
    if (_transientRpcCount <= 20 || _transientRpcCount % 50 === 0) {
      console.warn("[error-hook] transient RPC " + kind + " swallowed (#" + _transientRpcCount + "): " + String(err.message || err).slice(0, 180));
    }
    return; // keep the process alive — the task retries on its next tick
  }
  console.error("[error-hook] fatal " + kind + ":", (err && err.stack ? err.stack : String(err)).slice(0, 1500));
  try { _reportError(kind, "ASYNC", err); } catch (e) {}
  setTimeout(() => process.exit(1), 100).unref();
}

if (!global.__wolverineRpcGuard) {
  global.__wolverineRpcGuard = true;
  process.on("unhandledRejection", (reason) => _handleProcessError("unhandledRejection", reason));
  process.on("uncaughtException", (err) => _handleProcessError("uncaughtException", err));
  console.log("[error-hook] RPC rate-limit guard armed (transient RPC errors will not crash the process)");
}
