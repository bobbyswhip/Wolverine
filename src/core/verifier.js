const { spawn } = require("child_process");
const chalk = require("chalk");

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

      // Check if it's the same error
      const sameError = originalErrorSignature &&
        stderr.includes(originalErrorSignature.split("::").pop().trim());

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
async function verifyFix(scriptPath, cwd, originalErrorSignature) {
  console.log(chalk.yellow("\n🔬 Verifying fix...\n"));

  // Step 1: Syntax check
  console.log(chalk.gray("  [1/2] Syntax check..."));
  const syntax = await syntaxCheck(scriptPath);
  if (!syntax.valid) {
    console.log(chalk.red(`  ❌ Syntax error introduced by fix:\n      ${syntax.error}`));
    return { verified: false, status: "syntax-error", error: syntax.error };
  }
  console.log(chalk.green("  ✅ Syntax OK"));

  // Step 2: Boot probe
  console.log(chalk.gray("  [2/2] Boot probe (watching for crashes)..."));
  const probe = await bootProbe(scriptPath, cwd, originalErrorSignature);

  if (probe.status === "alive") {
    console.log(chalk.green("  ✅ Process booted successfully and stayed alive."));
    return { verified: true, status: "fixed" };
  }

  // It crashed
  if (probe.sameError) {
    console.log(chalk.red("  ❌ Same error occurred — fix did not resolve the issue."));
    return { verified: false, status: "same-error", stderr: probe.stderr };
  }

  console.log(chalk.red("  ❌ A different error occurred — fix may have introduced a new bug."));
  return { verified: false, status: "new-error", stderr: probe.stderr };
}

module.exports = { verifyFix, syntaxCheck, bootProbe, BOOT_PROBE_TIMEOUT_MS };
