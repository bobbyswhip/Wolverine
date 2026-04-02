const fs = require("fs");
const path = require("path");
const { calculateCost, loadCustomPricing } = require("./pricing");

/**
 * Token Tracker — tracks all AI token usage across models, tools, and categories.
 *
 * Every AI call in wolverine reports usage here. Data is:
 * 1. Accumulated in memory for fast dashboard queries
 * 2. Persisted to .wolverine/usage.json for cross-session analytics
 *
 * Categories:
 * - heal:       error fixing (fast path + agent)
 * - develop:    building features (smart edit + agent commands)
 * - chat:       conversational responses
 * - security:   injection scans, audit
 * - classify:   CHAT/AGENT routing
 * - research:   deep research on failures
 * - brain:      embedding + compaction
 * - mcp:        external tool calls
 */

const USAGE_FILE = ".wolverine/usage.json";
const HISTORY_FILE = ".wolverine/usage-history.jsonl";

class TokenTracker {
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    this.usagePath = path.join(this.projectRoot, USAGE_FILE);
    this.historyPath = path.join(this.projectRoot, HISTORY_FILE);

    // Per-model totals
    this._byModel = {};
    // Per-category totals
    this._byCategory = {};
    // Per-tool totals
    this._byTool = {};
    // Timeline: recent entries for charts (in-memory)
    this._timeline = [];
    // Session totals
    this._sessionStart = Date.now();
    this._totalTokens = 0;
    this._totalCalls = 0;
    this._totalCostUsd = 0;

    // Load custom pricing overrides
    loadCustomPricing(this.projectRoot);

