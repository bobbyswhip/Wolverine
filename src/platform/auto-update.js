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

  // Delegate to the update skill for the full safe upgrade routine
  const { safeUpdate } = require("../skills/update");
  _currentVersion = null; // clear cache so next check sees new version
  return safeUpdate(cwd, { logger });
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
