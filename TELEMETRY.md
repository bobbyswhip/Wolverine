# Wolverine Telemetry

Connect your Wolverine instance to a platform backend for fleet-wide monitoring, uptime tracking, and cost analytics.

## Setup

### 1. Deploy your platform backend

See [PLATFORM.md](PLATFORM.md) for the full backend spec — database schema, API endpoints, scaling strategy.

Your backend needs to implement:
- `POST /api/v1/heartbeat` — receive heartbeat payloads
- `GET /api/v1/servers` — list connected instances
- Standard Bearer token auth

### 2. Configure your Wolverine instance

Add to `.env.local`:

```env
WOLVERINE_PLATFORM_URL=https://your-platform.com
WOLVERINE_PLATFORM_KEY=your_api_key_here
```

That's it. Wolverine starts sending heartbeats every 60 seconds.

### Optional settings

```env
# Human-readable name (defaults to folder name)
WOLVERINE_INSTANCE_NAME=my-api-prod

# Heartbeat interval in ms (default: 60000 = 1 minute)
WOLVERINE_HEARTBEAT_INTERVAL_MS=60000
```

### 3. Verify

On startup you'll see:

```
📡 Platform: https://your-platform.com (every 60s)
📡 Instance: wlv_a8f3e9b1c4d7
```

If the platform is unreachable, heartbeats queue locally in `.wolverine/heartbeat-queue.jsonl` and drain automatically when connectivity returns.

---

## Heartbeat Payload

Each heartbeat is ~2KB JSON, sent every 60 seconds:

```json
{
  "instanceId": "wlv_a8f3e9b1c4d7",
  "version": "0.1.0",
  "timestamp": 1775073247574,
  "server": {
    "name": "my-api",
    "port": 3000,
    "uptime": 86400,
    "status": "healthy",
    "pid": 12345
  },
  "process": {
    "memoryMB": 128,
    "cpuPercent": 12,
    "peakMemoryMB": 256
  },
  "routes": {
    "total": 8,
    "healthy": 8,
    "unhealthy": 0
  },
  "repairs": {
    "total": 3,
    "successes": 2,
    "failures": 1,
    "lastRepair": { "error": "...", "resolution": "...", "tokens": 1820, "cost": 0.0045 }
  },
  "usage": {
    "totalTokens": 45000,
    "totalCost": 0.12,
    "totalCalls": 85,
    "byCategory": { "heal": {...}, "chat": {...}, "develop": {...} }
  },
  "brain": { "totalMemories": 45 },
  "backups": { "total": 8, "stable": 3 }
}
```

## Design

- **Opt-in**: disabled unless `WOLVERINE_PLATFORM_URL` and `WOLVERINE_PLATFORM_KEY` are set
- **Lightweight**: 1 request per 60s, ~2KB payload
- **Offline-resilient**: queues locally when platform is down, replays on reconnect (max 24h / 1440 entries)
- **Secure**: secrets redacted before sending, HTTPS supported, Bearer token auth
- **No source code**: only metrics, redacted error messages, and stats

## Files

```
src/platform/
├── telemetry.js   — Collects metrics from all subsystems into heartbeat payload
├── heartbeat.js   — Sends heartbeats on interval, handles failures
└── queue.js       — Offline queue with replay on reconnect
```
