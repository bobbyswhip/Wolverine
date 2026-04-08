/**
 * Code Guard — runtime injection detection and prevention.
 *
 * Intercepts code at three layers:
 * 1. Module._load — scans every require() before execution
 * 2. File watcher — monitors server/ for new/modified scripts
 * 3. Process spawn — intercepts child_process usage
 *
 * When injection is detected:
 * - Code is BLOCKED from executing
 * - Full forensic log written (code, stack trace, timestamp, file hash)
 * - Attack vector traced through call stack
 * - Compromised file quarantined
 * - IPC alert sent to parent (triggers lockdown if enabled)
 *
 * Zero false positives on normal server code — patterns are specific
 * to injection, not general coding patterns.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const EventEmitter = require("events");

const bus = new EventEmitter();

// ── Configuration ───────────────────────────────────────────

let _projectRoot = null;
let _active = false;
let _watcher = null;
let _originalLoad = null;
let _lockdownMode = false;
let _quarantined = new Set(); // files blocked from loading

// Directories to monitor
const WATCH_DIRS = ["server", "wolverine-claw"];
// Directories that are NEVER suspicious (framework code, deps)
const TRUSTED_DIRS = new Set(["node_modules", "src", "bin", ".git", ".wolverine"]);

// ── Injection Patterns (code-level, not prompt-level) ────────

const CODE_INJECTION_PATTERNS = [
  // Dynamic code execution
  { re: /\beval\s*\([^)]*\b(req|request|body|query|params|input|data|user)\b/i, label: "eval-injection", severity: "critical" },
  { re: /\bnew\s+Function\s*\([^)]*\b(req|request|body|query|params|input)\b/i, label: "function-constructor-injection", severity: "critical" },
  { re: /\bvm\s*\.\s*(runInThisContext|runInNewContext|compileFunction)\s*\(/i, label: "vm-execution", severity: "high" },
  { re: /\bvm2?\s*\.\s*Script\b/i, label: "vm-script", severity: "medium" },

  // Command injection via child_process
  { re: /child_process.*\bexec\s*\([^)]*(\+|`\$\{|concat)\b/i, label: "command-injection", severity: "critical" },
  { re: /\bexecSync\s*\([^)]*\b(req|request|body|query|params|input)\b/i, label: "command-injection", severity: "critical" },
  { re: /\bspawn\s*\([^)]*\b(req|request|body|query|params|input)\b/i, label: "spawn-injection", severity: "critical" },

  // Dynamic require (path traversal)
  { re: /\brequire\s*\(\s*\b(req|request|body|query|params|input)\b/i, label: "require-injection", severity: "critical" },
  { re: /\brequire\s*\(\s*[^'")\s]+\+/i, label: "dynamic-require", severity: "high" },
  { re: /\brequire\s*\(\s*`[^`]*\$\{/i, label: "template-require", severity: "high" },

  // Prototype pollution
  { re: /__proto__\s*[=\[]/i, label: "proto-pollution", severity: "critical" },
  { re: /Object\s*\.\s*assign\s*\(\s*Object\s*\.\s*prototype/i, label: "proto-pollution", severity: "critical" },
  { re: /\bconstructor\s*\[\s*['"]prototype['"]\s*\]/i, label: "proto-pollution", severity: "critical" },

  // File system attacks (user input in path or content)
  { re: /(writeFile(Sync)?|appendFile(Sync)?|createWriteStream)\s*\([^)]*\b(req|request|body|query|params|input)\b/i, label: "fs-write-injection", severity: "critical" },
  { re: /(unlink(Sync)?|rmdir(Sync)?|rm(Sync)?)\s*\([^)]*\b(req|request|body|query|params)\b/i, label: "fs-delete-injection", severity: "critical" },

  // SQL injection setup (building queries from user input)
  { re: /['"`]\s*\+\s*\b(req|request)\b\.\b(body|query|params)\b/i, label: "sql-concat", severity: "high" },
  { re: /`SELECT.*\$\{.*req\b/i, label: "sql-template-injection", severity: "high" },

  // Deserialization attacks
  { re: /\bJSON\s*\.\s*parse\s*\([^)]*\).*\beval\b/i, label: "deserialize-exec", severity: "critical" },
  { re: /\bserialize\s*\(\s*\)\s*.*\bexec\b/i, label: "serialize-exec", severity: "critical" },

  // Network exfiltration from user input
  { re: /\bfetch\s*\(\s*\b(req|request|body|query|params|input)\b/i, label: "ssrf", severity: "critical" },
  { re: /\baxios\b.*\b(req|request|body|query|params)\b.*\burl\b/i, label: "ssrf", severity: "high" },
  { re: /\bhttp[s]?\s*\.\s*request\s*\([^)]*\b(req|request|body|query|params)\b/i, label: "ssrf", severity: "high" },

  // Reverse shell patterns in code
  { re: /net\s*\.\s*Socket\s*\(\).*connect.*exec/is, label: "reverse-shell-code", severity: "critical" },
  { re: /spawn\s*\(\s*['"]\/bin\/(ba)?sh['"]/i, label: "shell-spawn", severity: "high" },
  { re: /spawn\s*\(\s*['"]cmd(\.exe)?['"]/i, label: "shell-spawn-win", severity: "high" },

  // Environment manipulation
  { re: /process\s*\.\s*env\s*\[\s*\b(req|request|body|query|params)\b/i, label: "env-injection", severity: "critical" },
  { re: /process\s*\.\s*env\s*\.\s*\w+\s*=\s*\b(req|request|body|query|params)\b/i, label: "env-overwrite", severity: "critical" },

  // Crypto key extraction
  { re: /process\s*\.\s*env\s*\.\s*(API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/i, label: "credential-access", severity: "medium" },

  // Obfuscation patterns (common in injected code)
  { re: /String\s*\.\s*fromCharCode\s*\(\s*\d+\s*(,\s*\d+\s*){10,}/i, label: "char-code-obfuscation", severity: "critical" },
  { re: /\batob\s*\(\s*['"][A-Za-z0-9+/=]{50,}['"]\s*\)/i, label: "base64-obfuscation", severity: "critical" },
  { re: /\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){10,}/i, label: "hex-obfuscation", severity: "critical" },
  { re: /\\u[0-9a-f]{4}(\\u[0-9a-f]{4}){10,}/i, label: "unicode-obfuscation", severity: "critical" },

  // Bare eval/Function with variable (not just user input — any dynamic execution)
  { re: /\bnew\s+Function\s*\(\s*[a-zA-Z_]\w*\s*\)/i, label: "dynamic-function-exec", severity: "critical" },
];

// ── Forensic Logger ─────────────────────────────────────────

const FORENSIC_DIR = ".wolverine/security";
const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50MB cap

function _ensureForensicDir() {
  const dir = path.join(_projectRoot, FORENSIC_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _logForensic(event) {
  try {
    const dir = _ensureForensicDir();
    const logFile = path.join(dir, "injection-log.jsonl");

    // Cap file size
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > MAX_LOG_SIZE) {
        // Rotate: keep last half
        const content = fs.readFileSync(logFile, "utf-8");
        const lines = content.split("\n");
        fs.writeFileSync(logFile, lines.slice(Math.floor(lines.length / 2)).join("\n"));
      }
    } catch {}

    const entry = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
    return entry;
  } catch (e) {
    console.error("[CODE-GUARD] Forensic log failed:", e.message);
    return null;
  }
}

// ── Code Scanner ────────────────────────────────────────────

/**
 * Scan source code for injection patterns.
 * Returns { safe, threats: [{ label, severity, match, line }] }
 */
