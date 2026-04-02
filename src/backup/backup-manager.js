const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const { redact } = require("../security/secret-redactor");

/**
 * Backup Manager — full server/ directory snapshots with lifecycle management.
 *
 * Lifecycle: UNSTABLE → VERIFIED → STABLE
 * Every backup is a complete copy of server/ (code, configs, databases).
 * Admins can rollback, undo rollbacks, and hot-load any backup state.
 *
 * Retention: unstable/verified pruned after 7 days.
 * Stable backups older than 7 days → keep 1 per day (most recent).
 */

const os = require("os");

// Safe backup location — OUTSIDE the project directory.
// Survives git pull, npm install, rm -rf .wolverine, project deletion.
// All backup infrastructure (heal snapshots, update snapshots, rollbacks) uses this.
const SAFE_BACKUP_ROOT = path.join(os.homedir(), ".wolverine-safe-backups");
const MANIFEST_FILE_NAME = "manifest.json";
const STABILITY_THRESHOLD_MS = 30 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Files that should NEVER be overwritten during rollback.
// These are platform/infrastructure files that would break the server if rolled back.
const NEVER_ROLLBACK = [
  "server/config/settings.json",
  "server/lib/db.js",
  "server/lib/redis.js",
  ".env",
  ".env.local",
];

class BackupManager {
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    // All backups in safe home directory — never inside the project
    this.backupsDir = path.join(SAFE_BACKUP_ROOT, "snapshots");
    this.manifestPath = path.join(SAFE_BACKUP_ROOT, MANIFEST_FILE_NAME);
    this._ensureDirs();
    this._migrateOldBackups(); // one-time migration from .wolverine/backups/
    this.manifest = this._loadManifest();
  }

  /**
   * Create a full server/ backup.
   * @param {string} reason — why this backup was created
   * @returns {string} backupId
   */
  createBackup(reason = "manual") {
    const backupId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    const timestamp = Date.now();
    const backupDir = path.join(this.backupsDir, backupId);
    fs.mkdirSync(backupDir, { recursive: true });

    const filePaths = this._collectServerFiles();
    const files = [];

    for (const filePath of filePaths) {
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.projectRoot, filePath);
      if (!fs.existsSync(absPath)) continue;
      try {
        const stat = fs.statSync(absPath);
        if (stat.size > 10 * 1024 * 1024) continue; // skip >10MB
      } catch { continue; }

      const relativePath = path.relative(this.projectRoot, absPath);
      const backupFile = path.join(backupDir, relativePath.replace(/[/\\]/g, "__"));
      fs.copyFileSync(absPath, backupFile);

      files.push({
        original: absPath,
        relative: relativePath,
        backup: backupFile,
      });
    }

    const entry = {
      id: backupId,
      timestamp,
      status: "unstable",
      reason: redact(reason),
      files,
      fileCount: files.length,
      errorSignature: null,
      promotedAt: null,
      verifiedAt: null,
    };

    this.manifest.backups.push(entry);
    this._saveManifest();

    console.log(chalk.gray(`  💾 Backup ${backupId} (${files.length} files) — ${reason}`));
    return backupId;
  }

  /**
   * Rollback to a specific backup. Creates a pre-rollback backup first.
   * @returns {{ success, preRollbackId }}
   */
  rollbackTo(backupId) {
    const entry = this.manifest.backups.find(b => b.id === backupId);
    if (!entry) {
      console.log(chalk.red(`Backup ${backupId} not found.`));
      return { success: false };
    }

    // Create a pre-rollback backup so admins can undo
    const preRollbackId = this.createBackup(`pre-rollback (before restoring ${backupId})`);

    let allRestored = true;
    for (const file of entry.files) {
      // Skip protected config/infrastructure files
      if (NEVER_ROLLBACK.some(p => file.relative === p || file.relative.endsWith(p))) {
        console.log(chalk.gray(`  🔒 Skipped (protected): ${file.relative}`));
        continue;
      }
      if (fs.existsSync(file.backup)) {
        fs.mkdirSync(path.dirname(file.original), { recursive: true });
        fs.copyFileSync(file.backup, file.original);
        console.log(chalk.yellow(`  ↩️  Restored: ${file.relative}`));
      } else {
        console.log(chalk.red(`  ❌ Backup file missing: ${file.backup}`));
        allRestored = false;
      }
    }

    // Log the rollback
    if (!this.manifest.rollbackLog) this.manifest.rollbackLog = [];
    this.manifest.rollbackLog.push({
      timestamp: Date.now(),
      restoredBackupId: backupId,
      preRollbackBackupId: preRollbackId,
      success: allRestored,
    });
    this._saveManifest();

    return { success: allRestored, preRollbackId };
  }

  /**
   * Rollback the most recent backup.
   */
  rollbackLatest() {
    if (this.manifest.backups.length === 0) return { success: false };
    const latest = this.manifest.backups[this.manifest.backups.length - 1];
    console.log(chalk.yellow(`\n↩️  Rolling back to ${latest.id} (${new Date(latest.timestamp).toISOString()})...`));
    return this.rollbackTo(latest.id);
  }

  /**
   * Undo the last rollback — restores the pre-rollback state.
   */
  undoRollback() {
    if (!this.manifest.rollbackLog || this.manifest.rollbackLog.length === 0) {
      console.log(chalk.red("No rollback to undo."));
      return { success: false };
    }
    const lastRollback = this.manifest.rollbackLog[this.manifest.rollbackLog.length - 1];
    console.log(chalk.yellow(`\n↩️  Undoing rollback — restoring pre-rollback state ${lastRollback.preRollbackBackupId}...`));

    const entry = this.manifest.backups.find(b => b.id === lastRollback.preRollbackBackupId);
    if (!entry) {
      console.log(chalk.red("Pre-rollback backup not found."));
      return { success: false };
    }

    let allRestored = true;
    for (const file of entry.files) {
      if (NEVER_ROLLBACK.some(p => file.relative === p || file.relative.endsWith(p))) continue;
      if (fs.existsSync(file.backup)) {
        fs.mkdirSync(path.dirname(file.original), { recursive: true });
        fs.copyFileSync(file.backup, file.original);
      } else { allRestored = false; }
    }

    this.manifest.rollbackLog.push({
      timestamp: Date.now(),
      action: "undo",
      restoredBackupId: lastRollback.preRollbackBackupId,
      success: allRestored,
    });
    this._saveManifest();
    return { success: allRestored };
  }

  markVerified(backupId) {
    const entry = this.manifest.backups.find(b => b.id === backupId);
    if (entry && entry.status === "unstable") {
      entry.status = "verified";
      entry.verifiedAt = Date.now();
      this._saveManifest();
    }
  }

  markStable(backupId) {
    const entry = this.manifest.backups.find(b => b.id === backupId);
    if (entry && (entry.status === "verified" || entry.status === "unstable")) {
      entry.status = "stable";
      entry.promotedAt = Date.now();
      this._saveManifest();
      console.log(chalk.green(`  🏆 Backup ${backupId} promoted to STABLE.`));
    }
  }

  setErrorSignature(backupId, signature) {
    const entry = this.manifest.backups.find(b => b.id === backupId);
    if (entry) { entry.errorSignature = signature; this._saveManifest(); }
  }

  /**
   * Shutdown backup — called on graceful server shutdown.
   */
  createShutdownBackup() {
    return this.createBackup("server-shutdown");
  }

  /**
   * Get all backups for dashboard.
   */
  getAll() {
    return this.manifest.backups;
  }

  /**
   * Get rollback log for dashboard.
   */
  getRollbackLog() {
    return this.manifest.rollbackLog || [];
  }

  /**
   * Prune old backups per retention policy.
   */
  prune() {
    const now = Date.now();
    const cutoff = now - RETENTION_MS;
    let pruned = 0;
    const toKeep = [];
    const stableOld = [];

    for (const entry of this.manifest.backups) {
      if (entry.status === "stable") {
        if (entry.timestamp < cutoff) stableOld.push(entry);
        else toKeep.push(entry);
      } else {
        if (entry.timestamp < cutoff) { this._deleteBackupFiles(entry); pruned++; }
        else toKeep.push(entry);
      }
    }

    if (stableOld.length > 0) {
      const byDay = new Map();
      for (const entry of stableOld) {
        const dayKey = new Date(entry.timestamp).toISOString().slice(0, 10);
        if (!byDay.has(dayKey)) byDay.set(dayKey, []);
        byDay.get(dayKey).push(entry);
      }
      for (const [, dayEntries] of byDay) {
        dayEntries.sort((a, b) => b.timestamp - a.timestamp);
        toKeep.push(dayEntries[0]);
        for (let i = 1; i < dayEntries.length; i++) { this._deleteBackupFiles(dayEntries[i]); pruned++; }
      }
    }

    this.manifest.backups = toKeep;
    this._saveManifest();
    if (pruned > 0) console.log(chalk.gray(`  🧹 Pruned ${pruned} old backup(s).`));
    return pruned;
  }

  getStats() {
    const counts = { unstable: 0, verified: 0, stable: 0 };
    for (const entry of this.manifest.backups) {
      counts[entry.status] = (counts[entry.status] || 0) + 1;
    }
    return { total: this.manifest.backups.length, ...counts };
  }

  // -- Private --

  _ensureDirs() {
    fs.mkdirSync(this.backupsDir, { recursive: true });
    fs.mkdirSync(SAFE_BACKUP_ROOT, { recursive: true });
  }

  /**
   * One-time migration: move backups from old .wolverine/backups/ to safe location.
   */
  _migrateOldBackups() {
    const oldDir = path.join(this.projectRoot, ".wolverine", "backups");
    const oldManifest = path.join(oldDir, "manifest.json");
    if (!fs.existsSync(oldManifest) || fs.existsSync(this.manifestPath)) return;

    try {
      // Copy manifest
      fs.copyFileSync(oldManifest, this.manifestPath);
      // Copy backup dirs
      for (const entry of fs.readdirSync(oldDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const src = path.join(oldDir, entry.name);
        const dest = path.join(this.backupsDir, entry.name);
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(dest, { recursive: true });
          for (const file of fs.readdirSync(src)) {
            fs.copyFileSync(path.join(src, file), path.join(dest, file));
          }
        }
      }
      console.log(chalk.gray(`  📦 Migrated backups to safe location: ${SAFE_BACKUP_ROOT}`));
    } catch {}
  }

  _loadManifest() {
    if (fs.existsSync(this.manifestPath)) {
      try { return JSON.parse(fs.readFileSync(this.manifestPath, "utf-8")); }
      catch { return { version: 1, backups: [], rollbackLog: [] }; }
    }
    return { version: 1, backups: [], rollbackLog: [] };
  }

  _saveManifest() {
    const tmp = this.manifestPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.manifest, null, 2), "utf-8");
    fs.renameSync(tmp, this.manifestPath);
  }

  _deleteBackupFiles(entry) {
    const backupDir = path.join(this.backupsDir, entry.id);
    if (fs.existsSync(backupDir)) {
      for (const file of fs.readdirSync(backupDir)) fs.unlinkSync(path.join(backupDir, file));
      fs.rmdirSync(backupDir);
    }
  }

  _collectServerFiles() {
    const serverDir = path.join(this.projectRoot, "server");
    if (!fs.existsSync(serverDir)) return [];
    const files = [];
    const SKIP = new Set(["node_modules", ".git", ".wolverine"]);

    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else {
          try { if (fs.statSync(fullPath).size <= 10 * 1024 * 1024) files.push(fullPath); } catch {}
        }
      }
    };
    walk(serverDir);
    return files;
  }
}

module.exports = { BackupManager, STABILITY_THRESHOLD_MS, SAFE_BACKUP_ROOT };
