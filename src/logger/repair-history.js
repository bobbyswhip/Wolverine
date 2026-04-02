const fs = require("fs");
const path = require("path");

/**
 * Repair History — dedicated log of every error + resolution + cost.
 *
 * Separate from the general event log — this is a structured repair audit trail.
 * Each entry tracks: what broke, what fixed it, how many tokens it cost, which model.
 *
 * Persisted to .wolverine/repair-history.json
 */

const HISTORY_FILE = ".wolverine/repair-history.json";

class RepairHistory {
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    this.historyPath = path.join(this.projectRoot, HISTORY_FILE);
    this._repairs = [];
    this._load();
  }

  /**
   * Record a repair attempt.
   */
  record({
    error,         // error message
    file,          // file that crashed
    line,          // line number
    resolution,    // what was done to fix it
    success,       // boolean
    mode,          // "fast" | "agent" | "research"
    model,         // which model fixed it
    tokens,        // total tokens used
    cost,          // USD cost
    iteration,     // which goal loop iteration
    duration,      // ms from crash to fix
    filesModified, // files changed
  }) {
    const { redact } = require("../security/secret-redactor");
    const entry = {
      id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 4),
      timestamp: Date.now(),
      iso: new Date().toISOString(),
      error: redact((error || "").slice(0, 200)),
      file,
      line,
      resolution: redact((resolution || "").slice(0, 300)),
      success,
      mode,
      model,
      tokens: tokens || 0,
      cost: Math.round((cost || 0) * 1000000) / 1000000,
      iteration: iteration || 1,
      duration: duration || 0,
      filesModified: filesModified || [],
    };

    this._repairs.push(entry);
    this._save();
    return entry;
  }

  /**
   * Get all repair entries.
   */
  getAll() {
    return this._repairs;
  }

  /**
   * Get summary stats.
   */
  getStats() {
    const total = this._repairs.length;
    const successes = this._repairs.filter(r => r.success).length;
    const failures = total - successes;
    const totalTokens = this._repairs.reduce((sum, r) => sum + (r.tokens || 0), 0);
    const totalCost = this._repairs.reduce((sum, r) => sum + (r.cost || 0), 0);
    const avgTokensPerRepair = total > 0 ? Math.round(totalTokens / total) : 0;

    return {
      total,
      successes,
      failures,
      successRate: total > 0 ? Math.round((successes / total) * 100) : 0,
      totalTokens,
      totalCost: Math.round(totalCost * 10000) / 10000,
      avgTokensPerRepair,
    };
  }

  _load() {
    if (!fs.existsSync(this.historyPath)) return;
    try {
      this._repairs = JSON.parse(fs.readFileSync(this.historyPath, "utf-8"));
    } catch { this._repairs = []; }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.historyPath), { recursive: true });
      const tmp = this.historyPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this._repairs, null, 2), "utf-8");
      fs.renameSync(tmp, this.historyPath);
    } catch {}
  }
}

module.exports = { RepairHistory };
