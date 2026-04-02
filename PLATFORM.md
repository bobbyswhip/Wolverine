# Wolverine Platform — Multi-Server Analytics & Management

## Overview

The Wolverine Platform aggregates data from hundreds/thousands of wolverine server instances into a single backend + frontend dashboard. Each wolverine instance runs independently and broadcasts lightweight telemetry to the platform.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Wolverine #1 │  │ Wolverine #2 │  │ Wolverine #3 │  ... (N instances)
│  server:3000 │  │  server:4000 │  │  server:5000 │
│  dash:3001   │  │  dash:4001   │  │  dash:5001   │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       │  heartbeat      │  heartbeat      │  heartbeat
       │  (every 60s)    │  (every 60s)    │  (every 60s)
       ▼                 ▼                 ▼
┌─────────────────────────────────────────────────┐
│            Wolverine Platform Backend            │
│                                                  │
│  POST /api/v1/heartbeat    ← receive telemetry   │
│  GET  /api/v1/servers      ← list all instances  │
│  GET  /api/v1/servers/:id  ← single instance     │
│  GET  /api/v1/analytics    ← aggregated stats    │
│  GET  /api/v1/alerts       ← active alerts       │
│  WS   /ws/live             ← real-time stream    │
│                                                  │
│  Database: PostgreSQL (time-series optimized)    │
│  Cache: Redis (live state, pub/sub)              │
│  Queue: Bull/BullMQ (alert processing)           │
└─────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│            Wolverine Platform Frontend           │
│                                                  │
│  Fleet overview — all servers at a glance        │
│  Per-server deep dive — events, repairs, usage   │
│  Cost analytics — tokens, USD, by model          │
│  Alert management — acknowledge, escalate        │
│  Uptime history — SLA tracking over time         │
└─────────────────────────────────────────────────┘
```

---

## Telemetry Protocol

### Heartbeat Payload

Each wolverine instance sends a heartbeat every **60 seconds** (configurable). This is the only outbound traffic — minimal network impact.

```json
POST /api/v1/heartbeat
Authorization: Bearer <PLATFORM_API_KEY>
Content-Type: application/json

{
  "instanceId": "wlv_a1b2c3d4",
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
    "unhealthy": 0,
    "slowest": { "path": "/api/search", "avgMs": 450 }
  },

  "repairs": {
    "total": 3,
    "successes": 2,
    "failures": 1,
    "lastRepair": {
      "error": "TypeError: Cannot read property 'id' of undefined",
      "resolution": "Added null check before accessing user.id",
      "tokens": 1820,
      "cost": 0.0045,
      "mode": "fast",
      "timestamp": 1775073200000
    }
  },

  "usage": {
    "totalTokens": 45000,
    "totalCost": 0.12,
    "totalCalls": 85,
    "byCategory": {
      "heal": { "tokens": 12000, "cost": 0.04, "calls": 5 },
      "chat": { "tokens": 25000, "cost": 0.05, "calls": 60 },
      "classify": { "tokens": 3000, "cost": 0.001, "calls": 15 },
      "develop": { "tokens": 5000, "cost": 0.03, "calls": 5 }
    },
    "byModel": {
      "gpt-5.4-mini": { "tokens": 30000, "cost": 0.06, "calls": 40 },
      "gpt-4o-mini": { "tokens": 15000, "cost": 0.02, "calls": 45 }
    },
    "byTool": {
      "call_endpoint": { "tokens": 5000, "cost": 0.01, "calls": 20 },
      "search_brain": { "tokens": 2000, "cost": 0.005, "calls": 10 }
    }
  },

  "brain": {
    "totalMemories": 45,
    "namespaces": { "docs": 23, "functions": 12, "errors": 5, "fixes": 3, "learnings": 2 }
  },

  "backups": {
    "total": 8,
    "stable": 3,
    "verified": 2,
    "unstable": 3
  },

  "alerts": [
    {
      "type": "memory_leak",
      "message": "Memory growing: +50MB over 10 samples",
      "severity": "warn",
      "timestamp": 1775073100000
    }
  ]
}
```

### Design Principles

- **Infrequent**: 1 heartbeat per 60 seconds = 1440/day per instance
- **Small**: ~2KB per payload, gzipped < 500 bytes
- **Idempotent**: same heartbeat can be sent twice safely (upsert by instanceId + timestamp)
- **Offline-resilient**: if platform is down, wolverine queues heartbeats and replays on reconnect
- **No PII**: never send secrets, user data, or source code in heartbeats

---

## Platform Backend Architecture

### Database Schema (PostgreSQL)

```sql
-- Servers — one row per wolverine instance
CREATE TABLE servers (
  id TEXT PRIMARY KEY,                -- "wlv_a1b2c3d4"
  name TEXT NOT NULL,
  version TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',  -- healthy, degraded, down, unknown
  config JSONB                        -- port, models, etc.
);