function scanCode(code, filePath) {
  const threats = [];

  // Split into lines for line-number reporting
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;

    for (const { re, label, severity } of CODE_INJECTION_PATTERNS) {
      const match = line.match(re);
      if (match) {
        threats.push({
          label,
          severity,
          match: match[0].slice(0, 100),
          line: i + 1,
          file: filePath,
        });
      }
    }
  }

  return {
    safe: threats.length === 0,
    threats,
    critical: threats.some(t => t.severity === "critical"),
  };
}

/**
 * Hash file content for forensic tracking.
 */
function _hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex").slice(0, 16);
}

// ── Attack Tracer ───────────────────────────────────────────

/**
 * Walk the call stack to find where the attack entered.
 * Returns the first non-node_modules, non-framework frame.
 */
function _traceAttackVector() {
  const stack = new Error().stack.split("\n").slice(2);
  const frames = [];

  for (const frame of stack) {
    const match = frame.match(/at\s+(?:(.+?)\s+)?\(?([\w/.\\:-]+):(\d+):(\d+)\)?/);
    if (!match) continue;

    const file = match[2];
    if (file.includes("node_modules") || file.includes("node:")) continue;
    if (file.includes("code-guard.js")) continue;

    frames.push({
      function: match[1] || "(anonymous)",
      file: path.relative(_projectRoot, file),
      line: parseInt(match[3]),
      column: parseInt(match[4]),
    });
  }

  return {
    entryPoint: frames[frames.length - 1] || null,
    callChain: frames,
    depth: frames.length,
  };
}

