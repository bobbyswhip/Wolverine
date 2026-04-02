/**
 * Backup Skill — agent-friendly backup/rollback interface.
 *
 * Wraps BackupManager with simple callable functions and CLI commands.
 * The agent can create snapshots, list backups, rollback, and undo —
 * all through bash_exec or direct function calls.
 *
 * CLI commands (via wolverine):
 *   wolverine --backup "reason"         Create a snapshot
 *   wolverine --rollback <id>           Rollback to a specific backup
 *   wolverine --rollback-latest         Rollback to most recent backup
 *   wolverine --undo-rollback           Undo the last rollback
 *   wolverine --list-backups            List all backups with status
 *
 * Programmatic:
 *   const { backup, rollback, listBackups } = require("wolverine-ai");
 *
 * Agent tool usage (via bash_exec):
 *   bash_exec: node -e "require('./src/skills/backup').backup('.', 'before risky change')"
 *   bash_exec: node -e "require('./src/skills/backup').rollbackLatest('.')"
 */

const path = require("path");
const chalk = require("chalk");

/**
 * Create a backup snapshot of server/.
 * @param {string} cwd — project root
 * @param {string} reason — why this backup was created
 * @returns {{ id, fileCount, reason }}
 */
function backup(cwd, reason = "manual") {
  const { BackupManager } = require("../backup/backup-manager");
  const bm = new BackupManager(cwd);
  const id = bm.createBackup(reason);
  const entry = bm.manifest.backups.find(b => b.id === id);
  console.log(chalk.green(`  💾 Backup created: ${id} (${entry?.fileCount || 0} files) — ${reason}`));
  return { id, fileCount: entry?.fileCount || 0, reason };
}

/**
 * Rollback to a specific backup.
 * @param {string} cwd — project root
 * @param {string} backupId — backup to restore
 * @returns {{ success, preRollbackId }}
 */
function rollback(cwd, backupId) {
  const { BackupManager } = require("../backup/backup-manager");
  const bm = new BackupManager(cwd);
  const result = bm.rollbackTo(backupId);
  if (result.success) {
    console.log(chalk.green(`  ↩️  Rolled back to ${backupId} (pre-rollback: ${result.preRollbackId})`));
  } else {
    console.log(chalk.red(`  ❌ Rollback failed: backup ${backupId} not found`));
  }
  return result;
}

/**
 * Rollback to the most recent backup.
 */
function rollbackLatest(cwd) {
  const { BackupManager } = require("../backup/backup-manager");
  const bm = new BackupManager(cwd);
  const result = bm.rollbackLatest();
  if (result.success) {
    console.log(chalk.green(`  ↩️  Rolled back to latest backup (pre-rollback: ${result.preRollbackId})`));
  } else {
    console.log(chalk.red("  ❌ No backups available to rollback"));
  }
  return result;
}

/**
 * Undo the last rollback.
 */
function undoRollback(cwd) {
  const { BackupManager } = require("../backup/backup-manager");
  const bm = new BackupManager(cwd);
  const result = bm.undoRollback();
  if (result.success) {
    console.log(chalk.green("  ↩️  Undo rollback — restored pre-rollback state"));
  } else {
    console.log(chalk.red("  ❌ No rollback to undo"));
  }
  return result;
}

/**
 * List all backups with status, age, reason, file count.
 * @returns {Array<{ id, status, reason, fileCount, age, timestamp }>}
 */
function listBackups(cwd) {
  const { BackupManager } = require("../backup/backup-manager");
  const bm = new BackupManager(cwd);
  const backups = bm.getAll();
  const stats = bm.getStats();

  console.log(chalk.bold(`\n  Backups: ${stats.total} total (${stats.stable} stable, ${stats.verified} verified, ${stats.unstable} unstable)\n`));

  for (const b of backups.slice(-15).reverse()) {
    const age = Math.round((Date.now() - b.timestamp) / 60000);
    const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
    const icon = b.status === "stable" ? "🟢" : b.status === "verified" ? "🔵" : "⚪";
    console.log(`  ${icon} ${b.id}  ${b.status.padEnd(9)} ${b.fileCount} files  ${ageStr}  ${b.reason || ""}`);
  }
  console.log("");

  return backups.map(b => ({
    id: b.id,
    status: b.status,
    reason: b.reason,
    fileCount: b.fileCount,
    age: Math.round((Date.now() - b.timestamp) / 60000),
    timestamp: b.timestamp,
  }));
}

/**
 * Get rollback log.
 */
function getRollbackLog(cwd) {
  const { BackupManager } = require("../backup/backup-manager");
  const bm = new BackupManager(cwd);
  return bm.getRollbackLog();
}

// ── Skill Metadata ──

const SKILL_NAME = "backup";
const SKILL_DESCRIPTION = "Backup and rollback for server/ directory. Create snapshots before risky changes, rollback to any previous state, undo rollbacks. All backups stored safely in ~/.wolverine-safe-backups/. Agent can use via bash_exec or direct tool calls.";
const SKILL_KEYWORDS = ["backup", "rollback", "restore", "undo", "snapshot", "revert", "save", "recovery"];
const SKILL_USAGE = `// Create backup before making changes
const { backup } = require("wolverine-ai");
backup(process.cwd(), "before adding auth routes");

// List all backups
const { listBackups } = require("wolverine-ai");
listBackups(process.cwd());

// Rollback to specific backup
const { rollback } = require("wolverine-ai");
rollback(process.cwd(), "mngt8mwb-v0sm");

// Rollback to latest
const { rollbackLatest } = require("wolverine-ai");
rollbackLatest(process.cwd());

// Undo last rollback
const { undoRollback } = require("wolverine-ai");
undoRollback(process.cwd());

// CLI:
// wolverine --backup "before auth changes"
// wolverine --list-backups
// wolverine --rollback mngt8mwb-v0sm
// wolverine --rollback-latest
// wolverine --undo-rollback`;

module.exports = {
  SKILL_NAME, SKILL_DESCRIPTION, SKILL_KEYWORDS, SKILL_USAGE,
  backup, rollback, rollbackLatest, undoRollback, listBackups, getRollbackLog,
};
