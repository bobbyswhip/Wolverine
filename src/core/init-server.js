const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

/**
 * Initialize the server/ directory from the built-in template.
 *
 * Called on first run if server/ doesn't exist. NEVER overwrites existing files.
 * This is why wolverine ships without a server/ directory in the npm package —
 * so `npm install` and `git pull` can never destroy user code.
 *
 * The template lives in src/templates/server/ and contains a minimal Fastify
 * server with health, api, and time routes + default settings.json.
 */
function initServer(cwd, scriptPath) {
  const serverDir = path.join(cwd, "server");
  const scriptFile = path.resolve(cwd, scriptPath);

  // If the script file already exists, nothing to do
  if (fs.existsSync(scriptFile)) return false;

  // If server/ exists but the specific script doesn't, don't create — user has their own structure
  if (fs.existsSync(serverDir) && fs.readdirSync(serverDir).length > 0) {
    console.log(chalk.yellow(`  ⚠️  ${scriptPath} not found but server/ exists — skipping template init`));
    return false;
  }

  // Create server/ from template
  const templateDir = path.join(__dirname, "..", "templates", "server");
  if (!fs.existsSync(templateDir)) {
    console.log(chalk.yellow("  ⚠️  No server template found — create server/index.js manually"));
    return false;
  }

  console.log(chalk.blue("  📦 Creating default server/ from template..."));
  _copyDir(templateDir, serverDir);
  console.log(chalk.green("  ✅ Server initialized. Edit server/ to build your app."));
  return true;
}

function _copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      _copyDir(srcPath, destPath);
    } else {
      // NEVER overwrite existing files
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(chalk.gray(`    + ${path.relative(dest, destPath)}`));
      }
    }
  }
}

/**
 * Ensure x402 payment dependencies are installed.
 * Called on startup — checks if @coinbase/x402 is resolvable.
 * Auto-installs if vault is initialized (user wants x402).
 */
function ensureX402Deps(cwd) {
  // Check if x402 packages are needed
  const vaultPath = path.join(cwd, ".wolverine", "vault", "eth.vault");
  const hasVault = fs.existsSync(vaultPath);
  if (!hasVault) return; // No vault = no x402 needed

  // Check if already installed
  try {
    require.resolve("@coinbase/x402");
    require.resolve("x402");
    return; // Already installed
  } catch {}

  // Auto-install x402 deps
  console.log(chalk.blue("  📦 Installing x402 payment dependencies..."));
  try {
    const { execSync } = require("child_process");
    execSync("npm install @coinbase/x402 @x402/core @x402/evm x402 viem --no-save --ignore-engines 2>/dev/null", {
      cwd,
      stdio: "pipe",
      timeout: 60000,
    });
    console.log(chalk.green("  ✅ x402 dependencies installed"));
  } catch (err) {
    console.log(chalk.yellow(`  ⚠️ x402 dep install failed: ${err.message?.slice(0, 80)}`));
    console.log(chalk.gray("    Run manually: npm install @coinbase/x402 x402 viem"));
  }
}

/**
 * Run security audit on startup — detect and auto-fix CVEs.
 * Only runs if node_modules exists. Non-blocking (doesn't prevent startup).
 */
function securityAudit(cwd) {
  if (!fs.existsSync(path.join(cwd, "node_modules"))) return;

  try {
    const { audit } = require("../skills/deps");
    const result = audit(cwd);

    if (result.vulnerabilities === 0) return;

    const severity = result.critical > 0 ? "critical" : result.high > 0 ? "high" : "moderate";
    console.log(chalk.yellow(`  🛡️  Security: ${result.vulnerabilities} vulnerabilities (${result.critical} critical, ${result.high} high, ${result.moderate} moderate)`));

    // Auto-fix if possible (non-breaking only)
    if (result.critical > 0 || result.high > 0) {
      console.log(chalk.blue("  🛡️  Running npm audit fix..."));
      try {
        const { execSync } = require("child_process");
        const output = execSync("npm audit fix 2>&1", { cwd, encoding: "utf-8", timeout: 60000 });
        const changed = output.match(/changed (\d+) package/);
        if (changed) {
          console.log(chalk.green(`  ✅ Fixed: ${changed[0]}`));
        } else {
          console.log(chalk.gray("  🛡️  No auto-fixable vulnerabilities (may need --force or manual update)"));
        }
      } catch (e) {
        console.log(chalk.gray(`  🛡️  npm audit fix: ${e.message?.slice(0, 80)}`));
      }

      // Re-check
      const after = audit(cwd);
      if (after.vulnerabilities < result.vulnerabilities) {
        console.log(chalk.green(`  ✅ Reduced from ${result.vulnerabilities} to ${after.vulnerabilities} vulnerabilities`));
      } else if (after.critical > 0 || after.high > 0) {
        console.log(chalk.yellow(`  ⚠️  ${after.critical + after.high} critical/high vulnerabilities remain — run 'npm audit' for details`));
      }
    }
  } catch {}
}

module.exports = { initServer, ensureX402Deps, securityAudit };