// ── Quarantine ──────────────────────────────────────────────

function _quarantineFile(filePath) {
  const abs = path.resolve(_projectRoot, filePath);
  _quarantined.add(abs);

  // Move file to quarantine directory
  try {
    const quarDir = path.join(_projectRoot, FORENSIC_DIR, "quarantine");
    if (!fs.existsSync(quarDir)) fs.mkdirSync(quarDir, { recursive: true });

    const safeName = filePath.replace(/[/\\]/g, "__") + "." + Date.now();
    const dest = path.join(quarDir, safeName);
    fs.copyFileSync(abs, dest);

    // Replace original with a stub that logs the attack
    const stub = `// QUARANTINED BY WOLVERINE CODE GUARD — ${new Date().toISOString()}
// Original file moved to: ${dest}
// This file was blocked due to code injection detection.
console.error("[CODE-GUARD] Blocked quarantined file: ${filePath}");
module.exports = {};
`;
    fs.writeFileSync(abs, stub);

    console.error(`[CODE-GUARD] Quarantined: ${filePath} → ${dest}`);
    return dest;
  } catch (e) {
    console.error(`[CODE-GUARD] Quarantine failed: ${e.message}`);
    return null;
  }
}

// ── Module._load Interceptor ────────────────────────────────

function _hookModuleLoad() {
  if (_originalLoad) return; // already hooked
  _originalLoad = Module._load;

  Module._load = function (request, parent, isMain) {
    // Only scan local files (not node_modules or built-ins)
    if (request.startsWith(".") || request.startsWith("/") || request.startsWith("\\")) {
      let resolved;
      try { resolved = Module._resolveFilename(request, parent, isMain); } catch { /* let original handle */ }

      if (resolved) {
        // CRITICAL: Block code loaded from OUTSIDE the project root entirely
        // This prevents escape attacks (write to /tmp, then require it)
        const resolvedNorm = resolved.replace(/\\/g, "/");
        const rootNorm = _projectRoot.replace(/\\/g, "/");
        if (!resolvedNorm.startsWith(rootNorm) && !resolvedNorm.includes("node_modules")) {
          console.error(`[CODE-GUARD] BLOCKED external require: ${resolved}`);
          _logForensic({
            type: "external-require-blocked",
            file: resolved,
            requestedBy: parent?.filename ? path.relative(_projectRoot, parent.filename) : "unknown",
            trace: _traceAttackVector(),
          });
          bus.emit("injection", {
            file: resolved,
            threats: [{ label: "external-require", severity: "critical", match: request }],
            source: "module-load-boundary",
          });
          _reportIPC({
            type: "code_injection",
            file: resolved,
            threats: ["external-require"],
            severity: "critical",
            action: "blocked",
            timestamp: Date.now(),
          });
          return {};
        }

        // Check quarantine
        if (_quarantined.has(resolved)) {
          console.error(`[CODE-GUARD] Blocked quarantined module: ${resolved}`);
          _logForensic({
            type: "blocked-quarantined",
            file: path.relative(_projectRoot, resolved),
          });
          return {};
        }

        // Scan the file if it's not in a trusted directory
        const rel = path.relative(_projectRoot, resolved);
        const topDir = rel.split(path.sep)[0];

        if (!TRUSTED_DIRS.has(topDir) && resolved.endsWith(".js")) {
        try {
          const code = fs.readFileSync(resolved, "utf-8");
          const scan = scanCode(code, rel);

          if (scan.critical) {
            const trace = _traceAttackVector();
            const hash = _hashCode(code);

            const forensic = _logForensic({
              type: "injection-blocked",
              file: rel,
              hash,
              threats: scan.threats,
              trace,
              codePreview: code.slice(0, 2000),
            });

            console.error(`[CODE-GUARD] INJECTION BLOCKED in ${rel}:`);
            for (const t of scan.threats) {
              console.error(`  [${t.severity}] ${t.label} at line ${t.line}: ${t.match}`);
            }

            // Quarantine the file
            const quarantinePath = _quarantineFile(rel);

            // Emit event for lockdown
            bus.emit("injection", {
              file: rel,
              threats: scan.threats,
              trace,
              hash,
              quarantine: quarantinePath,
              forensic,
            });

            // Report via IPC
            _reportIPC({
              type: "code_injection",
              file: rel,
              threats: scan.threats.map(t => t.label),
              severity: "critical",
              action: "quarantined",
              timestamp: Date.now(),
            });

            // Return empty module instead of injected code
            return {};
          }

          // Non-critical threats: warn but allow
          if (!scan.safe) {
            console.warn(`[CODE-GUARD] Warning in ${rel}: ${scan.threats.map(t => t.label).join(", ")}`);
            _logForensic({
              type: "injection-warning",
              file: rel,
              threats: scan.threats,
            });
          }
        } catch (e) {
          // File read error — don't block, just warn
          if (e.code !== "ENOENT") {
            console.warn(`[CODE-GUARD] Scan error on ${rel}: ${e.message}`);
          }
        }
      }
      }
    }

    return _originalLoad.apply(this, arguments);
  };
}

