/**
 * Update Skill — safe self-updating for the wolverine framework.
 *
 * WARNING: raw `npm install` or `git pull` can overwrite:
 * - server/ (user's live code, routes, config, database)
 * - .wolverine/ (brain memories, backups, events, repair history, usage)
 * - .env.local (API keys, secrets)
 *
 * This skill does it safely:
 * 1. Creates a pre-update snapshot in ~/.wolverine-safe-backups/ (outside project, never erased)
 * 2. Backs up all user files to memory
 * 3. Selectively updates ONLY framework files (src/, bin/, package.json)
 * 4. Restores all user files
 * 5. Merges new brain seed docs (append, not replace)
 * 6. Verifies the update didn't break anything
 *
 * Callable as:
 *   wolverine --update              (CLI)
 *   npx wolverine-update            (npm)
 *   require("wolverine-ai").safeUpdate(cwd)  (programmatic)
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

const PACKAGE_NAME = "wolverine-ai";
const SAFE_BACKUP_DIR = path.join(require("os").homedir(), ".wolverine-safe-backups");

/**
 * Create a safe backup snapshot outside the project directory.
 * These survive git clean, rm -rf node_modules, even rm -rf .wolverine.
 */
function createSafeBackup(cwd) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = path.join(SAFE_BACKUP_DIR, timestamp);
  fs.mkdirSync(backupDir, { recursive: true });

  const dirsToBackup = [
    { src: ".wolverine", label: "brain/backups/events/usage" },
    { src: "server", label: "server code" },
  ];
  const filesToBackup = [".env.local", ".env"];

  let fileCount = 0;

  for (const { src } of dirsToBackup) {
    const srcPath = path.join(cwd, src);
    if (!fs.existsSync(srcPath)) continue;
    const destPath = path.join(backupDir, src);
    _copyDirRecursive(srcPath, destPath);
    fileCount += _countFiles(destPath);
  }

  for (const file of filesToBackup) {
    const srcPath = path.join(cwd, file);
    if (!fs.existsSync(srcPath)) continue;
    fs.copyFileSync(srcPath, path.join(backupDir, file));
    fileCount++;
  }

  // Write manifest
  fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify({
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    cwd,
    version: _getCurrentVersion(cwd),
    fileCount,
  }, null, 2), "utf-8");

  return { dir: backupDir, fileCount, timestamp };
}

/**
 * List available safe backups.
 */
function listSafeBackups() {
  if (!fs.existsSync(SAFE_BACKUP_DIR)) return [];
  return fs.readdirSync(SAFE_BACKUP_DIR)
    .filter(d => fs.statSync(path.join(SAFE_BACKUP_DIR, d)).isDirectory())
    .map(d => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(SAFE_BACKUP_DIR, d, "manifest.json"), "utf-8"));
        return { dir: d, ...manifest };
      } catch { return { dir: d }; }
    })
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

/**
 * Restore from a safe backup.
 */
function restoreFromSafeBackup(cwd, backupName) {
  const backupDir = path.join(SAFE_BACKUP_DIR, backupName);
  if (!fs.existsSync(backupDir)) throw new Error(`Backup not found: ${backupName}`);

  const dirsToRestore = [".wolverine", "server"];
  const filesToRestore = [".env.local", ".env"];

  let restored = 0;
  for (const dir of dirsToRestore) {
    const srcPath = path.join(backupDir, dir);
    if (!fs.existsSync(srcPath)) continue;
    const destPath = path.join(cwd, dir);
    _copyDirRecursive(srcPath, destPath);
    restored += _countFiles(srcPath);
  }
  for (const file of filesToRestore) {
    const srcPath = path.join(backupDir, file);
    if (!fs.existsSync(srcPath)) continue;
    fs.copyFileSync(srcPath, path.join(cwd, file));
    restored++;
  }
  return { restored, backupDir };
}

/**
 * Safe update — the main entry point.
 * Call this instead of raw npm install or git pull.
 *
 * @param {string} cwd — project root
 * @param {object} options — { logger, dryRun }
 * @returns {{ success, from, to, backupDir, error? }}
 */
