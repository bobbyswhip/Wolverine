const crypto = require("crypto");
const path = require("path");

/**
 * Telemetry — collects heartbeat data from all wolverine subsystems.
 *
 * Gathers metrics from: processMonitor, routeProber, tokenTracker,
 * repairHistory, backupManager, brain, notifier — packages into
 * a single payload for the platform.
 */

// Stable instance ID — persists across restarts via env or generated once
const INSTANCE_ID = process.env.WOLVERINE_INSTANCE_ID ||
  "wlv_" + crypto.createHash("sha256")
    .update(process.cwd() + (process.env.PORT || "3000"))
    .digest("hex").slice(0, 12);

/**
 * Collect a heartbeat payload from all subsystems.
 */
function collectHeartbeat(subsystems) {
  const { processMonitor, routeProber, tokenTracker, repairHistory, backupManager, brain, redactor } = subsystems;

  const procMetrics = processMonitor ? processMonitor.getMetrics() : {};
  const routeMetrics = routeProber ? routeProber.getSummary() : {};
  const usage = tokenTracker ? tokenTracker.getAnalytics() : {};
  const repairs = repairHistory ? repairHistory.getStats() : {};
  const backups = backupManager ? backupManager.getStats() : {};
  const brainStats = brain ? brain.getStats() : {};

  // Get last repair detail
  let lastRepair = null;
  if (repairHistory) {
    const all = repairHistory.getAll();
    if (all.length > 0) {
      const last = all[all.length - 1];
      lastRepair = {
        error: last.error,
        resolution: last.resolution,
        tokens: last.tokens,
        cost: last.cost,
        mode: last.mode,
        success: last.success,
        timestamp: last.timestamp,
      };
    }
  }

  const payload = {
    instanceId: INSTANCE_ID,
    version: require("../../package.json").version,
    timestamp: Date.now(),

    server: {
      name: process.env.WOLVERINE_INSTANCE_NAME || path.basename(process.cwd()) || "wolverine-server",
      port: parseInt(process.env.PORT, 10) || 3000,
      uptime: Math.round(process.uptime()),
      status: procMetrics.alive !== false ? "healthy" : "down",
      pid: procMetrics.pid || process.pid,
    },

    process: {
      memoryMB: procMetrics.current ? procMetrics.current.rss : Math.round(process.memoryUsage().rss / 1024 / 1024),
      cpuPercent: procMetrics.current ? procMetrics.current.cpu : 0,
      peakMemoryMB: procMetrics.peak ? procMetrics.peak.memory : 0,
    },

    routes: {
      total: routeMetrics.totalRoutes || 0,
      healthy: routeMetrics.healthy || 0,
      unhealthy: routeMetrics.unhealthy || 0,
      slowest: routeMetrics.slowest || null,
    },

    repairs: {
      total: repairs.total || 0,
      successes: repairs.successes || 0,
      failures: repairs.failures || 0,
      successRate: repairs.successRate || 0,
      totalCost: repairs.totalCost || 0,
      lastRepair,
    },

    usage: {
      totalTokens: usage.session ? usage.session.totalTokens : 0,
      totalCost: usage.session ? usage.session.totalCostUsd : 0,
      totalCalls: usage.session ? usage.session.totalCalls : 0,
      byCategory: usage.byCategory || {},
    },

    brain: {
      totalMemories: brainStats.totalEntries || 0,
      namespaces: brainStats.namespaces || {},
    },

    backups: {
      total: backups.total || 0,
      stable: backups.stable || 0,
      verified: backups.verified || 0,
      unstable: backups.unstable || 0,
    },
  };

  // Redact any secrets that might have leaked into error messages
  if (redactor) {
    if (payload.repairs.lastRepair) {
      payload.repairs.lastRepair.error = redactor.redact(payload.repairs.lastRepair.error || "");
      payload.repairs.lastRepair.resolution = redactor.redact(payload.repairs.lastRepair.resolution || "");
    }
  }

  return payload;
}

module.exports = { collectHeartbeat, INSTANCE_ID };