-- Time-series heartbeats — partitioned by day for scale
CREATE TABLE heartbeats (
  id BIGSERIAL,
  server_id TEXT NOT NULL REFERENCES servers(id),
  timestamp TIMESTAMPTZ NOT NULL,
  uptime INTEGER,
  memory_mb INTEGER,
  cpu_percent INTEGER,
  routes_total INTEGER,
  routes_healthy INTEGER,
  routes_unhealthy INTEGER,
  tokens_total INTEGER,
  cost_total NUMERIC(10,6),
  repairs_total INTEGER,
  repairs_successes INTEGER,
  payload JSONB                       -- full heartbeat for deep queries
) PARTITION BY RANGE (timestamp);

-- Create daily partitions automatically (pg_partman or manual)
-- This allows dropping old data by partition instead of DELETE

-- Repairs — detailed log of every fix
CREATE TABLE repairs (
  id BIGSERIAL PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  timestamp TIMESTAMPTZ NOT NULL,
  error TEXT,
  resolution TEXT,
  success BOOLEAN,
  mode TEXT,                          -- fast, agent, sub-agents
  model TEXT,
  tokens INTEGER,
  cost NUMERIC(10,6),
  iteration INTEGER,
  duration_ms INTEGER
);

-- Alerts — active and historical
CREATE TABLE alerts (
  id BIGSERIAL PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  type TEXT NOT NULL,                 -- memory_leak, route_down, crash_loop, etc.
  message TEXT,
  severity TEXT,                      -- info, warn, error, critical
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  acknowledged_by TEXT
);

-- Usage aggregates — hourly rollups for fast analytics
CREATE TABLE usage_hourly (
  server_id TEXT NOT NULL REFERENCES servers(id),
  hour TIMESTAMPTZ NOT NULL,
  tokens_total INTEGER DEFAULT 0,
  cost_total NUMERIC(10,6) DEFAULT 0,
  calls_total INTEGER DEFAULT 0,
  tokens_by_category JSONB,
  PRIMARY KEY (server_id, hour)
);

-- Indexes for common queries
CREATE INDEX idx_heartbeats_server_time ON heartbeats (server_id, timestamp DESC);
CREATE INDEX idx_repairs_server_time ON repairs (server_id, timestamp DESC);
CREATE INDEX idx_alerts_active ON alerts (server_id) WHERE resolved_at IS NULL;
CREATE INDEX idx_servers_status ON servers (status);
```

### API Endpoints

```
Authentication: Bearer token (PLATFORM_API_KEY)

POST /api/v1/heartbeat              ← Receive heartbeat from wolverine instance
  → Upsert server, insert heartbeat, process alerts
  → Returns: { received: true, serverTime: "..." }

GET  /api/v1/servers                ← List all instances
  → Query: ?status=healthy&sort=last_heartbeat&limit=50&offset=0
  → Returns: { servers: [...], total: 150, page: 1 }

