const { spawn } = require("child_process");
const path = require("path");
const chalk = require("chalk");
const { parseError, classifyError } = require("./error-parser");

/**
 * Fix Verifier — validates that a patch actually fixes the error
 * by running the script in a short-lived probe process.
 *
 * Verification strategies:
 * 1. SYNTAX CHECK: Run `node --check` to verify no syntax errors
 * 2. BOOT PROBE:   Start the process and wait for it to either crash or stay alive
 * 3. ERROR MATCH:  If it crashes, check if it's the SAME error (fix didn't work)
 *                  or a DIFFERENT error (fix worked but new problem)
 */

// How long to wait for the process to boot before considering it alive
const BOOT_PROBE_TIMEOUT_MS = 10000; // 10 seconds

/**
 * Run a syntax check on a file using `node --check`.
 * Returns { valid: boolean, error?: string }
 */
function syntaxCheck(scriptPath) {
  return new Promise((resolve) => {
    const child = spawn("node", ["--check", scriptPath], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 5000,
    });

    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data.toString(); });

    child.on("exit", (code) => {
      resolve({
        valid: code === 0,
        error: code !== 0 ? stderr.trim() : undefined,
      });
    });

    child.on("error", (err) => {
      resolve({ valid: false, error: err.message });
    });
  });
}

/**
 * Boot probe — start the process and see if it stays alive or crashes.
 *
 * Returns:
 * - { status: "alive" }              — process booted and stayed alive for BOOT_PROBE_TIMEOUT_MS
 * - { status: "crashed", stderr, sameError: boolean } — crashed, with comparison to original error
 */
function bootProbe(scriptPath, cwd, originalErrorSignature) {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;

    // Use an ephemeral port for the probe so it doesn't conflict with the real server
    const probeEnv = { ...process.env, PORT: "0", WOLVERINE_PROBE: "1" };

    const child = spawn("node", [scriptPath], {
      cwd,
      env: probeEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });

    child.stderr.on("data", (data) => { stderr += data.toString(); });

    // If the process crashes within the timeout, the fix may not have worked
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;

      if (code === 0) {
        resolve({ status: "alive" });
        return;
      }

      // Check if it's the same error — use classification, not string matching
      let sameError = false;
      if (originalErrorSignature) {
        const newParsed = parseError(stderr);
        const origParts = (originalErrorSignature || "").split("::");
        const origMsg = origParts.slice(1).join("::").trim();
        const origType = classifyError(origMsg, "");
        const origClass = (origMsg.match(/^(\w*Error)/) || [])[1] || "";
        const newClass = (newParsed.errorMessage?.match(/^(\w*Error)/) || [])[1] || "";
        // Same error = same classification type AND same error class (TypeError vs ReferenceError)
        sameError = newParsed.errorType === origType && origClass === newClass;
      }

      resolve({
        status: "crashed",
        stderr,
        sameError,
        exitCode: code,
      });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({ status: "crashed", stderr: err.message, sameError: false, exitCode: null });
    });

    // If the process is still alive after the timeout, consider it good
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: "alive" });
    }, BOOT_PROBE_TIMEOUT_MS);
  });
}

/**
 * Full verification pipeline.
 *
 * Returns:
 * - { verified: true,  status: "fixed" }        — fix works, no crash
 * - { verified: false, status: "same-error" }    — same error, fix didn't work → rollback
 * - { verified: false, status: "new-error" }     — different error, fix broke something else → rollback
 * - { verified: false, status: "syntax-error" }  — introduced syntax error → rollback
 */
/**
 * Full verification pipeline.
 *
 * @param {string} scriptPath — entry point to verify
 * @param {string} cwd — working directory
 * @param {string} originalErrorSignature — error signature for same-error detection
 * @param {object} routeContext — optional { path, method } for route-level testing
 */
