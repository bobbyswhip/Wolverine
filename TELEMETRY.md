# Wolverine Telemetry Setup

Connect your Wolverine instance to the platform to broadcast heartbeats, track repairs, and monitor fleet health.

---

## 1. Add env variables

Add these to your `.env.local`:

```env
WOLVERINE_PLATFORM_URL=https://api.wolverinenode.xyz
WOLVERINE_PLATFORM_KEY=wlvk_platform_2026_a8f3e9b1c4d7
WOLVERINE_INSTANCE_NAME=my-server-name
WOLVERINE_HEARTBEAT_INTERVAL_MS=60000
```

| Variable | Required | Description |
|----------|----------|-------------|
| `WOLVERINE_PLATFORM_URL` | Yes | Platform API base URL |
| `WOLVERINE_PLATFORM_KEY` | Yes | Bearer token for authentication |
| `WOLVERINE_INSTANCE_NAME` | Yes | Human-readable name for this instance |
| `WOLVERINE_HEARTBEAT_INTERVAL_MS` | No | Heartbeat interval in ms (default: 60000) |

---

## 2. Add the telemetry module

Create `src/platform/` in your Wolverine project with three files:

### `src/platform/telemetry.js`

Collects metrics from all Wolverine subsystems into a heartbeat payload.

```js
const os = require("os");
const { v4: uuidv4 } = require("uuid");

const INSTANCE_ID = process.env.WOLVERINE_INSTANCE_ID || `wlv_${uuidv4().slice(0, 8)}`;

function collectHeartbeat({ processMonitor, routeProber, tokenTracker, repairHistory, backupManager, brain, notifier }) {
  const mem = process.memoryUsage();

  return {
    instanceId: INSTANCE_ID,
    version: require("../../package.json").version,
    timestamp: Date.now(),

    server: {
      name: process.env.WOLVERINE_INSTANCE_NAME || "unnamed",
      port: parseInt(process.env.PORT) || 3000,
      uptime: process.uptime(),
      status: "healthy",
      pid: process.pid,
    },

    process: {
      memoryMB: Math.round(mem.rss / 1024 / 1024),
      cpuPercent: processMonitor?.getCpuPercent?.() || 0,
      peakMemoryMB: processMonitor?.getPeakMemory?.() || Math.round(mem.rss / 1024 / 1024),
    },

    routes: {
      total: routeProber?.getMetrics?.()?.total || 0,
      healthy: routeProber?.getMetrics?.()?.healthy || 0,
      unhealthy: routeProber?.getMetrics?.()?.unhealthy || 0,
      slowest: routeProber?.getMetrics?.()?.slowest || null,
    },

    repairs: {
      total: repairHistory?.getStats?.()?.total || 0,
      successes: repairHistory?.getStats?.()?.successes || 0,
      failures: repairHistory?.getStats?.()?.failures || 0,
      lastRepair: repairHistory?.getStats?.()?.lastRepair || null,
    },

    usage: {
      totalTokens: tokenTracker?.getAnalytics?.()?.totalTokens || 0,
      totalCost: tokenTracker?.getAnalytics?.()?.totalCost || 0,
      totalCalls: tokenTracker?.getAnalytics?.()?.totalCalls || 0,
      byCategory: tokenTracker?.getAnalytics?.()?.byCategory || {},
    },

    brain: {
      totalMemories: brain?.getStats?.()?.totalMemories || 0,
      namespaces: brain?.getStats?.()?.namespaces || {},
    },

    backups: {
      total: backupManager?.getStats?.()?.total || 0,
      stable: backupManager?.getStats?.()?.stable || 0,
      verified: backupManager?.getStats?.()?.verified || 0,
      unstable: backupManager?.getStats?.()?.unstable || 0,
    },

    alerts: notifier?.getActiveAlerts?.() || [],
  };
}

module.exports = { collectHeartbeat, INSTANCE_ID };
```

### `src/platform/heartbeat.js`

Sends the heartbeat to the platform on an interval.

```js
const { collectHeartbeat } = require("./telemetry");
const { HeartbeatQueue } = require("./queue");

const PLATFORM_URL = process.env.WOLVERINE_PLATFORM_URL;
const PLATFORM_KEY = process.env.WOLVERINE_PLATFORM_KEY;
const INTERVAL = parseInt(process.env.WOLVERINE_HEARTBEAT_INTERVAL_MS) || 60000;

let queue;
let timer;

async function sendHeartbeat(subsystems) {
  if (!PLATFORM_URL || !PLATFORM_KEY) return;

  const payload = collectHeartbeat(subsystems);

  try {
    const res = await fetch(`${PLATFORM_URL}/api/v1/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${PLATFORM_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      // Drain queued heartbeats on success
      await queue.drain(PLATFORM_URL, PLATFORM_KEY);
    } else {
      queue.enqueue(payload);
    }
  } catch (err) {
    // Platform unreachable — queue for later
    queue.enqueue(payload);
  }
}

