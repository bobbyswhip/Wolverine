const path = require("path");

/**
 * Parse a Node.js error/stack trace string and extract the relevant file + line info.
 * Returns { filePath, line, column, errorMessage, stackTrace }
 */
function parseError(stderr) {
  const lines = stderr.split("\n").map(l => l.replace(/\r$/, ""));

  // Find the error message line (usually contains "Error:" or "TypeError:" etc.)
  let errorMessage = "";
  let stackTrace = stderr;

  for (const line of lines) {
    if (/^\w*Error:/.test(line.trim()) || /^\w*TypeError:/.test(line.trim())) {
      errorMessage = line.trim();
      break;
    }
  }

  if (!errorMessage) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("at ")) {
        errorMessage = trimmed;
      }
    }
  }

  let filePath = null;
  let line = null;
  let column = null;

  // 1. First line of stderr — Node prints "filepath.js:line" for syntax/reference errors
  const firstLineMatch = lines[0] && lines[0].match(/^(.+\.[a-zA-Z]+):(\d+)$/);
  if (firstLineMatch) {
    filePath = firstLineMatch[1];
    line = parseInt(firstLineMatch[2], 10);
  }

  // 2. Try to find a user-land file in the stack trace (not node_modules, not node: internal)
  const stackFrames = stderr.match(/at\s+.+\(.+:\d+:\d+\)/g) || [];
  let foundUserFile = false;
  for (const stackLine of stackFrames) {
    const match = stackLine.match(/\(([^)]+):(\d+):(\d+)\)/);
    if (match) {
      const candidate = match[1];
      if (!candidate.includes("node_modules") &&
          !candidate.includes("node:") &&
          !candidate.startsWith("internal/")) {
        filePath = candidate;
        line = parseInt(match[2], 10);
        column = parseInt(match[3], 10);
        foundUserFile = true;
        break;
      }
    }
  }

  // 3. If no user-land file in stack, try the generic stack trace patterns
  //    BUT only if we didn't already have a file from the first line
  if (!foundUserFile && !filePath) {
    const fileMatch = stderr.match(/\(([^)]+):(\d+):(\d+)\)/) ||
                      stderr.match(/at\s+([^\s(]+):(\d+):(\d+)/);
    if (fileMatch) {
      filePath = fileMatch[1];
      line = parseInt(fileMatch[2], 10);
      column = parseInt(fileMatch[3], 10);
    }
  }

  // Normalize Git Bash paths on Windows: /c/Users/... → C:/Users/...
  if (filePath) {
    filePath = filePath.replace(/^\/([a-zA-Z])\//, "$1:/");
    filePath = path.resolve(filePath);
  }

  // Classify the error type — helps the heal pipeline choose the right strategy
  const errorType = classifyError(errorMessage, stderr);

  return {
    filePath,
    line,
    column,
    errorMessage,
    stackTrace,
    errorType,
  };
}

/**
 * Classify an error into categories to guide fix strategy.
 * Returns: "missing_module" | "missing_file" | "permission" | "port_conflict" | "syntax" | "runtime" | "unknown"
 */
function classifyError(errorMessage, fullStderr) {
  const msg = (errorMessage || "").toLowerCase();
  const full = (fullStderr || "").toLowerCase();

  // Missing npm package: Cannot find module 'cors' (not a relative path)
  if (/cannot find module ['"](?![./\\])/.test(msg) || /module_not_found/.test(full)) {
    return "missing_module";
  }
  // Missing local file: Cannot find module './routes/api'
  if (/cannot find module ['"][./\\]/.test(msg) || /enoent/.test(msg)) {
    return "missing_file";
  }
  // Permission denied
  if (/eacces|eperm/.test(msg)) {
    return "permission";
  }
  // Port already in use
  if (/eaddrinuse/.test(msg)) {
    return "port_conflict";
  }
  // Syntax error
  if (/syntaxerror|unexpected token|unexpected end/.test(msg)) {
    return "syntax";
  }
  // Runtime errors (TypeError, ReferenceError, RangeError)
  if (/typeerror|referenceerror|rangeerror/.test(msg)) {
    return "runtime";
  }
  // Disk full
  if (/enospc/.test(msg)) {
    return "disk_full";
  }
  // Too many open files
  if (/emfile|enfile/.test(msg)) {
    return "file_descriptors";
  }
  // Connection issues (DB, Redis, external services)
  if (/econnrefused|econnreset|etimedout/.test(msg) && !/eaddrinuse/.test(msg)) {
    return "connection";
  }
  // TLS/SSL certificate errors
  if (/cert_|certificate|self.signed|unable_to_verify/.test(msg)) {
    return "certificate";
  }
  return "unknown";
}

module.exports = { parseError, classifyError };