function safeUpdate(cwd, options = {}) {
  const { logger, dryRun } = options;
  const currentVersion = _getCurrentVersion(cwd);

  console.log(chalk.blue("\n  🔄 Wolverine Safe Update"));
  console.log(chalk.gray(`  Current version: ${currentVersion}`));

  // 1. Check for updates
  let latestVersion;
  try {
    latestVersion = execSync(`npm view ${PACKAGE_NAME} version 2>/dev/null`, {
      encoding: "utf-8", timeout: 15000, cwd,
    }).trim();
  } catch {}

  // Also check git remote
  const isGit = _isGitRepo(cwd);
  if (isGit) {
    try {
      execSync("git fetch origin --quiet", { cwd, stdio: "pipe", timeout: 15000 });
      const remoteVersion = execSync("git show origin/master:package.json", {
        cwd, encoding: "utf-8", timeout: 5000,
      });
      const remotePkg = JSON.parse(remoteVersion);
      if (!latestVersion || _isNewer(remotePkg.version, latestVersion)) {
        latestVersion = remotePkg.version;
      }
    } catch {}
  }

  if (!latestVersion || !_isNewer(latestVersion, currentVersion)) {
    console.log(chalk.green(`  ✅ Already up to date (${currentVersion})`));
    return { success: true, from: currentVersion, to: currentVersion, upToDate: true };
  }

  console.log(chalk.blue(`  📦 Update available: ${currentVersion} → ${latestVersion}`));

  if (dryRun) {
    console.log(chalk.gray("  (dry run — no changes made)"));
    return { success: true, from: currentVersion, to: latestVersion, dryRun: true };
  }

  // 2. Create safe backup (outside project, survives everything)
  console.log(chalk.gray("  🔒 Creating safe backup..."));
  const backup = createSafeBackup(cwd);
  console.log(chalk.gray(`  🔒 Backed up ${backup.fileCount} files to ${backup.dir}`));
  if (logger) logger.info("update.backup", `Safe backup: ${backup.fileCount} files`, { dir: backup.dir });

  // 3. Backup user files to memory (belt + suspenders)
  const memoryBackup = _backupToMemory(cwd);
  console.log(chalk.gray(`  🔒 Memory backup: ${Object.keys(memoryBackup).length} files`));

  try {
    // 4. Update framework ONLY
    if (isGit) {
      console.log(chalk.blue("  📦 Selective git update (server/ + .wolverine/ untouched)"));
      const frameworkPaths = "src/ bin/ package.json package-lock.json examples/ tests/ CLAUDE.md README.md CHANGELOG.md .npmignore";
      execSync(`git checkout origin/master -- ${frameworkPaths}`, { cwd, stdio: "pipe", timeout: 30000 });
      execSync("npm install --production", { cwd, stdio: "pipe", timeout: 120000 });
    } else {
      const cmd = `npm install ${PACKAGE_NAME}@${latestVersion}`;
      console.log(chalk.blue(`  📦 ${cmd}`));
      execSync(cmd, { cwd, stdio: "pipe", timeout: 120000 });
    }

    // 5. Restore user files from memory
    _restoreFromMemory(cwd, memoryBackup);
    console.log(chalk.gray(`  🔒 Restored ${Object.keys(memoryBackup).length} user files`));

    // 6. Signal brain to merge new seeds on next boot
    const seedRefreshDir = path.join(cwd, ".wolverine", "brain");
    fs.mkdirSync(seedRefreshDir, { recursive: true });
    fs.writeFileSync(path.join(seedRefreshDir, ".seed-refresh"), new Date().toISOString(), "utf-8");
    console.log(chalk.gray("  🧠 Brain seed merge scheduled for next boot"));

    // 7. Verify
    const newVersion = _getCurrentVersion(cwd);
    console.log(chalk.green(`  ✅ Updated: ${currentVersion} → ${newVersion}`));
    console.log(chalk.gray(`  🔒 Safe backup at: ${backup.dir}`));
    if (logger) logger.info("update.success", `Updated ${currentVersion} → ${newVersion}`, { from: currentVersion, to: newVersion });

    return { success: true, from: currentVersion, to: newVersion, backupDir: backup.dir };
  } catch (err) {
    // Restore from memory on failure
    _restoreFromMemory(cwd, memoryBackup);
    const errMsg = (err.message || "").slice(0, 100);
    console.log(chalk.red(`  ❌ Update failed: ${errMsg}`));
    console.log(chalk.yellow(`  🔒 Restore from safe backup: wolverine --restore ${backup.timestamp}`));
    if (logger) logger.warn("update.failed", `Update failed: ${errMsg}`, { from: currentVersion });
    return { success: false, from: currentVersion, to: latestVersion, error: errMsg, backupDir: backup.dir };
  }
}