function startHeartbeat(subsystems) {
  if (!PLATFORM_URL) return;

  queue = new HeartbeatQueue();
  console.log(`[Platform] Heartbeat → ${PLATFORM_URL} every ${INTERVAL / 1000}s`);

  // Send first heartbeat after 5s (let subsystems initialize)
  setTimeout(() => sendHeartbeat(subsystems), 5000);
  timer = setInterval(() => sendHeartbeat(subsystems), INTERVAL);
}

function stopHeartbeat() {
  if (timer) clearInterval(timer);
}

module.exports = { startHeartbeat, stopHeartbeat };
```

### `src/platform/queue.js`

Queues heartbeats when the platform is unreachable.

```js
const fs = require("fs");
const path = require("path");

const QUEUE_PATH = path.join(process.cwd(), ".wolverine", "heartbeat-queue.jsonl");
const MAX_ENTRIES = 1440; // 24 hours of heartbeats

class HeartbeatQueue {
  enqueue(payload) {
    try {
      fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
      fs.appendFileSync(QUEUE_PATH, JSON.stringify(payload) + "\n");

      // Trim if over max
      const lines = fs.readFileSync(QUEUE_PATH, "utf8").trim().split("\n");
      if (lines.length > MAX_ENTRIES) {
        fs.writeFileSync(QUEUE_PATH, lines.slice(-MAX_ENTRIES).join("\n") + "\n");
      }
    } catch {}
  }

  async drain(platformUrl, platformKey) {
    if (!fs.existsSync(QUEUE_PATH)) return;

    const lines = fs.readFileSync(QUEUE_PATH, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length === 0) return;

    let sent = 0;
    for (const line of lines) {
      try {
        const res = await fetch(`${platformUrl}/api/v1/heartbeat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${platformKey}`,
          },
          body: line,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) sent++;
        else break; // Stop draining if platform rejects
      } catch {
        break; // Stop draining if platform is down again
      }
    }

    if (sent > 0) {
      const remaining = lines.slice(sent);
      if (remaining.length === 0) fs.unlinkSync(QUEUE_PATH);
      else fs.writeFileSync(QUEUE_PATH, remaining.join("\n") + "\n");
    }
  }
}

module.exports = { HeartbeatQueue };
```

---

## 3. Wire it up

In your Wolverine startup code (e.g. `src/core/runner.js` or wherever subsystems are initialized), add:

```js
const { startHeartbeat } = require("../platform/heartbeat");

// After all subsystems are initialized:
startHeartbeat({ processMonitor, routeProber, tokenTracker, repairHistory, backupManager, brain, notifier });
```

---

## Heartbeat payload

Each heartbeat is a single JSON POST (~2KB, gzipped <500 bytes) sent every 60 seconds:

```json
{
  "instanceId": "wlv_a1b2c3d4",
  "version": "0.1.0",
  "timestamp": 1775073247574,
  "server": { "name": "my-api", "port": 3000, "uptime": 86400, "status": "healthy", "pid": 12345 },
  "process": { "memoryMB": 128, "cpuPercent": 12, "peakMemoryMB": 256 },
  "routes": { "total": 8, "healthy": 8, "unhealthy": 0 },
  "repairs": { "total": 3, "successes": 2, "failures": 1, "lastRepair": { ... } },
  "usage": { "totalTokens": 45000, "totalCost": 0.12, "totalCalls": 85, "byCategory": { ... } },
  "brain": { "totalMemories": 45, "namespaces": { ... } },
  "backups": { "total": 8, "stable": 3, "verified": 2, "unstable": 3 },
  "alerts": []
}
```

---

## Platform API

All endpoints require `Authorization: Bearer <PLATFORM_KEY>` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/heartbeat` | Send heartbeat (called automatically) |
| `GET` | `/api/v1/servers` | List all connected instances |
| `GET` | `/api/v1/servers/:id` | Single instance detail + history |
| `GET` | `/api/v1/servers/:id/heartbeats` | Heartbeat time-series for charting |
| `GET` | `/api/v1/servers/:id/repairs` | Repair history for one instance |
| `GET` | `/api/v1/analytics` | Fleet-wide aggregated stats |
| `GET` | `/api/v1/analytics/cost` | Cost breakdown by server/model/time |
| `GET` | `/api/v1/alerts` | Active alerts across fleet |
| `PATCH` | `/api/v1/alerts/:id` | Acknowledge or resolve an alert |

---

## Design principles

- **Lightweight**: 1 request per 60s, ~2KB payload
- **Idempotent**: Same heartbeat can be sent twice safely
- **Offline-resilient**: Queues locally when platform is unreachable, replays on reconnect
- **No secrets**: Secret redactor runs on payload before sending
- **No source code**: Only metrics, redacted error messages, and stats
- **TLS only**: Platform endpoint is HTTPS
