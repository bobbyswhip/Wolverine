# Critical Fix: Route Verifier Breaks Every Heal

## The Bug

Every heal attempt on this server follows the same pattern:

```
19:58:06  Fast path (opus) → Patched breakable.js
19:58:10  Syntax check → OK
19:58:10  Boot probe → OK
19:58:10  Route probe: GET /breakable → ❌ "Process exited before route test"
19:58:10  ROLLBACK — working fix thrown away
19:58:11  Agent path triggered → burns 119K tokens → budget exhausted
19:58:57  FAIL
```

**The fix works. The verifier rejects it.**

This has happened on every single demo run. The fast path correctly patches the bug every time, but the route probe verifier kills the fix.

## Root Cause

The route probe in `src/core/verifier.js` spawns a **new Node process** to test the route:

```js
// What the verifier does (simplified):
const testProc = spawn("node", ["server/index.js"], { cwd });
// Wait for it to boot...
const response = await fetch(`http://localhost:${port}/breakable`);
```

This fails because `server/index.js` requires:
- `@fastify/cors`
- `@fastify/compress`
- `pg` (PostgreSQL client)
- `ioredis`
- `./lib/db.js` (connects to database on require)

The test process spawns, tries to boot the full server, crashes on a dependency or DB connection, and exits before the route can be tested. The verifier sees "Process exited before route test" and marks the fix as failed.

**The actual fix to breakable.js was correct.** Opus patched it in 4 seconds. But the verifier can't validate it because our server has external dependencies.

## Impact

Every heal costs $0.15-0.31 instead of $0.02 because:
1. Fast path: $0.02 (actually fixes the bug)
2. Verifier rejects it: $0.00
3. Agent path burns 119K tokens trying the same thing: $0.15
4. Sub-agents burn another 200K tokens: $0.12
5. Total: $0.29 wasted on iterations 2-3

This has been the root cause of every failed demo.

## The Fix

### Option A: Test Only the Changed File (Recommended)

Don't boot the full server. Just verify the changed module loads without throwing:

```js
// verifier.js — replace route probe with isolated module test
async function verifyChangedFile(filePath, cwd) {
  // 1. Syntax check (already works)
  const syntaxOk = await checkSyntax(filePath);
  if (!syntaxOk) return { verified: false, status: "syntax-error" };

  // 2. Module load test — can the file be required without throwing?
  try {
    const testCode = [
      `delete require.cache[require.resolve("./${path.relative(cwd, filePath)}")]`,
      `require("./${path.relative(cwd, filePath)}")`,
      `console.log("MODULE_OK")`,
    ].join(";");

    const result = execSync(`node -e '${testCode}'`, {
      cwd,
      timeout: 5000,
      env: { ...process.env, NODE_PATH: path.join(cwd, "node_modules") },
    });

    if (result.toString().includes("MODULE_OK")) {
      return { verified: true, status: "module-loads" };
    }
  } catch (err) {
    return { verified: false, status: "module-crash", error: err.message };
  }

  return { verified: false, status: "unknown" };
}
```

This tests that `breakable.js` can be `require()`'d without throwing — which is all we need for a simple TypeError fix. No server boot, no DB connection, no dependency chain.

### Option B: Skip Route Probe for Simple Errors

If the error is a simple TypeError/ReferenceError and syntax + boot check pass, trust the fix:

```js
// In verifier.js or wolverine.js:
const SIMPLE_ERRORS = /TypeError|ReferenceError|SyntaxError|Cannot read prop/;

if (SIMPLE_ERRORS.test(errorMessage) && syntaxOk && bootOk) {
  // Skip route probe — trust the AI fix
  // If it's still broken, ErrorMonitor will catch it on the next request
  return { verified: true, status: "trusted-simple", skippedRouteProbe: true };
}
```

The ErrorMonitor already watches for repeated 500s. If the fix doesn't work, it triggers another heal within 30 seconds. This is cheaper than running a route probe that always fails.

### Option C: Route Probe with Minimal Server

Create a minimal test harness that only loads the changed route, not the full server:

```js
// Test harness for route probe:
const testServer = `
  const fastify = require("fastify")({ logger: false });
  try {
    const route = require("${changedFile}");
    if (typeof route === "function" && route.length === 0) {
      // Plain function export
      fastify.get("/test", async () => route());
    } else {
      // Fastify plugin
      fastify.register(route, { prefix: "/test" });
    }
    fastify.listen({ port: 0, host: "127.0.0.1" }, (err, addr) => {
      if (err) { console.error(err); process.exit(1); }
      console.log("TEST_PORT=" + addr.split(":").pop());
    });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
`;
```

This boots a tiny Fastify instance with ONLY the changed route — no cors, no pg, no redis.

## Also: Rollback Overwrites Platform Config

Every failed heal rollback restores ALL files in `server/`, including:
- `server/config/settings.json` — wipes our platform API key
- `server/index.js` — wipes our platform routes
- `server/lib/db.js` — wipes our database connection

The backup system should have an exclusion list for files that should never be rolled back:

```js
// backup-manager.js
const NEVER_ROLLBACK = [
  "server/config/settings.json",
  "server/lib/db.js",
];

// During rollback:
for (const file of filesToRestore) {
  if (NEVER_ROLLBACK.some(p => file.endsWith(p))) continue;
  // ... restore file
}
```

Or better: only back up and restore the specific file that was changed, not the entire `server/` directory.

## Summary

| Issue | Impact | Fix |
|-------|--------|-----|
| Route probe crashes on deps | Every heal fails iteration 1 | Test changed file in isolation |
| Agent burns tokens on solved bug | $0.15-0.29 wasted per heal | Skip probe for simple errors |
| Rollback wipes platform config | Server loses API key, routes, DB | Exclude config from rollback |
| Backup includes all files | 14 files backed up for 1-file change | Only backup changed files |
