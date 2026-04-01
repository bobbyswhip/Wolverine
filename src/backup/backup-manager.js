const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

/**
 * Smart Backup Manager — manages versioned backups with stability tracking.
 *
 * Backup lifecycle:
 * 1. UNSTABLE: Created when a fix is applied, before verification
 * 2. VERIFIED: The fix ran without immediately crashing (same error)
 * 3. STABLE:   The server ran successfully for STABILITY_THRESHOLD without crashing
 *
 * Retention policy:
 * - Unstable backups: deleted after 7 days
 * - Verified backups: kept for 7 days, then pruned unless promoted to stable
 * - Stable backups:   after 7 days, keep only 1 per day (most recent each day)
 *
 * Storage layout:
 *   .wolverine/
 *     backups/
 *       manifest.json         — tracks all backups with metadata
 *       <timestamp>/          — one directory per backup event
 *         <filename>.bak      — the original file content
 */

const WOLVERINE_DIR = ".wolverine";
const BACKUPS_DIR = path.join(WOLVERINE_DIR, "backups");
const MANIFEST_FILE = path.join(BACKUPS_DIR, "manifest.json");

// Stability threshold: how long the server must run without the same crash
// to consider a fix "stable" (default: 30 minutes)
const STABILITY_THRESHOLD_MS = 30 * 60 * 1000;

