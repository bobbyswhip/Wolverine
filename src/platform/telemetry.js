const crypto = require("crypto");
const path = require("path");

// Stable instance ID — hash of cwd+port, persists across restarts
const INSTANCE_ID = process.env.WOLVERINE_INSTANCE_ID ||
  "wlv_" + crypto.createHash("sha256").update(process.cwd() + (process.env.PORT || "3000")).digest("hex").slice(0, 12);

let _cachedVersion = null;

function collectHeartbeat(subsystems) {
  if (!_cachedVersion) {
    try { _cachedVersion = require("../../package.json").version; } catch { _cachedVersion = "0.0.0"; }
  }

  const { processMonitor, routeProber, tokenTracker, repairHistory, backupManager, brain, redactor } = subsystems;

  // Only call getters that exist — no intermediate objects
  const proc = processMonitor?.getMetrics();
  const usage = tokenTracker?.getAnalytics();
  const repairs = repairHistory?.getStats();

  const payload = {
    id: INSTANCE_ID,
    v: _cachedVersion,
    t: Date.now(),
    name: process.env.WOLVERINE_INSTANCE_NAME || path.basename(process.cwd()),
    up: Math.round(process.uptime()),
    mem: proc?.current?.rss || Math.round(process.memoryUsage().rss / 1048576),
    cpu: proc?.current?.cpu || 0,
    routes: routeProber?.getSummary() || {},
    repairs: repairs || {},
    tokens: usage?.session?.totalTokens || 0,
    cost: usage?.session?.totalCostUsd || 0,
    calls: usage?.session?.totalCalls || 0,
    brain: brain?.getStats()?.totalEntries || 0,
    backups: backupManager?.getStats()?.total || 0,
  };

  // Redact last repair error if present
  if (redactor && repairs?.lastRepair) {
    payload.lastError = redactor.redact((repairs.lastRepair?.error || "").slice(0, 150));
  }

  return payload;
}

module.exports = { collectHeartbeat, INSTANCE_ID };
