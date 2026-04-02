const crypto = require("crypto");
const path = require("path");

// Stable instance ID — based on cwd ONLY (not port, which can change during restarts).
// Persisted to .wolverine/instance-id so it survives even if cwd hash changes.
const INSTANCE_ID = (() => {
  if (process.env.WOLVERINE_INSTANCE_ID) return process.env.WOLVERINE_INSTANCE_ID;
  const fs = require("fs");
  const idPath = require("path").join(process.cwd(), ".wolverine", "instance-id");
  try {
    const saved = fs.readFileSync(idPath, "utf-8").trim();
    if (saved) return saved;
  } catch {}
  const id = "wlv_" + crypto.createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12);
  try { fs.mkdirSync(require("path").dirname(idPath), { recursive: true }); fs.writeFileSync(idPath, id, "utf-8"); } catch {}
  return id;
})();

let _v = null;

/**
 * Collect heartbeat — matches PLATFORM.md spec exactly.
 * Don't rename keys — backend expects this shape.
 */
function collectHeartbeat(subsystems) {
  if (!_v) { try { _v = require("../../package.json").version; } catch { _v = "0.0.0"; } }

  const { processMonitor, routeProber, tokenTracker, repairHistory, backupManager, brain } = subsystems;
  const proc = processMonitor?.getMetrics();
  const usage = tokenTracker?.getAnalytics();
  const repairs = repairHistory?.getStats();

  const payload = {
    instanceId: INSTANCE_ID,
    version: _v,
    timestamp: Date.now(),

    server: {
      name: process.env.WOLVERINE_INSTANCE_NAME || path.basename(process.cwd()),
      port: parseInt(process.env.PORT, 10) || 3000,
      uptime: Math.round(process.uptime()),
      status: proc?.alive !== false ? "healthy" : "down",
      pid: proc?.pid || process.pid,
    },

    process: {
      memoryMB: proc?.current?.rss || Math.round(process.memoryUsage().rss / 1048576),
      cpuPercent: proc?.current?.cpu || 0,
      peakMemoryMB: proc?.peak?.memory || 0,
    },

    routes: routeProber?.getSummary() || { total: 0, healthy: 0, unhealthy: 0 },

    repairs: {
      total: repairs?.total || 0,
      successes: repairs?.successes || 0,
      failures: repairs?.failures || 0,
      successRate: repairs?.successRate || 0,
      totalCost: repairs?.totalCost || 0,
    },

    // Usage: cumulative totals from disk (not session-only) so restarts don't reset
    usage: {
      totalTokens: tokenTracker?._totalTokens || usage?.session?.totalTokens || 0,
      totalCost: tokenTracker?._totalCostUsd || usage?.session?.totalCostUsd || 0,
      totalCalls: tokenTracker?._totalCalls || usage?.session?.totalCalls || 0,
      byCategory: usage?.byCategory || {},
      byModel: usage?.byModel || {},
      byTool: usage?.byTool || {},
      byProvider: _aggregateByProvider(usage?.byModel || {}),
    },

    brain: { totalMemories: brain?.getStats()?.totalEntries || 0 },
    backups: backupManager?.getStats() || { total: 0, stable: 0 },
  };

  if (repairs?.lastRepair) {
    payload.repairs.lastRepair = {
      error: (repairs.lastRepair?.error || "").slice(0, 150),
      resolution: (repairs.lastRepair?.resolution || "").slice(0, 150),
      tokens: repairs.lastRepair?.tokens || 0,
      cost: repairs.lastRepair?.cost || 0,
      mode: repairs.lastRepair?.mode || "",
      success: repairs.lastRepair?.success,
      timestamp: repairs.lastRepair?.timestamp,
    };
  }

  // Pre-flight security: redact entire payload before it leaves the process
  const { redactObj } = require("../security/secret-redactor");
  return redactObj(payload);
}

/**
 * Aggregate usage by provider (openai vs anthropic) from byModel data.
 * Any new model/provider automatically flows through — no code changes needed.
 */
function _aggregateByProvider(byModel) {
  const { detectProvider } = require("../core/models");
  const byProvider = {};
  for (const [model, stats] of Object.entries(byModel || {})) {
    const provider = detectProvider(model);
    if (!byProvider[provider]) byProvider[provider] = { input: 0, output: 0, total: 0, calls: 0, cost: 0 };
    byProvider[provider].input += stats.input || 0;
    byProvider[provider].output += stats.output || 0;
    byProvider[provider].total += stats.total || 0;
    byProvider[provider].calls += stats.calls || 0;
    byProvider[provider].cost += stats.cost || 0;
  }
  return byProvider;
}

module.exports = { collectHeartbeat, INSTANCE_ID };
