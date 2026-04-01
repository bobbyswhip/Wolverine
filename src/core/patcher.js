const path = require("path");

/**
 * Apply a set of changes from the AI repair response.
 * All file operations go through the sandbox.
 * Backups are managed by BackupManager (not inline .bak files anymore).
 *
 * Returns an array of { file, success, error? } objects.
 */
function applyPatch(changes, basePath, sandbox) {
  const results = [];

  for (const change of changes) {
    const filePath = path.isAbsolute(change.file)
      ? change.file
      : path.resolve(basePath, change.file);

    // All access through sandbox
    if (!sandbox.exists(filePath)) {
      results.push({ file: filePath, success: false, error: "File not found" });
      continue;
    }

    const original = sandbox.readFile(filePath);

    // Normalize line endings for matching
    const normalizedOriginal = original.replace(/\r\n/g, "\n");
    const normalizedOld = change.old.replace(/\r\n/g, "\n");

    if (!normalizedOriginal.includes(normalizedOld)) {
      results.push({
        file: filePath,
        success: false,
        error: "Could not find the exact text to replace in the source file",
      });
      continue;
    }

    const patched = normalizedOriginal.replace(normalizedOld, change.new.replace(/\r\n/g, "\n"));
    sandbox.writeFile(filePath, patched);

    results.push({ file: filePath, success: true });
  }

  return results;
}

/**
 * Rollback files from a backup entry using BackupManager.
 */
function rollbackFromBackup(backupManager, backupId) {
  return backupManager.rollbackTo(backupId);
}

module.exports = { applyPatch, rollbackFromBackup };
