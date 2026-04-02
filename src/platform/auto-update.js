const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

/**
 * Auto-Updater — self-updating wolverine framework.
 *
 * Checks npm registry for newer wolverine-ai versions on a schedule.
 * When a new version is found, upgrades via npm and restarts.
 *
 * Config/settings are protected: backed up before update, restored after.
 * Disable in settings.json: "autoUpdate": { "enabled": false }
 *
 * Wolverine can't edit files outside server/ directly, but it CAN
 * run bash commands — so npm update is the upgrade path.
 */

const PACKAGE_NAME = "wolverine-ai";
const CHECK_INTERVAL_MS = 3600000; // 1 hour

let _timer = null;
let _currentVersion = null;
let _checking = false;

/**
 * Get the currently installed version.
 */
function getCurrentVersion() {
  if (_currentVersion) return _currentVersion;
  try {
    const pkg = require("../../package.json");
    _currentVersion = pkg.version;
  } catch {
    _currentVersion = "0.0.0";
  }
  return _currentVersion;
}

/**
 * Check for the latest available version.
 * For git repos: checks remote for newer commits via `git ls-remote`.
 * For npm installs: checks npm registry via `npm view`.
 */
function getLatestVersion(cwd) {
  // Try npm registry first (works for both git and npm installs)
  try {
    const result = execSync(`npm view ${PACKAGE_NAME} version 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 15000,
      cwd: cwd || process.cwd(),
    }).trim();
    if (result) return result;
  } catch {}

  // Fallback for git repos: check if remote has newer commits
  try {
    if (isGitRepo(cwd || process.cwd())) {
      execSync("git fetch origin --quiet", { cwd: cwd || process.cwd(), stdio: "pipe", timeout: 15000 });
      const behind = execSync("git rev-list HEAD..origin/master --count", {
        cwd: cwd || process.cwd(), encoding: "utf-8", timeout: 5000,
      }).trim();
      if (parseInt(behind, 10) > 0) {
        // There are newer commits — read version from remote package.json
        try {
          const remoteVersion = execSync("git show origin/master:package.json", {
            cwd: cwd || process.cwd(), encoding: "utf-8", timeout: 5000,
          });
          const pkg = JSON.parse(remoteVersion);
          return pkg.version || null;
        } catch {}
      }
    }
  } catch {}

  return null;
}

/**
 * Compare semver versions. Returns true if latest > current.
 */
function isNewer(latest, current) {
  if (!latest || !current) return false;
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

/**
 * Protect ALL user files before update and restore after.
 * The entire server/ directory is sacred — auto-update must never touch it.
 * Also protects .env files and any user config.
 */
function backupUserFiles(cwd) {
  const backups = {};

  // Protect individual config files
  const protectedFiles = [".env.local", ".env", ".wolverine/mcp.json", ".wolverine/pricing.json"];
  for (const file of protectedFiles) {
    const fullPath = path.join(cwd, file);
    if (fs.existsSync(fullPath)) {
      backups[file] = fs.readFileSync(fullPath, "utf-8");
    }
  }

  // Protect entire server/ directory (recursive)
  const serverDir = path.join(cwd, "server");
  if (fs.existsSync(serverDir)) {
    const walk = (dir, base) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === "node_modules") continue;
          const fullPath = path.join(dir, entry.name);
          const relPath = path.join(base, entry.name).replace(/\\/g, "/");
          if (entry.isDirectory()) { walk(fullPath, relPath); }
          else {
            try { backups[relPath] = fs.readFileSync(fullPath, "utf-8"); } catch {}
          }
        }
      } catch {}
    };
    walk(serverDir, "server");
  }

  return backups;
}

function restoreUserFiles(cwd, backups) {
  for (const [file, content] of Object.entries(backups)) {
    const fullPath = path.join(cwd, file);
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf-8");
    } catch {}
  }
}

/**
 * Detect if this is a git repo or an npm install.
 */
function isGitRepo(cwd) {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe", timeout: 3000 });
    return true;
  } catch { return false; }
}

/**
 * Perform the upgrade. Returns { success, from, to, error? }
 * Supports both npm-installed and git-cloned wolverine.
 */
function upgrade(cwd, logger) {
  const current = getCurrentVersion();
  const latest = getLatestVersion();

  if (!latest || !isNewer(latest, current)) {
    return { success: false, from: current, to: latest, error: "Already up to date" };
  }

  console.log(chalk.blue(`\n  🔄 Wolverine update available: ${current} → ${latest}`));
  if (logger) logger.info("update.start", `Upgrading ${current} → ${latest}`, { from: current, to: latest });

  // Back up ALL user files (server/, .env, configs)
  const userBackups = backupUserFiles(cwd);
  console.log(chalk.gray(`  🔒 Backed up ${Object.keys(userBackups).length} user files (server/ protected)`));

  try {
    const useGit = isGitRepo(cwd);

    if (useGit) {
      // Git-cloned: ONLY update framework files, NEVER touch server/
      // Fetch latest, then selectively checkout only framework dirs
      console.log(chalk.blue(`  📦 Git repo — selective framework update (server/ untouched)`));
      execSync("git fetch origin master", { cwd, stdio: "pipe", timeout: 30000 });
      // Only update: src/, bin/, package.json, examples/, tests/, CLAUDE.md, README.md, CHANGELOG.md
      const frameworkPaths = "src/ bin/ package.json package-lock.json examples/ tests/ CLAUDE.md README.md CHANGELOG.md .npmignore";
      execSync(`git checkout origin/master -- ${frameworkPaths}`, { cwd, stdio: "pipe", timeout: 30000 });
      execSync("npm install", { cwd, stdio: "pipe", timeout: 120000 });
    } else {
      // npm-installed: update the package
      const isGlobal = __dirname.includes("node_modules") && !cwd.includes("node_modules");
      const cmd = isGlobal
        ? `npm install -g ${PACKAGE_NAME}@${latest}`
        : `npm install ${PACKAGE_NAME}@${latest}`;
      console.log(chalk.blue(`  📦 Running: ${cmd}`));
      execSync(cmd, { cwd, stdio: "pipe", timeout: 120000 });
    }

    // Restore ALL user files (server/, .env, configs) — belt AND suspenders
    restoreUserFiles(cwd, userBackups);
    console.log(chalk.gray(`  🔒 Restored ${Object.keys(userBackups).length} user files`));

    // Clear version cache
    _currentVersion = null;

    console.log(chalk.green(`  ✅ Updated to ${latest}`));
    if (logger) logger.info("update.success", `Upgraded to ${latest}`, { from: current, to: latest });

    return { success: true, from: current, to: latest };
  } catch (err) {
    // Restore configs on failure
    restoreConfigs(cwd, configBackups);
    const errMsg = (err.message || "").slice(0, 100);
    console.log(chalk.yellow(`  ⚠️  Update failed: ${errMsg}`));
    if (logger) logger.warn("update.failed", `Upgrade failed: ${errMsg}`, { from: current, to: latest });
    return { success: false, from: current, to: latest, error: errMsg };
  }
}

/**
 * Check for updates (non-blocking). Logs if update available.
 * Call upgrade() separately to actually apply.
 */
function checkForUpdate(cwd) {
  if (_checking) return null;
  _checking = true;
  try {
    const current = getCurrentVersion();
    const latest = getLatestVersion(cwd);
    _checking = false;
    if (latest && isNewer(latest, current)) {
      console.log(chalk.blue(`  🔄 Update available: ${PACKAGE_NAME} ${current} → ${latest}`));
      return { available: true, current, latest };
    }
    return { available: false, current, latest };
  } catch {
    _checking = false;
    return null;
  }
}

/**
 * Start auto-update schedule. Checks every hour (configurable).
 * If autoUpdate is enabled and a new version is found, upgrades and signals restart.
 *
 * @param {object} options
 * @param {string} options.cwd — project root
 * @param {object} options.logger — EventLogger
 * @param {function} options.onUpdate — called after successful update (trigger restart)
 * @param {number} options.intervalMs — check interval (default: 1h)
 */
function startAutoUpdate({ cwd, logger, onUpdate, intervalMs }) {
  const interval = intervalMs || CHECK_INTERVAL_MS;

  // Check on startup (delayed 30s to not block boot)
  console.log(chalk.gray(`  🔄 Auto-update scheduled: first check in 30s, then every ${Math.round(interval / 60000)}min`));
  setTimeout(() => {
    console.log(chalk.gray(`  🔄 Checking for updates (v${getCurrentVersion()})...`));
    const result = checkForUpdate(cwd);
    if (result?.available) {
      const upgraded = upgrade(cwd, logger);
      if (upgraded.success && onUpdate) {
        console.log(chalk.blue("  🔄 Restarting with new version..."));
        onUpdate(upgraded);
      }
    } else if (result) {
      console.log(chalk.gray(`  🔄 Up to date (v${result.current}${result.latest ? ", npm: " + result.latest : ""})`));
    } else {
      console.log(chalk.yellow("  🔄 Update check failed (npm unreachable?)"));
    }
  }, 30000);

  // Periodic check
  _timer = setInterval(() => {
    const result = checkForUpdate(cwd);
    if (result?.available) {
      const upgraded = upgrade(cwd, logger);
      if (upgraded.success && onUpdate) {
        console.log(chalk.blue("  🔄 Restarting with new version..."));
        onUpdate(upgraded);
      }
    }
  }, interval);
}

function stopAutoUpdate() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  getCurrentVersion,
  getLatestVersion,
  isNewer,
  checkForUpdate,
  upgrade,
  startAutoUpdate,
  stopAutoUpdate,
};