GET  /api/v1/servers/:id            ← Single instance detail
  → Returns: full server state + recent heartbeats + repairs + alerts

GET  /api/v1/servers/:id/heartbeats ← Heartbeat history
  → Query: ?from=2026-04-01&to=2026-04-02&interval=5m
  → Returns: time-series data for charting

GET  /api/v1/servers/:id/repairs    ← Repair history for one server
  → Query: ?limit=50&success=true
  → Returns: { repairs: [...], stats: { total, successes, avgTokens } }

GET  /api/v1/analytics              ← Fleet-wide aggregates
  → Query: ?period=24h or ?from=...&to=...
  → Returns: {
      totalServers, activeServers, totalRepairs, successRate,
      totalTokens, totalCost, tokensByCategory, costByModel,
      uptimePercent, avgResponseTime
    }

GET  /api/v1/analytics/cost         ← Cost breakdown
  → Query: ?period=7d&groupBy=server|model|category
  → Returns: cost time-series + breakdown

GET  /api/v1/alerts                 ← Active alerts across fleet
  → Query: ?severity=critical&acknowledged=false
  → Returns: { alerts: [...], total: 5 }

PATCH /api/v1/alerts/:id            ← Acknowledge/resolve alert
  → Body: { action: "acknowledge" | "resolve", by: "admin@..." }

WS   /ws/live                       ← Real-time WebSocket stream
  → Streams: heartbeats, alerts, repairs as they arrive
  → Subscribe: { subscribe: ["heartbeat", "alert", "repair"] }
  → Filter: { servers: ["wlv_a1b2c3d4"] }
