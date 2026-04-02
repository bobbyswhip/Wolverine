# Framework Fix: Wolverine Doesn't Detect In-Process Errors

## Problem

Wolverine only heals **process crashes** (the child process exits with a non-zero code). It does **not** detect or heal **runtime errors that are caught by the web framework**.

When a route throws a TypeError, Fastify/Express catches it internally and returns HTTP 500. The process stays alive. Wolverine's heal pipeline never triggers because it only watches for `process.exit` / crash signals from the child process.

### Proof

```
Demo flow:
1. /breakable returns healthy                    ← PID 2648564
2. Bug injected (user.name on undefined)
3. /breakable returns 500 "Cannot read..."       ← PID 2648564 (same!)
4. Wolverine logs: NOTHING
5. 90 seconds later: still broken, same PID
6. Manual reset required
```

Wolverine's `src/core/runner.js` only triggers healing here:
```js
child.on("exit", (code, signal) => {
  // THIS is the only place heal() gets called
  // If the process doesn't exit, heal() never runs
});
```

## Why This Matters

Most production bugs are **caught exceptions** — they return 500 errors but don't crash the process. Frameworks like Express and Fastify have built-in error handlers that prevent crashes. This means Wolverine currently only heals the minority case (uncaught exceptions that kill the process) and misses the majority case (route-level errors that degrade the service).

## What Needs to Change

### Option A: Route Error Monitor (Recommended)

Add a module that monitors HTTP response codes and triggers healing when a route consistently returns 5xx errors.

**New file: `src/monitor/error-monitor.js`**

```js
/**
 * Watches for repeated 5xx errors on specific routes.
 * When a route fails N times in a row, triggers the heal pipeline
 * with the error details (parsed from the response or logs).
 *
 * This is the missing link — Wolverine currently only heals on
 * process crash, but most bugs produce caught 500s, not crashes.
 */

class ErrorMonitor {
  constructor({ threshold = 3, windowMs = 30000, onError }) {
    this.threshold = threshold;   // consecutive 5xx before triggering heal
    this.windowMs = windowMs;     // time window for counting
    this.onError = onError;       // callback: (routePath, errorDetails) => heal()
    this.routes = new Map();      // path → { count, firstSeen, lastError }
  }

  /**
   * Called by middleware on every response.
   * Tracks 5xx errors per route and triggers heal when threshold hit.
   */
  record(path, statusCode, error) {
    if (statusCode < 500) {
      // Success — reset the counter for this route
      this.routes.delete(path);
      return;
    }

    const entry = this.routes.get(path) || { count: 0, firstSeen: Date.now(), lastError: null };
    entry.count++;
    entry.lastError = error;

    // Check if outside window — reset
    if (Date.now() - entry.firstSeen > this.windowMs) {
      entry.count = 1;
      entry.firstSeen = Date.now();
    }

    this.routes.set(path, entry);

    if (entry.count >= this.threshold) {
      this.onError(path, entry.lastError);
      this.routes.delete(path); // reset after triggering
    }
  }
}

module.exports = { ErrorMonitor };
```

### How to Wire It

In `src/core/runner.js`, after the server child starts:

```js
const { ErrorMonitor } = require("../monitor/error-monitor");

const errorMonitor = new ErrorMonitor({
  threshold: 3,          // 3 consecutive 500s on same route
  windowMs: 30000,       // within 30 seconds
  onError: (path, error) => {
    // Trigger the same heal() pipeline used for crashes
    // but with the route path and error message instead of stderr
    heal({
      stderr: error.stack || error.message,
      cwd, sandbox, redactor, notifier,
      rateLimiter, backupManager, logger, brain, mcp, skills, repairHistory,
    });
  },
});
```

The server needs to report errors back to the runner. Two approaches:

**Approach 1: Middleware in server code**

The server adds middleware that sends error info to the parent process via IPC:

```js
// In server/index.js — add after error handler
fastify.addHook("onResponse", (req, reply, done) => {
  if (reply.statusCode >= 500 && process.send) {
    process.send({
      type: "route_error",
      path: req.url,
      statusCode: reply.statusCode,
      error: reply.raw._lastError || "Unknown error",
    });
  }
  done();
});
```

**Approach 2: Health check probing (already exists)**

Wolverine already has `src/monitor/route-prober.js` that probes routes. Extend it to:
1. Detect when a previously-healthy route starts returning 500
2. Capture the error response body
3. Feed it into the heal pipeline

This approach requires no changes to server code.

### Option B: Force Crash on Error (Simpler but Worse)

Make caught errors crash the process so Wolverine's existing pipeline handles them:

```js
// In server/index.js error handler
fastify.setErrorHandler((err, req, reply) => {
  console.error(`[FATAL] ${err.stack}`);
  reply.code(500).send({ error: "Internal server error" });
  // Force crash after responding — Wolverine will heal
  setTimeout(() => process.exit(1), 100);
});
```

**Why this is worse:** It crashes the entire server for every route error, causing downtime for all routes — not just the broken one. Option A isolates the fix to the broken route.

### Option C: IPC Error Channel (Best of Both)

The child process reports errors to the parent via Node's IPC channel. The parent (runner.js) decides whether to trigger healing without crashing anything.

```js
// Child (server/index.js)
fastify.setErrorHandler((err, req, reply) => {
  console.error(`[ERROR] ${err.message}`);
  reply.code(500).send({ error: "Internal server error" });

  // Report to parent — don't crash
  if (process.send) {
    process.send({
      type: "route_error",
      file: err.fileName || null,
      line: err.lineNumber || null,
      message: err.message,
      stack: err.stack,
      path: req.url,
    });
  }
});

// Parent (src/core/runner.js)
child.on("message", (msg) => {
  if (msg.type === "route_error") {
    errorMonitor.record(msg.path, 500, msg);
    // ErrorMonitor triggers heal() after threshold
  }
});
```

## Recommended Implementation Order

1. **IPC Error Channel** (Option C) — child reports errors to parent without crashing
2. **ErrorMonitor** — parent counts errors per route, triggers heal after threshold
3. **Route Prober integration** — if a healed route starts working again, mark the repair as successful
4. **Telemetry update** — report error-triggered heals in heartbeat (separate from crash-triggered heals)

## Impact on Platform Analytics

Once this is implemented, the platform will see:
- `repairs.total` increase for caught errors (not just crashes)
- `repairs.successes` reflect actual fix verification via route probing
- New repair `mode: "error_monitor"` to distinguish from crash heals

## Summary

| Current | After Fix |
|---------|-----------|
| Only heals process crashes | Heals caught 500 errors too |
| Most production bugs go undetected | Detects route-level degradation |
| Server must die for healing to start | Healing starts while server stays up |
| Demo doesn't work (error caught) | Demo triggers real healing |