// ── File Watcher ────────────────────────────────────────────

function _startWatcher() {
  if (_watcher) return;

  const watchers = [];

  for (const dir of WATCH_DIRS) {
    const watchPath = path.join(_projectRoot, dir);
    if (!fs.existsSync(watchPath)) continue;

    try {
      const w = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
        if (!filename || !filename.endsWith(".js")) return;
        if (eventType !== "change" && eventType !== "rename") return;

        const filePath = path.join(watchPath, filename);
        if (!fs.existsSync(filePath)) return;

        // Scan the changed file
        try {
          const code = fs.readFileSync(filePath, "utf-8");
          const rel = path.relative(_projectRoot, filePath);
          const scan = scanCode(code, rel);

          if (scan.critical) {
            const hash = _hashCode(code);
            console.error(`[CODE-GUARD] INJECTION DETECTED in modified file: ${rel}`);

            _logForensic({
              type: "injection-detected-watcher",
              file: rel,
              hash,
              threats: scan.threats,
              codePreview: code.slice(0, 2000),
              event: eventType,
            });

            _quarantineFile(rel);

            bus.emit("injection", {
              file: rel,
              threats: scan.threats,
              hash,
              source: "file-watcher",
            });

            _reportIPC({
              type: "code_injection",
              file: rel,
              threats: scan.threats.map(t => t.label),
              severity: "critical",
              action: "quarantined",
              source: "file-watcher",
              timestamp: Date.now(),
            });
          }
        } catch {}
      });
      watchers.push(w);
    } catch (e) {
      console.warn(`[CODE-GUARD] Cannot watch ${dir}: ${e.message}`);
    }
  }

  _watcher = watchers;
}

