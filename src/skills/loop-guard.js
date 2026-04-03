/**
 * Loop Guard — detects infinite heal loops and generates bug reports.
 *
 * Problem: wolverine can get stuck repeating the same fix attempt,
 * burning tokens with nothing changing. This happens when:
 * - The error is beyond the agent's capability to fix
 * - The fix works but something else breaks, causing a new error
 * - External deps are missing (not a code issue)
 * - The verifier keeps rejecting a correct fix
 *
 * Solution: track heal attempts with signatures. If the same error
 * (or same file) triggers N heals in T minutes with no success,
 * STOP healing and generate a bug report instead.
 *
 * Bug reports are sent to the platform backend for human review.
 */

const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

const LOOP_FILE = ".wolverine/loop-guard.json";

class LoopGuard {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.maxAttempts = options.maxAttempts || 3;       // max heals on same error before giving up
    this.windowMs = options.windowMs || 600000;         // 10 minute window
    this.cooldownMs = options.cooldownMs || 1800000;    // 30 min cooldown after bug report
    this._attempts = [];  // { signature, timestamp, success, tokens }
    this._bugReports = []; // { signature, report, timestamp }
    this._load();
  }

  /**
   * Check if healing should proceed for this error.
   * Returns { allowed: boolean, reason?: string }
   */
  check(errorSignature) {
    const now = Date.now();

    // Clean old attempts outside window
    this._attempts = this._attempts.filter(a => now - a.timestamp < this.windowMs);

    // Count recent attempts on this signature
    const recentAttempts = this._attempts.filter(a => a.signature === errorSignature);
    const recentFailures = recentAttempts.filter(a => !a.success);

    // Check cooldown from previous bug report on this signature
    const lastReport = this._bugReports.find(r => r.signature === errorSignature);
    if (lastReport && now - lastReport.timestamp < this.cooldownMs) {
      const remaining = Math.round((this.cooldownMs - (now - lastReport.timestamp)) / 60000);
      return { allowed: false, reason: `Bug report filed ${remaining}min ago — cooldown active` };
    }

    if (recentFailures.length >= this.maxAttempts) {
      return {
        allowed: false,
        reason: `Loop detected: ${recentFailures.length} failed heals on same error in ${Math.round(this.windowMs / 60000)}min`,
        shouldReport: true,
        attempts: recentAttempts,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a heal attempt.
   */
  record(errorSignature, success, tokens = 0) {
    this._attempts.push({
      signature: errorSignature,
      timestamp: Date.now(),
      success,
      tokens,
    });
    this._save();
  }

  /**
   * Generate a bug report using AI reasoning.
   * Compacts all context into a structured report for human review.
   */
  async generateBugReport({ errorMessage, filePath, attempts, brain, logger }) {
    const { redact } = require("../security/secret-redactor");
    const safeError = redact(errorMessage || "");

    // Compact attempt history
    const attemptSummary = (attempts || this._attempts.slice(-5)).map(a =>
      `[${new Date(a.timestamp).toISOString().slice(11, 19)}] ${a.success ? "OK" : "FAIL"} ${a.tokens} tokens`
    ).join("\n");

    // Get brain context about this error
    let brainContext = "";
    if (brain && brain._initialized) {
      try {
        const results = brain.store.keywordSearch(safeError, { topK: 3 });
        brainContext = results.map(r => r.text.slice(0, 100)).join("\n");
      } catch {}
    }

    // Build report without AI (save tokens — the whole point is to stop burning them)
    const report = {
      type: "bug_report",
      timestamp: Date.now(),
      iso: new Date().toISOString(),
      error: safeError.slice(0, 500),
      file: filePath || "unknown",
      attempts: this._attempts.filter(a => a.signature === (filePath + "::" + safeError.slice(0, 50))).length,
      totalTokensBurned: this._attempts.reduce((s, a) => s + (a.tokens || 0), 0),
      history: attemptSummary,
      brainContext: brainContext.slice(0, 300),
      recommendation: "This error exceeded automatic healing capacity. Manual investigation required.",
      severity: "high",
    };

    // Check for injection/secrets before sending
    const { hasSecrets } = require("../security/secret-redactor");
    const reportStr = JSON.stringify(report);
    if (hasSecrets(reportStr)) {
      report.error = "[REDACTED — contained secrets]";
      report.brainContext = "[REDACTED]";
    }

    // Record the bug report
    const sig = (filePath || "") + "::" + safeError.slice(0, 50);
    this._bugReports.push({ signature: sig, report, timestamp: Date.now() });
    this._save();

    console.log(chalk.red(`\n  🐛 Bug Report Generated`));
    console.log(chalk.red(`     Error: ${safeError.slice(0, 80)}`));
    console.log(chalk.red(`     Attempts: ${report.attempts}, Tokens burned: ${report.totalTokensBurned}`));
    console.log(chalk.red(`     Filed for human review\n`));

    if (logger) {
      logger.critical("loop_guard.bug_report", `Bug report: ${safeError.slice(0, 100)}`, report);
    }

    return report;
  }

  /**
   * Send bug report to platform backend.
   */
  async sendToBackend(report) {
    try {
      const https = require("https");
      const http = require("http");
      const { URL } = require("url");
      const { loadConfig } = require("../core/config");
      const config = loadConfig();
      const platformUrl = config.telemetry?.platformUrl || "https://api.wolverinenode.xyz";

      const keyPath = path.join(this.cwd, ".wolverine", "platform-key");
      let key = "";
      try { key = fs.readFileSync(keyPath, "utf-8").trim(); } catch {}
      if (!key) return;

      const url = new URL(`${platformUrl}/api/v1/heartbeat`);
      const body = JSON.stringify({
        instanceId: require("../platform/telemetry").INSTANCE_ID,
        timestamp: Date.now(),
        alerts: [report],
      });

      const mod = url.protocol === "https:" ? https : http;
      await new Promise((resolve) => {
        const req = mod.request({
          hostname: url.hostname, port: url.port, path: url.pathname,
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
          timeout: 5000,
        }, () => resolve());
        req.on("error", () => resolve());
        req.write(body);
        req.end();
      });
    } catch {}
  }

  getStats() {
    return {
      recentAttempts: this._attempts.length,
      bugReports: this._bugReports.length,
      totalTokensBurned: this._attempts.reduce((s, a) => s + (a.tokens || 0), 0),
    };
  }

  _load() {
    try {
      const fp = path.join(this.cwd, LOOP_FILE);
      if (fs.existsSync(fp)) {
        const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
        this._attempts = data.attempts || [];
        this._bugReports = data.bugReports || [];
      }
    } catch {}
  }

  _save() {
    try {
      const fp = path.join(this.cwd, LOOP_FILE);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify({ attempts: this._attempts.slice(-50), bugReports: this._bugReports.slice(-20) }, null, 2), "utf-8");
    } catch {}
  }
}

// ── Process Dedup ──

/**
 * Ensure only one wolverine process runs at a time.
 * Kills any existing wolverine process before starting a new one.
 */
function ensureSingleProcess(cwd) {
  const { execSync } = require("child_process");
  const pidFile = path.join(cwd, ".wolverine", "wolverine.pid");

  // Kill old process if PID file exists
  try {
    if (fs.existsSync(pidFile)) {
      const oldPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0); // check if alive
          console.log(chalk.yellow(`  🔒 Killing old wolverine process (PID ${oldPid})`));
          if (process.platform === "win32") {
            execSync(`taskkill /PID ${oldPid} /T /F`, { stdio: "ignore", timeout: 5000 });
          } else {
            process.kill(oldPid, "SIGTERM");
            setTimeout(() => { try { process.kill(oldPid, "SIGKILL"); } catch {} }, 3000);
          }
        } catch {} // process already dead
      }
    }
  } catch {}

  // Write our PID
  try {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid), "utf-8");
  } catch {}

  // Clean up on exit — only delete if PID file still belongs to us
  // (prevents race condition where old process deletes new process's PID)
  const myPid = process.pid;
  process.on("exit", () => {
    try {
      const current = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (current === myPid) fs.unlinkSync(pidFile);
    } catch {}
  });
}

// ── Skill Metadata ──

const SKILL_NAME = "loop-guard";
const SKILL_DESCRIPTION = "Detects infinite heal loops and generates bug reports. Prevents token waste by stopping repeated failed heals on the same error. Ensures only one wolverine process runs at a time.";
const SKILL_KEYWORDS = ["loop", "infinite", "stuck", "repeat", "guard", "bug", "report", "dedup", "single", "process", "pid"];
const SKILL_USAGE = `// Loop guard is automatic — integrated into the heal pipeline.
// Bug reports filed when 3+ heals fail on same error in 10 minutes.
// Process dedup runs on startup.

// Manual check:
const { LoopGuard } = require("wolverine-ai");
const guard = new LoopGuard(process.cwd());
const check = guard.check("server/api.js::TypeError");
// { allowed: false, reason: "Loop detected: 3 failed heals..." }`;

module.exports = {
  SKILL_NAME, SKILL_DESCRIPTION, SKILL_KEYWORDS, SKILL_USAGE,
  LoopGuard, ensureSingleProcess,
};
