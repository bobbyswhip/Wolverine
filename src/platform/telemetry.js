const crypto = require("crypto");
const path = require("path");

const INSTANCE_ID = process.env.WOLVERINE_INSTANCE_ID ||
  "wlv_" + crypto.createHash("sha256").update(process.cwd() + (process.env.PORT || "3000")).digest("hex").slice(0, 12);

let _v = null;

/**
 * Collect heartbeat — matches PLATFORM.md spec exactly.
 * Don't rename keys — backend expects this shape.
 */
function collectHeartbeat(subsystems) {
  if (!_v) { try { _v = require("../../package.json").version; } catch { _v = "0.0.0"; } }

  const { processMonitor, routeProber, tokenTracker, repairHistory, backupManager, brain, redactor } = subsystems;
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

    usage: {
      totalTokens: usage?.session?.totalTokens || 0,
      totalCost: usage?.session?.totalCostUsd || 0,
      totalCalls: usage?.session?.totalCalls || 0,
      byCategory: usage?.byCategory || {},
      byModel: usage?.byModel || {},
      byTool: usage?.byTool || {},
    },

    brain: { totalMemories: brain?.getStats()?.totalEntries || 0 },
    backups: backupManager?.getStats() || { total: 0, stable: 0 },
  };

  if (redactor && repairs?.lastRepair) {
    payload.repairs.lastRepair = {
      error: redactor.redact((repairs.lastRepair?.error || "").slice(0, 150)),
      resolution: redactor.redact((repairs.lastRepair?.resolution || "").slice(0, 150)),
      tokens: repairs.lastRepair?.tokens || 0,
      cost: repairs.lastRepair?.cost || 0,
      mode: repairs.lastRepair?.mode || "",
      success: repairs.lastRepair?.success,
      timestamp: repairs.lastRepair?.timestamp,
    };
  }

  return payload;
}

module.exports = { collectHeartbeat, INSTANCE_ID };