    this._ensureDir();
    this._load();
  }

  _ensureDir() {
    const dir = path.dirname(this.usagePath);
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Record token usage from an AI call.
   *
   * @param {string} model - Model name (e.g. "gpt-5-nano")
   * @param {string} category - "heal" | "develop" | "chat" | "security" | "classify" | "research" | "brain" | "mcp"
   * @param {number} inputTokens - Prompt/input tokens
   * @param {number} outputTokens - Completion/output tokens
   * @param {string} tool - Optional tool name (e.g. "call_endpoint /time")
   */
  record(model, category, inputTokens, outputTokens, tool, latencyMs, success) {
    const total = (inputTokens || 0) + (outputTokens || 0);

    // Calculate USD cost
    const cost = calculateCost(model, inputTokens || 0, outputTokens || 0);

    const entry = {
      timestamp: Date.now(),
      model,
      category,
      input: inputTokens || 0,
      output: outputTokens || 0,
      total,
      cost: Math.round(cost.total * 1000000) / 1000000,
      tool: tool || null,
      latencyMs: latencyMs || 0,
      success: success !== false,
    };

    // Accumulate by model
    if (!this._byModel[model]) this._byModel[model] = { input: 0, output: 0, total: 0, calls: 0, cost: 0, successes: 0, failures: 0, totalLatencyMs: 0, minLatencyMs: Infinity, maxLatencyMs: 0 };
    const m = this._byModel[model];
    m.input += entry.input;
    m.output += entry.output;
    m.total += total;
    m.calls++;
    m.cost += cost.total;
    if (entry.success) m.successes++; else m.failures++;
    if (latencyMs > 0) {
      m.totalLatencyMs += latencyMs;
      if (latencyMs < m.minLatencyMs) m.minLatencyMs = latencyMs;
      if (latencyMs > m.maxLatencyMs) m.maxLatencyMs = latencyMs;
    }

    // Accumulate by category
    if (!this._byCategory[category]) this._byCategory[category] = { input: 0, output: 0, total: 0, calls: 0, cost: 0 };
    this._byCategory[category].input += entry.input;
    this._byCategory[category].output += entry.output;
    this._byCategory[category].total += total;
    this._byCategory[category].calls++;
    this._byCategory[category].cost += cost.total;

    // Accumulate by tool
    if (tool) {
      const toolKey = tool.split(" ")[0];
      if (!this._byTool[toolKey]) this._byTool[toolKey] = { input: 0, output: 0, total: 0, calls: 0, cost: 0 };
      this._byTool[toolKey].input += entry.input;
      this._byTool[toolKey].output += entry.output;
      this._byTool[toolKey].total += total;
      this._byTool[toolKey].calls++;
      this._byTool[toolKey].cost += cost.total;
    }

    // Timeline (keep last 500 for charts)
    this._timeline.push(entry);
    if (this._timeline.length > 500) this._timeline.shift();

    // Session totals
    this._totalTokens += total;
    this._totalCalls++;
    this._totalCostUsd += cost.total;

    // Persist to history file (append-only JSONL for charting)
    try {
      fs.appendFileSync(this.historyPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {}

    // Auto-save aggregates on every call
    this.save();
  }

  /**
   * Get full analytics snapshot for the dashboard.
   */
  getAnalytics() {
    const sessionDuration = Date.now() - this._sessionStart;
    const tokensPerMinute = sessionDuration > 60000 ? Math.round(this._totalTokens / (sessionDuration / 60000)) : this._totalTokens;

    return {
      session: {
        totalTokens: this._totalTokens,
        totalCalls: this._totalCalls,
        totalCostUsd: Math.round(this._totalCostUsd * 10000) / 10000,
        duration: sessionDuration,
        tokensPerMinute,
      },
      byModel: this._formatModelStats(),
      byCategory: this._byCategory,
      byTool: this._byTool,
      // Recent in-memory timeline
      timeline: this._timeline.slice(-100).map(e => ({
        t: e.timestamp,
        tokens: e.total,
        input: e.input,
        output: e.output,
        cat: e.category,
        model: e.model,
        latencyMs: e.latencyMs || 0,
        success: e.success !== false,
      })),
    };
  }

  /**
   * Format model stats with computed performance metrics.
   */
  _formatModelStats() {
    const result = {};
    for (const [model, m] of Object.entries(this._byModel)) {
      result[model] = {
        input: m.input,
        output: m.output,
        total: m.total,
        calls: m.calls,
        cost: m.cost,
        successes: m.successes || m.calls, // backwards compat
        failures: m.failures || 0,
        successRate: m.calls > 0 ? Math.round(((m.successes || m.calls) / m.calls) * 100) : 0,
        avgLatencyMs: m.calls > 0 && m.totalLatencyMs ? Math.round(m.totalLatencyMs / m.calls) : 0,
        minLatencyMs: m.minLatencyMs === Infinity ? 0 : (m.minLatencyMs || 0),
        maxLatencyMs: m.maxLatencyMs || 0,
        tokensPerSecond: m.totalLatencyMs > 0 ? Math.round((m.total / (m.totalLatencyMs / 1000)) * 10) / 10 : 0,
        costPerCall: m.calls > 0 ? Math.round((m.cost / m.calls) * 1000000) / 1000000 : 0,
      };
    }
    return result;
  }

  /**
   * Load full history from JSONL file. For dashboard charts across sessions.
   * @param {number} limit — max entries to return (default: 500)
   */
  getHistory(limit = 500) {
    if (!fs.existsSync(this.historyPath)) return [];
    try {
      const lines = fs.readFileSync(this.historyPath, "utf-8").trim().split("\n");
      return lines.slice(-limit).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  /**
   * Get hourly/daily aggregates for cost charting.
   */
  getAggregates() {
    const history = this.getHistory(2000);
    const byHour = {};
    const byDay = {};

    for (const entry of history) {
      const hour = new Date(entry.timestamp).toISOString().slice(0, 13); // "2026-04-01T18"
      const day = new Date(entry.timestamp).toISOString().slice(0, 10);  // "2026-04-01"

      if (!byHour[hour]) byHour[hour] = { input: 0, output: 0, total: 0, calls: 0, cost: 0 };
      byHour[hour].input += entry.input || 0;
      byHour[hour].output += entry.output || 0;
      byHour[hour].total += entry.total || 0;
      byHour[hour].calls++;
      byHour[hour].cost += entry.cost || 0;

      if (!byDay[day]) byDay[day] = { input: 0, output: 0, total: 0, calls: 0, cost: 0 };
      byDay[day].input += entry.input || 0;
      byDay[day].output += entry.output || 0;
      byDay[day].total += entry.total || 0;
      byDay[day].calls++;
      byDay[day].cost += entry.cost || 0;
    }

    return { byHour, byDay };
  }

  /**
   * Save to disk for cross-session persistence.
   */
  save() {
    const data = {
      lastSaved: Date.now(),
      byModel: this._byModel,
      byCategory: this._byCategory,
      byTool: this._byTool,
      totalTokens: this._totalTokens,
      totalCalls: this._totalCalls,
      totalCostUsd: this._totalCostUsd,
    };
    try {
      fs.mkdirSync(path.dirname(this.usagePath), { recursive: true });
      const tmpPath = this.usagePath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, this.usagePath);
    } catch {}
  }

  // -- Private --

  _load() {
    // Try loading saved aggregates
    if (fs.existsSync(this.usagePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.usagePath, "utf-8"));
        this._byModel = data.byModel || {};
        this._byCategory = data.byCategory || {};
        this._byTool = data.byTool || {};
        this._totalTokens = data.totalTokens || 0;
        this._totalCalls = data.totalCalls || 0;
        this._totalCostUsd = data.totalCostUsd || 0;
        return;
      } catch {}
    }

    // Fallback: rebuild from JSONL history
    if (fs.existsSync(this.historyPath)) {
      const history = this.getHistory(10000);
      for (const entry of history) {
        // Replay into accumulators (without re-persisting)
        const model = entry.model || "unknown";
        const category = entry.category || "unknown";
        const total = entry.total || 0;

        if (!this._byModel[model]) this._byModel[model] = { input: 0, output: 0, total: 0, calls: 0, cost: 0 };
        this._byModel[model].input += entry.input || 0;
        this._byModel[model].output += entry.output || 0;
        this._byModel[model].total += total;
        this._byModel[model].calls++;
        this._byModel[model].cost += entry.cost || 0;

        if (!this._byCategory[category]) this._byCategory[category] = { input: 0, output: 0, total: 0, calls: 0, cost: 0 };
        this._byCategory[category].input += entry.input || 0;
        this._byCategory[category].output += entry.output || 0;
        this._byCategory[category].total += total;
        this._byCategory[category].calls++;
        this._byCategory[category].cost += entry.cost || 0;

        this._totalTokens += total;
        this._totalCalls++;
        this._totalCostUsd += entry.cost || 0;
      }

      if (history.length > 0) {
        this.save(); // Persist the rebuilt aggregates
      }
    }
  }
}

module.exports = { TokenTracker };
