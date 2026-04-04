const path = require("path");
const fs = require("fs");

/**
 * File Sandbox — restricts all file operations to the project directory.
 *
 * Every file read/write in wolverine passes through this gate.
 * Rejects path traversal, symlink escapes, and out-of-bounds access.
 */
class Sandbox {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
  }

  // Paths the agent can NEVER read, write, or delete — even within the sandbox
  static PROTECTED_PATHS = [
    ".wolverine/vault/master.key",
    ".wolverine/vault/eth.vault",
    ".wolverine/vault",
  ];

  /**
   * Resolve and validate a file path. Throws if the path escapes the sandbox
   * or targets a protected vault path.
   * Returns the resolved absolute path.
   */
  resolve(filePath) {
    // Block vault access before any resolution
    const normalized = filePath.replace(/\\/g, "/").toLowerCase();
    for (const p of Sandbox.PROTECTED_PATHS) {
      if (normalized.includes(p.toLowerCase())) {
        throw new SandboxViolationError(`Access denied: "${filePath}" is a protected vault path`);
      }
    }

    // Resolve relative to sandbox root
    const resolved = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.rootDir, filePath);

    // Normalize separators for consistent comparison
    const normalizedResolved = resolved.replace(/\\/g, "/").toLowerCase();
    const normalizedRoot = this.rootDir.replace(/\\/g, "/").toLowerCase();

    if (!normalizedResolved.startsWith(normalizedRoot + "/") && normalizedResolved !== normalizedRoot) {
      throw new SandboxViolationError(
        `Path "${filePath}" resolves to "${resolved}" which is outside the sandbox root "${this.rootDir}"`
      );
    }

    // Double-check resolved path against vault
    for (const p of Sandbox.PROTECTED_PATHS) {
      if (normalizedResolved.includes(p.toLowerCase())) {
        throw new SandboxViolationError(`Access denied: resolved path targets protected vault`);
      }
    }

    // Check for symlink escape
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      const normalizedReal = real.replace(/\\/g, "/").toLowerCase();
      if (!normalizedReal.startsWith(normalizedRoot + "/") && normalizedReal !== normalizedRoot) {
        throw new SandboxViolationError(
          `Path "${filePath}" is a symlink that escapes the sandbox (real path: "${real}")`
        );
      }
    }

    return resolved;
  }

  /**
   * Read a file within the sandbox.
   */
  readFile(filePath) {
    const resolved = this.resolve(filePath);
    return fs.readFileSync(resolved, "utf-8");
  }

  /**
   * Write a file within the sandbox.
   */
  writeFile(filePath, content) {
    const resolved = this.resolve(filePath);
    fs.writeFileSync(resolved, content, "utf-8");
    return resolved;
  }

  /**
   * Check if a file exists within the sandbox.
   */
  exists(filePath) {
    try {
      const resolved = this.resolve(filePath);
      return fs.existsSync(resolved);
    } catch (e) {
      if (e instanceof SandboxViolationError) return false;
      throw e;
    }
  }

  /**
   * Copy a file within the sandbox.
   */
  copyFile(src, dest) {
    const resolvedSrc = this.resolve(src);
    const resolvedDest = this.resolve(dest);
    fs.copyFileSync(resolvedSrc, resolvedDest);
    return resolvedDest;
  }

  /**
   * Delete a file within the sandbox.
   */
  unlinkFile(filePath) {
    const resolved = this.resolve(filePath);
    if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
    }
  }

  /**
   * Validate a set of AI-proposed changes — all file paths must be in sandbox.
   * Returns { valid: boolean, violations: string[] }
   */
  validateChanges(changes) {
    const violations = [];
    for (const change of changes) {
      try {
        this.resolve(change.file);
      } catch (e) {
        if (e instanceof SandboxViolationError) {
          violations.push(e.message);
        } else {
          throw e;
        }
      }
    }
    return { valid: violations.length === 0, violations };
  }
}

class SandboxViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SandboxViolationError";
    this.code = "SANDBOX_VIOLATION";
  }
}

module.exports = { Sandbox, SandboxViolationError };
