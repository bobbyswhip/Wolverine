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
 * Check npm registry for the latest published version.
 * Uses `npm view` — no network dependency beyond npm.
 */
function getLatestVersion() {
  try {
    const result = execSync(`npm view ${PACKAGE_NAME} version 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 15000,
    }).trim();
    return result || null;
  } catch {
    return null;
  }
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
 * Protect config files before update and restore after.
 */
function backupConfigs(cwd) {
  const configs = [
    "server/config/settings.json",
    ".env.local",
    ".env",
  ];
  const backups = {};
  for (const file of configs) {
    const fullPath = path.join(cwd, file);
    if (fs.existsSync(fullPath)) {
      backups[file] = fs.readFileSync(fullPath, "utf-8");
    }
  }
  return backups;
}

function restoreConfigs(cwd, backups) {
  for (const [file, content] of Object.entries(backups)) {
    const fullPath = path.join(cwd, file);
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf-8");
    } catch {}
  }
}

/**
 * Perform the upgrade. Returns { success, from, to, error? }
 */
function upgrade(cwd, logger) {
  const current = getCurrentVersion();
  const latest = getLatestVersion();

  if (!latest || !isNewer(latest, current)) {
    return { success: false, from: current, to: latest, error: "Already up to date" };
  }

  console.log(chalk.blue(`\n  🔄 Wolverine update available: ${current} → ${latest}`));
  if (logger) logger.info("update.start", `Upgrading ${current} → ${latest}`, { from: current, to: latest });

  // Back up configs
  const configBackups = backupConfigs(cwd);
  console.log(chalk.gray(`  🔒 Backed up ${Object.keys(configBackups).length} config files`));

  try {
    // Determine install method: global or local
    const isGlobal = __dirname.includes("node_modules") && !cwd.includes("node_modules");
    const cmd = isGlobal
      ? `npm install -g ${PACKAGE_NAME}@${latest}`
      : `npm install ${PACKAGE_NAME}@${latest}`;

    console.log(chalk.blue(`  📦 Running: ${cmd}`));
    execSync(cmd, { cwd, stdio: "pipe", timeout: 120000 });

    // Restore configs (npm might have overwritten them)
    restoreConfigs(cwd, configBackups);
    console.log(chalk.gray(`  🔒 Restored config files`));

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
function checkForUpdate() {
  if (_checking) return null;
  _checking = true;
  try {
    const current = getCurrentVersion();
    const latest = getLatestVersion();
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
    const result = checkForUpdate();
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
    const result = checkForUpdate();
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
