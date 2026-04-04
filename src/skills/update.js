/**
 * Update Skill — safe self-updating for the wolverine framework.
 *
 * WARNING: raw `npm install` or `git pull` can overwrite server/ and .wolverine/.
 * This skill updates ONLY framework files and never touches the server.
 *
 * What it does:
 * 1. Creates emergency backup of server/ + brain (small, no node_modules)
 * 2. Selectively updates ONLY framework files (src/, bin/, package.json)
 * 3. server/ is NEVER touched — no backup/restore dance needed
 * 4. Signals brain to merge new seed docs on next boot
 *
 * Emergency backup is for rollback ONLY if something goes wrong.
 * Located in ~/.wolverine-safe-backups/ (outside project, survives everything).
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const os = require("os");

const PACKAGE_NAME = "wolverine-ai";
const SAFE_BACKUP_DIR = path.join(os.homedir(), ".wolverine-safe-backups");

// Files/dirs to SKIP when backing up server/ (these are huge and not user code)
const SKIP_DIRS = new Set(["node_modules", ".git", ".wolverine", "dist", ".next", ".cache"]);

/**
 * Create an emergency backup — server/ code + brain only.
 * Small and fast. No node_modules, no backup-of-backups.
 */
function createSafeBackup(cwd) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = path.join(SAFE_BACKUP_DIR, "updates", timestamp);
  fs.mkdirSync(backupDir, { recursive: true });

  let fileCount = 0;

  // Backup server/ (user code only — skip node_modules, .git, etc.)
  const serverDir = path.join(cwd, "server");
  if (fs.existsSync(serverDir)) {
    fileCount += _copyDirSelective(serverDir, path.join(backupDir, "server"));
  }

  // Backup brain vectors (the learned knowledge)
  const brainStore = path.join(cwd, ".wolverine", "brain", "vectors.json");
  if (fs.existsSync(brainStore)) {
    fs.mkdirSync(path.join(backupDir, ".wolverine", "brain"), { recursive: true });
    fs.copyFileSync(brainStore, path.join(backupDir, ".wolverine", "brain", "vectors.json"));
    fileCount++;
  }

  // Backup .env files
  for (const f of [".env.local", ".env"]) {
    const fp = path.join(cwd, f);
    if (fs.existsSync(fp)) { fs.copyFileSync(fp, path.join(backupDir, f)); fileCount++; }
  }

  // Write manifest
  fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify({
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    cwd,
    version: _getCurrentVersion(cwd),
    fileCount,
    type: "pre-update",
  }, null, 2), "utf-8");

  return { dir: backupDir, fileCount, timestamp };
}

/**
 * List available safe backups.
 */
function listSafeBackups() {
  const updatesDir = path.join(SAFE_BACKUP_DIR, "updates");
  if (!fs.existsSync(updatesDir)) return [];
  return fs.readdirSync(updatesDir)
    .filter(d => { try { return fs.statSync(path.join(updatesDir, d)).isDirectory(); } catch { return false; } })
    .map(d => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(updatesDir, d, "manifest.json"), "utf-8"));
        return { dir: d, ...manifest };
      } catch { return { dir: d }; }
    })
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

/**
 * Restore from a safe backup (emergency only).
 */
function restoreFromSafeBackup(cwd, backupName) {
  const backupDir = path.join(SAFE_BACKUP_DIR, "updates", backupName);
  if (!fs.existsSync(backupDir)) throw new Error(`Backup not found: ${backupName}`);

  let restored = 0;

  // Restore server/
  const serverSrc = path.join(backupDir, "server");
  if (fs.existsSync(serverSrc)) {
    restored += _copyDirSelective(serverSrc, path.join(cwd, "server"));
  }

  // Restore brain
  const brainSrc = path.join(backupDir, ".wolverine", "brain", "vectors.json");
  if (fs.existsSync(brainSrc)) {
    const dest = path.join(cwd, ".wolverine", "brain", "vectors.json");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(brainSrc, dest);
    restored++;
  }

  // Restore .env files
  for (const f of [".env.local", ".env"]) {
    const src = path.join(backupDir, f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(cwd, f)); restored++; }
  }

  return { restored, backupDir };
}