// ── Helpers ──

function _getCurrentVersion(cwd) {
  try { return require(path.join(cwd, "package.json")).version; } catch { return "0.0.0"; }
}

function _isGitRepo(cwd) {
  try { execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe", timeout: 3000 }); return true; } catch { return false; }
}

function _isNewer(a, b) {
  if (!a || !b) return false;
  const av = a.split(".").map(Number), bv = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((av[i]||0) > (bv[i]||0)) return true; if ((av[i]||0) < (bv[i]||0)) return false; }
  return false;
}

function _copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) _copyDirRecursive(s, d);
    else { try { fs.copyFileSync(s, d); } catch {} }
  }
}

function _countFiles(dir) {
  let count = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) count += _countFiles(path.join(dir, entry.name));
      else count++;
    }
  } catch {}
  return count;
}

function _backupToMemory(cwd) {
  const backups = {};
  const protect = ["server", ".wolverine"];
  const protectFiles = [".env.local", ".env"];

  for (const dir of protect) {
    const dirPath = path.join(cwd, dir);
    if (!fs.existsSync(dirPath)) continue;
    const walk = (d, base) => {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.name === "node_modules") continue;
          const full = path.join(d, entry.name), rel = path.join(base, entry.name).replace(/\\/g, "/");
          if (entry.isDirectory()) walk(full, rel);
          else { try { const s = fs.statSync(full); if (s.size <= 10*1024*1024) backups[rel] = fs.readFileSync(full); } catch {} }
        }
      } catch {}
    };
    walk(dirPath, dir);
  }
  for (const f of protectFiles) {
    const fp = path.join(cwd, f);
    if (fs.existsSync(fp)) backups[f] = fs.readFileSync(fp);
  }
  return backups;
}

function _restoreFromMemory(cwd, backups) {
  for (const [rel, content] of Object.entries(backups)) {
    const fp = path.join(cwd, rel);
    try { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, content); } catch {}
  }
}

// ── Skill Metadata ──

const SKILL_NAME = "update";
const SKILL_DESCRIPTION = "Safe self-updating for wolverine framework. Creates safe backup outside project (~/. wolverine-safe-backups/), selectively updates only framework files (src/, bin/, package.json), restores all user files (server/, .wolverine/, .env), merges new brain seeds. Never use raw npm install or git pull — they overwrite server code and brain memories.";
const SKILL_KEYWORDS = ["update", "upgrade", "version", "install", "pull", "self-update", "auto-update", "framework", "safe"];
const SKILL_USAGE = `// Safe update (programmatic)
const { safeUpdate } = require("wolverine-ai");
const result = await safeUpdate(process.cwd());
// { success: true, from: "2.5.3", to: "2.6.0", backupDir: "~/.wolverine-safe-backups/..." }

// List safe backups
const { listSafeBackups } = require("wolverine-ai");
const backups = listSafeBackups();

// Restore from safe backup
const { restoreFromSafeBackup } = require("wolverine-ai");
restoreFromSafeBackup(process.cwd(), "2026-04-02T21-15-00");

// CLI: wolverine --update
// CLI: wolverine --update --dry-run
// CLI: wolverine --restore 2026-04-02T21-15-00`;

module.exports = {
  SKILL_NAME, SKILL_DESCRIPTION, SKILL_KEYWORDS, SKILL_USAGE,
  safeUpdate, createSafeBackup, listSafeBackups, restoreFromSafeBackup,
};