```

### Scaling Strategy

```
10 servers:     Single PostgreSQL, single Node.js backend
100 servers:    PostgreSQL with connection pooling (pgBouncer), Redis cache
1,000 servers:  Partitioned heartbeats table, read replicas, queue workers
10,000 servers: TimescaleDB for time-series, horizontal API scaling, Kafka for ingestion
100,000+:       Sharded by server_id, dedicated ingestion pipeline, ClickHouse for analytics
```

**Key scaling decisions:**
- Heartbeats are **append-only** — no updates, only inserts → perfect for time-series DBs
- Hourly rollups in `usage_hourly` prevent expensive full-table scans for analytics
- Partitioned by day → drop old data by partition (instant, no vacuum)
- Redis caches the "current state" of each server (latest heartbeat) → fast fleet overview
- WebSocket uses Redis pub/sub → horizontal scaling of frontend connections
- Alert processing is async via job queue → doesn't block heartbeat ingestion

### Redis Structure

```
wolverine:server:{id}:state     ← Latest heartbeat (JSON, TTL 5min)
wolverine:server:{id}:uptime    ← Uptime counter (INCR every heartbeat)
wolverine:servers:active         ← Sorted set (score = last_heartbeat timestamp)
wolverine:alerts:active          ← Set of active alert IDs
wolverine:stats:fleet            ← Cached fleet-wide aggregates (TTL 30s)
wolverine:pubsub:heartbeats     ← Pub/sub channel for real-time streaming
wolverine:pubsub:alerts         ← Pub/sub channel for alert notifications
```

---

## Platform Frontend

### Pages

**1. Fleet Overview**
- Grid/list of all server instances
- Color-coded status: green (healthy), yellow (degraded), red (down), gray (unknown)
- Sortable by: status, uptime, memory, cost, last repair
- Search/filter by name, status, tags
- Fleet-wide stats bar: total servers, active, repairs today, cost today

**2. Server Detail**
- Real-time stats: memory, CPU, uptime, routes
- Event timeline (same as local dashboard but from platform data)
- Repair history with resolution details + token cost
- Usage chart: tokens over time, cost over time
- Route health table with response time trends
- Backup status
- Brain stats

**3. Analytics**
- Fleet-wide token usage over time (by day/hour)
- Cost breakdown: by server, by model, by category
- Repair success rate over time
- Mean time to repair (MTTR) trend
- Most expensive servers / most repaired servers
- Uptime SLA tracking (99.9% target)
- Response time percentiles across fleet

**4. Alerts**
- Active alerts sorted by severity
- Acknowledge / resolve workflow
- Alert history with resolution notes
- Alert rules configuration (memory threshold, crash count, response time)

**5. Cost Management**
- Total spend by period (day/week/month)
- Per-server cost ranking
- Per-model cost ranking
- Projected monthly cost based on current usage
- Budget alerts (notify when approaching limit)

### Tech Stack Recommendation

```
Frontend:  Next.js + Tailwind + Recharts (or Tremor for dashboard components)
Backend:   Node.js + Express + PostgreSQL + Redis + BullMQ
Auth:      NextAuth.js or Clerk (team management)
Hosting:   Vercel (frontend) + Railway/Fly.io (backend) + Supabase (PostgreSQL)
WebSocket: Socket.io or native WS through the backend
```

---

## Wolverine Client Integration

### New env variables for the wolverine instance:

```env
# Platform telemetry (optional — wolverine works fine without it)
WOLVERINE_PLATFORM_URL=https://api.wolverine.dev
WOLVERINE_PLATFORM_KEY=wlvk_your_api_key_here
WOLVERINE_INSTANCE_NAME=my-api-prod
WOLVERINE_HEARTBEAT_INTERVAL_MS=60000
```

### Telemetry module to build in wolverine:

```
src/platform/
├── telemetry.js      ← Collects heartbeat data from all subsystems
├── heartbeat.js      ← Sends heartbeat to platform on interval
└── queue.js          ← Queues heartbeats when platform is unreachable
```

**telemetry.js** gathers data from:
- `processMonitor.getMetrics()` → memory, CPU
- `routeProber.getMetrics()` → route health
- `tokenTracker.getAnalytics()` → usage
- `repairHistory.getStats()` → repairs
- `backupManager.getStats()` → backups
- `brain.getStats()` → brain
- `notifier` → active alerts

**heartbeat.js** sends it:
- HTTP POST to platform every 60s
- Gzip compressed
- Timeout: 5s (don't block if platform is slow)
- On failure: queue locally, retry with exponential backoff
- On reconnect: replay queued heartbeats

**queue.js** handles offline resilience:
- Append to `.wolverine/heartbeat-queue.jsonl` when platform unreachable
- On next successful heartbeat, drain the queue (oldest first)
- Max queue size: 1440 entries (24 hours of heartbeats)
- After 24h, drop oldest entries (stale data isn't useful)

---

## Security Considerations

- **Platform API key** per instance — revokable, rotatable
- **Secret redactor** runs on heartbeat payload before sending (no env values leak)
- **No source code** in heartbeats — only metrics, error messages (redacted), and stats
- **TLS only** — platform endpoint must be HTTPS
- **Rate limiting** on platform ingestion — max 1 heartbeat/second per instance
- **Tenant isolation** — multi-tenant platform must scope data by organization
- **Audit log** — track who acknowledged/resolved alerts

---

## Implementation Priority

### Phase 1: Core (1-2 weeks)
1. Platform backend: heartbeat ingestion + server listing + basic API
2. Wolverine telemetry module: collect + send heartbeats
3. Frontend: fleet overview + server detail page
4. PostgreSQL schema + Redis caching

### Phase 2: Analytics (1 week)
1. Hourly usage rollups
2. Cost analytics page
3. Repair history aggregation
4. Uptime tracking

### Phase 3: Alerting (1 week)
1. Alert rules engine
2. Acknowledge/resolve workflow
3. Email/Slack/webhook notifications
4. Alert history

### Phase 4: Scale (ongoing)
1. TimescaleDB migration for heartbeats
2. Horizontal API scaling
3. WebSocket real-time streaming
4. Team management + RBAC