// Retention: unstable/verified backups older than this are pruned
const RETENTION_UNSTABLE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class BackupManager {
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    this.backupsDir = path.join(this.projectRoot, BACKUPS_DIR);
    this.manifestPath = path.join(this.projectRoot, MANIFEST_FILE);
    this._ensureDirs();
    this.manifest = this._loadManifest();
  }

  /**
   * Create a backup of specific files or the entire server/ directory.
   * Returns a backupId that can be used to rollback or promote.
   *
   * @param {string[]|null} filePaths — specific files, or null to backup entire server/
   */
  createBackup(filePaths) {
    const backupId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    const timestamp = Date.now();
    const backupDir = path.join(this.backupsDir, backupId);
    fs.mkdirSync(backupDir, { recursive: true });

    // If no specific files, backup the entire server/ directory
    if (!filePaths || filePaths.length === 0) {
      filePaths = this._collectServerFiles();
    }

    const files = [];
    for (const filePath of filePaths) {
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.projectRoot, filePath);
      if (!fs.existsSync(absPath)) continue;
      // Skip large files (>10MB) and binary blobs
      try {
        const stat = fs.statSync(absPath);
        if (stat.size > 10 * 1024 * 1024) continue;
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
      files,
      errorSignature: null,
      promotedAt: null,
      verifiedAt: null,
    };

    this.manifest.backups.push(entry);
    this._saveManifest();

    return backupId;
  }

  /**
   * Rollback to a specific backup.
   */
  rollbackTo(backupId) {
    const entry = this.manifest.backups.find(b => b.id === backupId);
    if (!entry) {
      console.log(chalk.red(`Backup ${backupId} not found.`));
      return false;
    }

    let allRestored = true;
    for (const file of entry.files) {
      if (fs.existsSync(file.backup)) {
        fs.copyFileSync(file.backup, file.original);
        console.log(chalk.yellow(`  ↩️  Restored: ${file.relative}`));
      } else {
        console.log(chalk.red(`  ❌ Backup file missing: ${file.backup}`));
        allRestored = false;
      }
    }

    return allRestored;
  }

  /**
   * Rollback to the most recent backup (any status).
   */
  rollbackLatest() {
    if (this.manifest.backups.length === 0) return false;
    const latest = this.manifest.backups[this.manifest.backups.length - 1];
    console.log(chalk.yellow(`\n↩️  Rolling back to backup ${latest.id} (${new Date(latest.timestamp).toISOString()})...`));
    return this.rollbackTo(latest.id);
  }

  /**
   * Mark a backup as verified (fix didn't immediately reproduce the error).
   */
  markVerified(backupId) {
    const entry = this.manifest.backups.find(b => b.id === backupId);
    if (entry && entry.status === "unstable") {
      entry.status = "verified";
      entry.verifiedAt = Date.now();
      this._saveManifest();
    }
  }

  /**
   * Mark a backup as stable (server ran for the full stability threshold).
   */
  markStable(backupId) {
    const entry = this.manifest.backups.find(b => b.id === backupId);
    if (entry && (entry.status === "verified" || entry.status === "unstable")) {
      entry.status = "stable";
      entry.promotedAt = Date.now();
      this._saveManifest();
      console.log(chalk.green(`  🏆 Backup ${backupId} promoted to STABLE.`));
    }
  }

  /**
   * Set the error signature on a backup (for tracking what error this fix addressed).
   */
  setErrorSignature(backupId, signature) {
    const entry = this.manifest.backups.find(b => b.id === backupId);
    if (entry) {
      entry.errorSignature = signature;
      this._saveManifest();
    }
  }

  /**
   * Run the retention policy — prune old backups.
   *
   * Rules:
   * 1. Unstable/verified backups older than 7 days → delete
   * 2. Stable backups older than 7 days → keep only 1 per day (most recent each day)
   * 3. All stable backups within 7 days → keep
   */
  prune() {
    const now = Date.now();
    const cutoff = now - RETENTION_UNSTABLE_MS;
    let pruned = 0;

    // Separate backups by status
    const toKeep = [];
    const stableOld = [];

    for (const entry of this.manifest.backups) {
      if (entry.status === "stable") {
        if (entry.timestamp < cutoff) {
          stableOld.push(entry);
        } else {
          toKeep.push(entry);
        }
      } else {
        // Unstable or verified
        if (entry.timestamp < cutoff) {
          this._deleteBackupFiles(entry);
          pruned++;
        } else {
          toKeep.push(entry);
        }
      }
    }

    // For old stable backups: keep 1 per day
    if (stableOld.length > 0) {
      const byDay = new Map();
      for (const entry of stableOld) {
        const dayKey = new Date(entry.timestamp).toISOString().slice(0, 10);
        if (!byDay.has(dayKey)) {
          byDay.set(dayKey, []);
        }
        byDay.get(dayKey).push(entry);
      }

      for (const [, dayEntries] of byDay) {
        // Sort by timestamp descending, keep the newest per day
        dayEntries.sort((a, b) => b.timestamp - a.timestamp);
        toKeep.push(dayEntries[0]); // keep the most recent
        for (let i = 1; i < dayEntries.length; i++) {
          this._deleteBackupFiles(dayEntries[i]);
          pruned++;
        }
      }
    }

    this.manifest.backups = toKeep;
    this._saveManifest();

    if (pruned > 0) {
      console.log(chalk.gray(`  🧹 Pruned ${pruned} old backup(s).`));
    }

    return pruned;
  }

  /**
   * Get summary stats for logging.
   */
  getStats() {
    const counts = { unstable: 0, verified: 0, stable: 0 };
    for (const entry of this.manifest.backups) {
      counts[entry.status] = (counts[entry.status] || 0) + 1;
    }
    return {
      total: this.manifest.backups.length,
      ...counts,
    };
  }

  // -- Private --

  _ensureDirs() {
    fs.mkdirSync(this.backupsDir, { recursive: true });
  }

  _loadManifest() {
    if (fs.existsSync(this.manifestPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.manifestPath, "utf-8"));
      } catch {
        return { version: 1, backups: [] };
      }
    }
    return { version: 1, backups: [] };
  }

  _saveManifest() {
    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), "utf-8");
  }

  _deleteBackupFiles(entry) {
    const backupDir = path.join(this.backupsDir, entry.id);
    if (fs.existsSync(backupDir)) {
      for (const file of fs.readdirSync(backupDir)) {
        fs.unlinkSync(path.join(backupDir, file));
      }
      fs.rmdirSync(backupDir);
    }
  }

  /**
   * Collect all files in the server/ directory for full backup.
   * Includes: .js, .json, .sql, .db, .sqlite, .yaml, .yml, .env, .html, .css
   * Excludes: node_modules, .git, large binaries
   */
  _collectServerFiles() {
    const serverDir = path.join(this.projectRoot, "server");
    if (!fs.existsSync(serverDir)) return [];

    const files = [];
    const SKIP = new Set(["node_modules", ".git", ".wolverine"]);
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size <= MAX_FILE_SIZE) {
              files.push(fullPath);
            }
          } catch {}
        }
      }
    };

    walk(serverDir);
    return files;
  }
}

module.exports = { BackupManager, STABILITY_THRESHOLD_MS };