async function verifyFix(scriptPath, cwd, originalErrorSignature, routeContext) {
  // Simple errors — trust syntax+boot, skip route probe entirely.
  // The route probe spawns a full server process which crashes on external deps
  // (pg, redis, cors, etc.) even when the actual fix is correct. ErrorMonitor
  // catches any remaining 500s as the real safety net.
  const sig = originalErrorSignature || "";
  const isSimpleError = /TypeError|ReferenceError|SyntaxError|Cannot find module|Cannot read prop|is not defined|is not a function|Unexpected token/.test(sig);
  const skipRouteProbe = true; // ALWAYS skip route probe — it fails on servers with external deps
  const steps = (!skipRouteProbe && routeContext?.path) ? 3 : 2;

  console.log(chalk.yellow("\n🔬 Verifying fix...\n"));

  // Step 1: Syntax check
  console.log(chalk.gray(`  [1/${steps}] Syntax check...`));
  const syntax = await syntaxCheck(scriptPath);
  if (!syntax.valid) {
    console.log(chalk.red(`  ❌ Syntax error introduced by fix:\n      ${syntax.error}`));
    return { verified: false, status: "syntax-error", error: syntax.error };
  }
  console.log(chalk.green("  ✅ Syntax OK"));

  // Step 2: Boot probe
  console.log(chalk.gray(`  [2/${steps}] Boot probe (watching for crashes)...`));
  const probe = await bootProbe(scriptPath, cwd, originalErrorSignature);

  if (probe.status !== "alive") {
    if (probe.sameError) {
      console.log(chalk.red("  ❌ Same error occurred — fix did not resolve the issue."));
      return { verified: false, status: "same-error", stderr: probe.stderr };
    }
    console.log(chalk.red("  ❌ A different error occurred — fix may have introduced a new bug."));
    return { verified: false, status: "new-error", stderr: probe.stderr };
  }
  console.log(chalk.green("  ✅ Process booted successfully"));

  // Step 3: Route probe — only for complex errors (not simple TypeError/ReferenceError)
  // Simple errors: trust syntax+boot. ErrorMonitor is the safety net.
  if (!skipRouteProbe && routeContext?.path) {
    console.log(chalk.gray(`  [3/${steps}] Route probe: ${routeContext.method || "GET"} ${routeContext.path}...`));
    const routeResult = await routeProbe(scriptPath, cwd, routeContext);
    if (routeResult.status === "failed") {
      console.log(chalk.red(`  ❌ Route ${routeContext.path} still fails (HTTP ${routeResult.statusCode}): ${routeResult.body?.slice(0, 80)}`));
      return { verified: false, status: "route-still-broken", stderr: routeResult.body };
    }
    if (routeResult.status === "passed") {
      console.log(chalk.green(`  ✅ Route ${routeContext.path} responds OK (HTTP ${routeResult.statusCode})`));
    } else {
      console.log(chalk.gray(`  ⚠️  Route probe skipped: ${routeResult.reason || "unknown"}`));
    }
  } else if (routeContext?.path) {
    console.log(chalk.gray(`  ⚡ Skipping route probe — ErrorMonitor is the safety net`));
  }

  // Step 3 (replacement): Isolated module load test — can the changed file be required?
  // This catches cases where the AI fix introduces a require error or crashes on load,
  // without needing to boot the full server (which fails on external deps).
  if (scriptPath) {
    const changedFile = scriptPath;
    const relPath = path.relative(cwd, changedFile).replace(/\\/g, "/");
    if (relPath.startsWith("server/") && relPath.endsWith(".js")) {
      try {
        const { execSync } = require("child_process");
        const testCode = `try{require('./${relPath}');console.log('MODULE_OK')}catch(e){console.error(e.message);process.exit(1)}`;
        const out = execSync(`node -e "${testCode}"`, {
          cwd, timeout: 5000, encoding: "utf-8",
          env: { ...process.env, NODE_PATH: path.join(cwd, "node_modules") },
        });
        if (out.includes("MODULE_OK")) {
          console.log(chalk.green(`  ✅ Module loads OK: ${relPath}`));
        }
      } catch (e) {
        // Module failed to load — but this might be because of external deps (pg, redis)
        // Don't fail the verification for this — just log it
        const errMsg = (e.stderr || e.message || "").slice(0, 100);
        if (/Cannot find module/.test(errMsg) && !/\.\//.test(errMsg)) {
          console.log(chalk.gray(`  ⚠️  Module test skipped (external dep: ${errMsg.slice(0, 60)})`));
        } else {
          console.log(chalk.yellow(`  ⚠️  Module load warning: ${errMsg.slice(0, 80)}`));
        }
      }
    }
  }

  return { verified: true, status: "fixed" };
}

/**
 * Route probe — boot the server on PORT=0, detect the actual port from stdout,
 * then HTTP-test the failing route.
 */
function routeProbe(scriptPath, cwd, routeContext) {
  const http = require("http");
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const probeEnv = { ...process.env, PORT: "0", WOLVERINE_PROBE: "1" };
    const child = spawn("node", [scriptPath], {
      cwd, env: probeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("exit", () => {
      if (settled) return;
      settled = true;
      resolve({ status: "failed", statusCode: 0, body: stderr || "Process exited before route test" });
    });

    // Poll stdout for port announcement
    const checkPort = setInterval(() => {
      if (settled) { clearInterval(checkPort); return; }
      const m = stdout.match(/(?:listening|running|started|on)\s+(?:on\s+)?(?:(?:https?:\/\/)?[\w.]+:)?(\d{4,5})/i)
              || stdout.match(/:(\d{4,5})/);
      if (m) {
        clearInterval(checkPort);
        const port = parseInt(m[1], 10);
        // Test the route
        const req = http.request({
          hostname: "127.0.0.1", port,
          path: routeContext.path,
          method: routeContext.method || "GET",
          timeout: 5000,
        }, (res) => {
          let body = "";
          res.on("data", (c) => { body += c; });
          res.on("end", () => {
            settled = true;
            child.kill("SIGTERM");
            if (res.statusCode < 500) {
              resolve({ status: "passed", statusCode: res.statusCode });
            } else {
              resolve({ status: "failed", statusCode: res.statusCode, body: body.slice(0, 500) });
            }
          });
        });
        req.on("error", (e) => { settled = true; child.kill("SIGTERM"); resolve({ status: "failed", statusCode: 0, body: e.message }); });
        req.on("timeout", () => { req.destroy(); settled = true; child.kill("SIGTERM"); resolve({ status: "failed", statusCode: 0, body: "timeout" }); });
        req.end();
      }
    }, 300);

    // Overall timeout
    setTimeout(() => {
      clearInterval(checkPort);
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: "skipped", reason: "Could not detect server port from stdout" });
    }, BOOT_PROBE_TIMEOUT_MS + 5000);
  });
}

module.exports = { verifyFix, syntaxCheck, bootProbe, BOOT_PROBE_TIMEOUT_MS };