/**
 * Safe update — the main entry point.
 * Updates framework files ONLY. server/ is never touched.
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

  // 2. Emergency backup (server code + brain only — small and fast)
  console.log(chalk.gray("  🔒 Creating emergency backup..."));
  const backup = createSafeBackup(cwd);
  console.log(chalk.gray(`  🔒 Backed up ${backup.fileCount} files to ${backup.dir}`));
  if (logger) logger.info("update.backup", `Emergency backup: ${backup.fileCount} files`, { dir: backup.dir });

  try {
    // 3. Update framework ONLY — server/ is never touched
    if (isGit) {
      console.log(chalk.blue("  📦 Selective git update (server/ untouched)"));
      // ONLY update framework files — never touch server/ or its deps
      const frameworkPaths = "src/ bin/ examples/ tests/ CLAUDE.md README.md CHANGELOG.md .npmignore";
      execSync(`git checkout origin/master -- ${frameworkPaths}`, { cwd, stdio: "pipe", timeout: 30000 });
      // Update package.json separately, then install deps to restore anything lost
      execSync("git checkout origin/master -- package.json", { cwd, stdio: "pipe", timeout: 10000 });
      execSync("npm install", { cwd, stdio: "pipe", timeout: 120000 });
    } else {
      const cmd = `npm install ${PACKAGE_NAME}@${latestVersion}`;
      console.log(chalk.blue(`  📦 ${cmd}`));
      execSync(cmd, { cwd, stdio: "pipe", timeout: 120000 });
    }

    // 4. Signal brain to merge new seeds on next boot
    const seedRefreshDir = path.join(cwd, ".wolverine", "brain");
    fs.mkdirSync(seedRefreshDir, { recursive: true });
    fs.writeFileSync(path.join(seedRefreshDir, ".seed-refresh"), new Date().toISOString(), "utf-8");
    console.log(chalk.gray("  🧠 Brain seed merge scheduled for next boot"));

    // Clear Node's require cache for package.json so we read the new version
    const pkgPath = path.resolve(cwd, "package.json");
    delete require.cache[pkgPath];
    const newVersion = _getCurrentVersion(cwd);
    console.log(chalk.green(`  ✅ Updated: ${currentVersion} → ${newVersion}`));
    console.log(chalk.gray(`  🔒 Emergency backup at: ${backup.dir}`));
    if (logger) logger.info("update.success", `Updated ${currentVersion} → ${newVersion}`, { from: currentVersion, to: newVersion });

    return { success: true, from: currentVersion, to: newVersion, backupDir: backup.dir };
  } catch (err) {
    const errMsg = (err.message || "").slice(0, 100);
    console.log(chalk.red(`  ❌ Update failed: ${errMsg}`));
    console.log(chalk.yellow(`  🔒 Restore with: wolverine --restore ${backup.timestamp}`));
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

/**
 * Copy directory recursively, skipping node_modules/.git/.wolverine/dist etc.
 * Returns file count.
 */
function _copyDirSelective(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) { count += _copyDirSelective(s, d); }
    else {
      try {
        const stat = fs.statSync(s);
        if (stat.size <= 5 * 1024 * 1024) { fs.copyFileSync(s, d); count++; } // skip >5MB
      } catch {}
    }
  }
  return count;
}

// ── Skill Metadata ──

const SKILL_NAME = "update";
const SKILL_DESCRIPTION = "Safe self-updating for wolverine framework. Creates emergency backup of server code + brain (no node_modules), selectively updates only framework files (src/, bin/, package.json), never touches server/. Never use raw npm install or git pull.";
const SKILL_KEYWORDS = ["update", "upgrade", "version", "install", "pull", "self-update", "auto-update", "framework", "safe"];
const SKILL_USAGE = `// Safe update (programmatic)
const { safeUpdate } = require("wolverine-ai");
const result = safeUpdate(process.cwd());

// CLI
// wolverine --update
// wolverine --update --dry-run
// wolverine --backups
// wolverine --restore 2026-04-02T21-15-00`;

module.exports = {
  SKILL_NAME, SKILL_DESCRIPTION, SKILL_KEYWORDS, SKILL_USAGE,
  safeUpdate, createSafeBackup, listSafeBackups, restoreFromSafeBackup,
};