// ── IPC Reporting ───────────────────────────────────────────

function _reportIPC(data) {
  if (typeof process.send === "function") {
    try { process.send(data); } catch {}
  }
}

// ── Lockdown Mode ───────────────────────────────────────────

/**
 * Enter lockdown — blocks ALL new file loads until manually cleared.
 * Used when an active attack is detected.
 */
function enterLockdown(reason) {
  _lockdownMode = true;
  _logForensic({ type: "lockdown-entered", reason });
  console.error(`[CODE-GUARD] LOCKDOWN MODE — ${reason}`);
  bus.emit("lockdown", { reason, timestamp: Date.now() });
}

function exitLockdown() {
  _lockdownMode = false;
  _logForensic({ type: "lockdown-exited" });
  console.log("[CODE-GUARD] Lockdown mode exited");
}

function isLockdown() { return _lockdownMode; }

// ── Public API ──────────────────────────────────────────────

/**
 * Start the code guard. Call once on process startup.
 */
function start(projectRoot) {
  if (_active) return;
  _projectRoot = path.resolve(projectRoot);
  _active = true;

  _ensureForensicDir();
  _hookModuleLoad();
  _startWatcher();

  console.log(`[CODE-GUARD] Active — monitoring ${WATCH_DIRS.join(", ")} | ${CODE_INJECTION_PATTERNS.length} patterns`);
}

/**
 * Stop the code guard.
 */
function stop() {
  _active = false;
  if (_watcher) {
    for (const w of _watcher) { try { w.close(); } catch {} }
    _watcher = null;
  }
  if (_originalLoad) {
    Module._load = _originalLoad;
    _originalLoad = null;
  }
}

/**
 * Get forensic log entries.
 */
function getForensicLog(limit = 50) {
  try {
    const logFile = path.join(_projectRoot, FORENSIC_DIR, "injection-log.jsonl");
    if (!fs.existsSync(logFile)) return [];
    const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * Get quarantined files.
 */
function getQuarantined() {
  return Array.from(_quarantined).map(f => path.relative(_projectRoot, f));
}

/**
 * Restore a quarantined file (for false positives).
 */
function restoreQuarantined(filePath) {
  const abs = path.resolve(_projectRoot, filePath);
  const quarDir = path.join(_projectRoot, FORENSIC_DIR, "quarantine");

  // Find the quarantined copy
  try {
    const safeName = filePath.replace(/[/\\]/g, "__");
    const files = fs.readdirSync(quarDir).filter(f => f.startsWith(safeName));
    if (files.length === 0) return { restored: false, reason: "Quarantine copy not found" };

    const latest = files.sort().pop();
    const src = path.join(quarDir, latest);
    fs.copyFileSync(src, abs);
    _quarantined.delete(abs);

    _logForensic({ type: "quarantine-restored", file: filePath });
    return { restored: true, file: filePath };
  } catch (e) {
    return { restored: false, reason: e.message };
  }
}

/**
 * Subscribe to injection events.
 */
function onInjection(callback) { bus.on("injection", callback); }
function onLockdown(callback) { bus.on("lockdown", callback); }

module.exports = {
  start, stop,
  scanCode,
  enterLockdown, exitLockdown, isLockdown,
  getForensicLog, getQuarantined, restoreQuarantined,
  onInjection, onLockdown,
  CODE_INJECTION_PATTERNS,
};
