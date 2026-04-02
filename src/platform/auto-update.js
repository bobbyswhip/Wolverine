const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

/**
 * Auto-Updater — self-updating wolverine framework.
 *
 * CRITICAL SAFEGUARDS (learned from $6.92 infinite loop incident):
 * 1. Never re-trigger on same version — tracks last attempted version on disk
 * 2. Verify deps after update — npm ls must pass or update is rolled back
 * 3. Cooldown after failed update — won't retry for 1 hour
 * 4. Max 1 update attempt per boot — prevents restart loops
 */

const PACKAGE_NAME = "wolverine-ai";
const CHECK_INTERVAL_MS = 3600000;
const LOCKFILE = ".wolverine/update-lock.json"; // tracks last attempt

let _timer = null;
let _currentVersion = null;
let _checking = false;
let _attemptedThisBoot = false; // max 1 update per boot

function getCurrentVersion() {
  if (_currentVersion) return _currentVersion;
  try { _currentVersion = require("../../package.json").version; } catch { _currentVersion = "0.0.0"; }
  return _currentVersion;
}

function getLatestVersion(cwd) {
  try {
    return execSync(`npm view ${PACKAGE_NAME} version 2>/dev/null`, {
      encoding: "utf-8", timeout: 15000, cwd: cwd || process.cwd(),
    }).trim() || null;
  } catch {}

  // Git fallback
  try {
    if (_isGitRepo(cwd || process.cwd())) {
      execSync("git fetch origin --quiet", { cwd: cwd || process.cwd(), stdio: "pipe", timeout: 15000 });
      const remoteVersion = execSync("git show origin/master:package.json", {
        cwd: cwd || process.cwd(), encoding: "utf-8", timeout: 5000,
      });
      return JSON.parse(remoteVersion).version || null;
    }
  } catch {}
  return null;
}

function isNewer(latest, current) {
  if (!latest || !current) return false;
  const a = latest.split(".").map(Number), b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

function _isGitRepo(cwd) {
  try { execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe", timeout: 3000 }); return true; } catch { return false; }
}

/**
 * Read the update lock file — prevents retrying same version.
 */
function _readLock(cwd) {
  try {
    const lockPath = path.join(cwd, LOCKFILE);
    if (fs.existsSync(lockPath)) return JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  } catch {}
  return {};
}

function _writeLock(cwd, data) {
  try {
    const lockPath = path.join(cwd, LOCKFILE);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

/**
 * Verify deps are intact after update. Returns true if healthy.
 */
function _verifyDeps(cwd) {
  try {
    execSync("node -e \"require('fastify')\" 2>/dev/null", { cwd, stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    // Try npm install to restore deps
    try {
      console.log(chalk.yellow("  ⚠️  Deps broken after update — running npm install to fix..."));
      execSync("npm install", { cwd, stdio: "pipe", timeout: 120000 });
      execSync("node -e \"require('fastify')\" 2>/dev/null", { cwd, stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

function upgrade(cwd, logger) {
  const current = getCurrentVersion();
  const latest = getLatestVersion(cwd);

  if (!latest || !isNewer(latest, current)) {
    return { success: false, from: current, to: latest, error: "Already up to date" };
  }

  // Check lock — don't retry same version
  const lock = _readLock(cwd);
  if (lock.lastAttemptedVersion === latest) {
    const elapsed = Date.now() - (lock.lastAttemptedAt || 0);
    if (elapsed < 3600000) { // 1 hour cooldown
      console.log(chalk.gray(`  🔄 Skipping ${latest} (already attempted ${Math.round(elapsed / 60000)}min ago)`));
      return { success: false, from: current, to: latest, error: "Already attempted, cooldown active" };
    }
  }

  // Record attempt BEFORE trying (so we don't retry on crash)
  _writeLock(cwd, { lastAttemptedVersion: latest, lastAttemptedAt: Date.now(), from: current });

  const { safeUpdate } = require("../skills/update");
  _currentVersion = null;
  const result = safeUpdate(cwd, { logger });

  // Verify deps after update
  if (result.success) {
    if (!_verifyDeps(cwd)) {
      console.log(chalk.red("  ❌ Update broke dependencies — rolling back"));
      if (logger) logger.error("update.deps_broken", "Update broke dependencies, rolling back");
      // Restore from emergency backup
      try {
        const { restoreFromSafeBackup, listSafeBackups } = require("../skills/update");
        const backups = listSafeBackups();
        if (backups.length > 0) {
          restoreFromSafeBackup(cwd, backups[0].dir);
          console.log(chalk.yellow("  ↩️  Rolled back to pre-update state"));
        }
      } catch {}
      _writeLock(cwd, { lastAttemptedVersion: latest, lastAttemptedAt: Date.now(), from: current, failed: true, reason: "deps_broken" });
      return { success: false, from: current, to: latest, error: "Update broke dependencies" };
    }
  }

  if (result.success) {
    _writeLock(cwd, { lastAttemptedVersion: latest, lastAttemptedAt: Date.now(), from: current, success: true });
  }

  return result;
}

function checkForUpdate(cwd) {
  if (_checking) return null;
  _checking = true;
  try {
    const current = getCurrentVersion();
    const latest = getLatestVersion(cwd);
    _checking = false;

    if (!latest || !isNewer(latest, current)) {
      return { available: false, current, latest };
    }

    // Check lock — don't report available if we already failed on this version
    const lock = _readLock(cwd);
    if (lock.lastAttemptedVersion === latest && lock.failed) {
      const elapsed = Date.now() - (lock.lastAttemptedAt || 0);
      if (elapsed < 3600000) return { available: false, current, latest, locked: true };
    }

    console.log(chalk.blue(`  🔄 Update available: ${PACKAGE_NAME} ${current} → ${latest}`));
    return { available: true, current, latest };
  } catch {
    _checking = false;
    return null;
  }
}

function startAutoUpdate({ cwd, logger, onUpdate, intervalMs }) {
  const interval = intervalMs || CHECK_INTERVAL_MS;

  console.log(chalk.gray(`  🔄 Auto-update scheduled: first check in 30s, then every ${Math.round(interval / 60000)}min`));

  setTimeout(() => {
    if (_attemptedThisBoot) return;
    console.log(chalk.gray(`  🔄 Checking for updates (v${getCurrentVersion()})...`));
    const result = checkForUpdate(cwd);
    if (result?.available) {
      _attemptedThisBoot = true;
      const upgraded = upgrade(cwd, logger);
      if (upgraded.success && onUpdate) {
        console.log(chalk.blue("  🔄 Restarting with new version..."));
        onUpdate(upgraded);
      }
    } else if (result) {
      console.log(chalk.gray(`  🔄 Up to date (v${result.current}${result.latest ? ", npm: " + result.latest : ""}${result.locked ? " [cooldown]" : ""})`));
    } else {
      console.log(chalk.yellow("  🔄 Update check failed (npm unreachable?)"));
    }
  }, 30000);

  _timer = setInterval(() => {
    if (_attemptedThisBoot) return; // max 1 attempt per boot
    const result = checkForUpdate(cwd);
    if (result?.available) {
      _attemptedThisBoot = true;
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

module.exports = { getCurrentVersion, getLatestVersion, isNewer, checkForUpdate, upgrade, startAutoUpdate, stopAutoUpdate };
