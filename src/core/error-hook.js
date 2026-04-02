/**
 * Error Hook — preloaded into the child server process via --require.
 *
 * Patches Fastify and Express error handlers to report caught errors
 * back to the Wolverine parent process via IPC. This enables healing
 * of 500 errors that don't crash the process.
 *
 * How it works:
 * 1. Runner spawns child with: node --require ./src/core/error-hook.js server/index.js
 * 2. This file hooks into Module._load to intercept fastify/express creation
 * 3. When a framework instance is created, we add an error handler that sends IPC messages
 * 4. Parent's ErrorMonitor receives the messages and triggers heal after threshold
 *
 * Zero changes to user's server code.
 */

const Module = require("module");
const originalLoad = Module._load;

let _hooked = false;

Module._load = function (request, parent, isMain) {
  const result = originalLoad.apply(this, arguments);

  // Hook Fastify
  if (request === "fastify" && typeof result === "function" && !_hooked) {
    const originalFastify = result;
    const wrapped = function (...args) {
      const instance = originalFastify(...args);
      _hookFastify(instance);
      return instance;
    };
    // Preserve all properties (fastify.default, etc.)
    Object.keys(originalFastify).forEach((key) => {
      wrapped[key] = originalFastify[key];
    });
    _hooked = true;
    return wrapped;
  }

  // Hook Express
  if (request === "express" && typeof result === "function" && !_hooked) {
    const originalExpress = result;
    const wrapped = function (...args) {
      const app = originalExpress(...args);
      _hookExpress(app);
      return app;
    };
    Object.keys(originalExpress).forEach((key) => {
      wrapped[key] = originalExpress[key];
    });
    _hooked = true;
    return wrapped;
  }

  return result;
};

function _hookFastify(fastify) {
  // Use onReady to add hooks after all plugins are loaded
  fastify.addHook("onReady", function (done) {
    // Add a global error handler that reports to parent
    fastify.addHook("onError", function (request, reply, error, done) {
      _reportError(request.url, request.method, error);
      done();
    });
    done();
  });

  // Also intercept the setErrorHandler if user sets one
  const originalSetError = fastify.setErrorHandler.bind(fastify);
  fastify.setErrorHandler = function (handler) {
    return originalSetError(function (error, request, reply) {
      _reportError(request.url, request.method, error);
      return handler(error, request, reply);
    });
  };
}

function _hookExpress(app) {
  // For Express, we monkey-patch app.use to detect error middleware
  // and also add our own at the end via a delayed hook
  const originalListen = app.listen.bind(app);
  app.listen = function (...args) {
    // Add our error handler AFTER all user middleware
    app.use(function wolverineErrorHandler(err, req, res, next) {
      _reportError(req.originalUrl || req.url, req.method, err);
      next(err);
    });
    return originalListen(...args);
  };
}

function _reportError(url, method, error) {
  if (!process.send) return; // No IPC channel — not spawned by wolverine

  try {
    // Extract file/line from stack trace
    let file = null;
    let line = null;
    if (error && error.stack) {
      const stackLines = error.stack.split("\n");
      for (const sl of stackLines) {
        const match = sl.match(/\(([^)]+):(\d+):(\d+)\)/) || sl.match(/at\s+([^\s(]+):(\d+):(\d+)/);
        if (match && !match[1].includes("node_modules") && !match[1].includes("node:")) {
          file = match[1];
          line = parseInt(match[2], 10);
          break;
        }
      }
    }

    process.send({
      type: "route_error",
      path: url,
      method: method || "GET",
      statusCode: 500,
      message: error?.message || "Unknown error",
      stack: error?.stack?.slice(0, 2000) || "",
      file,
      line,
      timestamp: Date.now(),
    });
  } catch {
    // Silently fail — don't break the server for IPC issues
  }
}
