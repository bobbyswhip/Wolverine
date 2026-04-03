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
    Object.keys(originalFastify).forEach((key) => { wrapped[key] = originalFastify[key]; });
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
    Object.keys(originalExpress).forEach((key) => { wrapped[key] = originalExpress[key]; });
    return wrapped;
  }

  return result;
};

function _hookFastify(fastify) {
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
  // Wrap app.listen to inject error middleware AFTER all user middleware
  const originalListen = app.listen;
  app.listen = function (...args) {
    app.use(function _wolverineErrorHook(err, req, res, next) {
      _reportError(req.originalUrl || req.url, req.method, err);
      next(err);
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
        const m = frame.match(/\(([^)]+):(\d+):(\d+)\)/) || frame.match(/at\s+([^\s(]+):(\d+):(\d+)/);
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
