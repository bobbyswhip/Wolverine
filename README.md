# Wolverine Node.js

**Self-healing Node.js servers powered by an AI coding harness.**

Wolverine watches your server process, catches crashes, diagnoses errors with AI, generates fixes, verifies them, and restarts — automatically. It also has a dashboard with a command interface where you can tell the agent to build features, and it will modify your server code directly.

Built on patterns from [claw-code](https://github.com/instructkr/claw-code) — the open-source Claude Code harness.

---

## Quick Start

### Install from npm

```bash
npm i wolverine-ai
cp node_modules/wolverine-ai/.env.example .env.local
# Edit .env.local — add your OPENAI_API_KEY
npx wolverine server/index.js
```

### Or clone from GitHub

```bash
git clone https://github.com/bobbyswhip/Wolverine.git
cd Wolverine
npm install
cp .env.example .env.local
# Edit .env.local — add your OPENAI_API_KEY
npm start
```

[![npm](https://img.shields.io/npm/v/wolverine-ai)](https://www.npmjs.com/package/wolverine-ai)
[![GitHub](https://img.shields.io/github/stars/bobbyswhip/Wolverine)](https://github.com/bobbyswhip/Wolverine)

Dashboard opens at `http://localhost:PORT+1`. Server runs on `PORT`.

### Try a Demo

Demos copy a buggy server into `server/`, let wolverine fix it, then restore your original:

```bash
npm run demo:list            # See all demos
npm run demo:01              # Basic typo (ReferenceError)
npm run demo:02              # Multi-file import mismatch
npm run demo:03              # Syntax error (extra paren)
npm run demo:04              # Secret leak in error output
npm run demo:05              # External service down (human notification)
npm run demo:06              # JSON config typo
npm run demo:07              # null.toString() crash
```

Each demo:
1. Backs up your current `server/` directory
2. Copies the buggy demo into `server/`
3. Runs wolverine — watch it detect, diagnose, fix, verify, and restart
4. Restores your original `server/` when you press Ctrl+C

---

## Architecture

```
wolverine/
├── server/                  ← YOUR server code (agent can edit)
│   ├── index.js             ← Entry point
│   ├── routes/              ← Route modules
│   └── config/settings.json ← All settings (models, cluster, telemetry, limits)
├── src/
│   ├── core/                ← Wolverine engine
│   │   ├── wolverine.js     ← Heal pipeline + goal loop
│   │   ├── runner.js        ← Process manager (PM2-like)
│   │   ├── ai-client.js     ← OpenAI client (Chat + Responses API)
│   │   ├── models.js        ← 10-model configuration system
│   │   ├── verifier.js      ← Fix verification (syntax + boot probe)
│   │   ├── error-parser.js  ← Stack trace parsing + error classification
│   │   ├── error-hook.js   ← Auto-injected into child (IPC error reporting)
│   │   ├── patcher.js       ← File patching with sandbox
│   │   ├── health-monitor.js← PM2-style health checks
│   │   ├── config.js        ← Config loader (settings.json + env)
│   │   ├── system-info.js   ← Machine detection (cores, RAM, cloud, containers)
│   │   └── cluster-manager.js← Auto-scaling worker management
│   ├── agent/               ← AI agent system
│   │   ├── agent-engine.js  ← Multi-turn agent with 10 tools
│   │   ├── goal-loop.js     ← Goal-driven repair loop
│   │   ├── research-agent.js← Deep research + learning from failures
│   │   └── sub-agents.js    ← 7 specialized sub-agents (explore/plan/fix/verify/...)
│   ├── security/            ← Security stack
│   │   ├── sandbox.js       ← Directory-locked file access
│   │   ├── secret-redactor.js← Env value → key name replacement
│   │   ├── injection-detector.js ← AI-powered prompt injection scan
│   │   ├── rate-limiter.js  ← Error explosion protection
│   │   └── admin-auth.js    ← Dashboard admin authentication
│   ├── brain/               ← Semantic memory
│   │   ├── brain.js         ← Vector store + function map + learning
│   │   ├── vector-store.js  ← In-memory cosine similarity search
│   │   ├── embedder.js      ← Embedding + text compaction pipeline
│   │   └── function-map.js  ← Live project scanner
│   ├── backup/              ← Smart backup system
│   │   └── backup-manager.js← Full server/ snapshots with retention
│   ├── logger/              ← Observability
│   │   ├── event-logger.js  ← Structured event bus + JSONL persistence
│   │   ├── token-tracker.js ← Token usage + USD cost tracking
│   │   ├── repair-history.js← Error/resolution audit trail
│   │   └── pricing.js       ← Model cost calculations
│   ├── monitor/             ← Performance + process management
│   │   ├── perf-monitor.js  ← Endpoint response times + spam detection
│   │   ├── process-monitor.js← Memory/CPU/heartbeat + leak detection
│   │   ├── route-prober.js  ← Auto-discovers and tests all routes
│   │   └── error-monitor.js ← Caught 500 error detection (no-crash healing)
│   ├── dashboard/           ← Web UI
│   │   └── server.js        ← Real-time dashboard + command interface
│   ├── notifications/       ← Alerts
│   │   └── notifier.js      ← Human-required error detection
│   ├── mcp/                 ← External tools
│   │   ├── mcp-client.js    ← MCP protocol client (stdio + HTTP)
│   │   ├── mcp-registry.js  ← Server discovery + tool registration
│   │   └── mcp-security.js  ← Allowlists + injection scan on MCP results
│   ├── skills/              ← Reusable capabilities
│   │   ├── skill-registry.js← Auto-discovery + prompt injection
│   │   └── sql.js           ← Cluster-safe SQL + injection prevention
│   └── platform/            ← Fleet telemetry
│       ├── telemetry.js     ← Collects heartbeat data from all subsystems
│       ├── heartbeat.js     ← Sends heartbeats to platform backend
│       ├── register.js      ← Auto-registration on first run
│       └── queue.js         ← Offline queue with replay
├── bin/wolverine.js         ← CLI entry point (cluster-aware)
├── tests/                   ← Test suite
└── .wolverine/              ← Runtime state (gitignored)
    ├── brain/               ← Vector store persistence
    ├── events/              ← Event log (JSONL)
    ├── backups/             ← Server snapshots
    ├── usage.json           ← Token usage aggregates
    ├── usage-history.jsonl  ← Full token usage timeline
    ├── repair-history.json  ← Error/resolution audit trail
    └── mcp.json             ← MCP server configuration
```

---

## How Self-Healing Works

```
Server crashes
  → Error parsed (file, line, message, errorType)
  → Error classified: missing_module | missing_file | permission | port_conflict | syntax | runtime
  → Secrets redacted from error output
  → Prompt injection scan (AUDIT_MODEL)
  → Human-required check (expired keys, service down → notify, don't waste tokens)
  → Rate limit check (error loop → exponential backoff)

Operational Fix (zero AI tokens):
  → "Cannot find module 'cors'" → npm install cors (instant, free)
  → ENOENT on config file → create missing file with defaults
  → EACCES/EPERM → chmod 755
  → If operational fix works → done. No AI needed.

Goal Loop (iterate until fixed or exhausted):
  Iteration 1: Fast path (CODING_MODEL, single file, ~1-2k tokens)
    → AI returns code changes AND/OR shell commands (npm install, mkdir, etc.)
    → Execute commands first, apply patches second
    → Verify (syntax check + boot probe) → Pass? Done.
  Iteration 2: Single agent (REASONING_MODEL, multi-file, 10 tools)
    → Agent has error pattern → fix strategy table
    → Uses bash_exec for npm install, chmod, config creation
    → Uses edit_file for code fixes
    → Verify → Pass? Done.
  Iteration 3: Sub-agents (explore → plan → fix)
    → Explorer finds relevant files (read-only)
    → Planner considers operational vs code fixes
    → Fixer has bash_exec + file tools (can npm install AND edit code)
    → Deep research (RESEARCH_MODEL) feeds into context
    → Each failure feeds into the next attempt

After fix:
  → Record to repair history (error, resolution, tokens, cost, mode)
  → Store in brain for future reference
  → Promote backup to stable after 30min uptime
```

### Caught Error Healing (No-Crash)

Most production bugs don't crash the process — Fastify/Express catch them and return 500. Wolverine now detects these too:

```
Route returns 500 (process still alive)
  → Error hook reports to parent via IPC (auto-injected, zero user code changes)
  → ErrorMonitor tracks consecutive 500s per route
  → 3 failures in 30s → triggers heal pipeline (same as crash healing)
  → Fix applied → server restarted → route prober verifies fix
```

| Setting | Default | Env Variable |
|---------|---------|-------------|
| Failure threshold | 3 | `WOLVERINE_ERROR_THRESHOLD` |
| Time window | 30s | `WOLVERINE_ERROR_WINDOW_MS` |
| Cooldown per route | 60s | `WOLVERINE_ERROR_COOLDOWN_MS` |

The error hook auto-patches Fastify and Express via `--require` preload. No middleware, no code changes to your server.

---

## Agent Tool Harness

The AI agent has 16 built-in tools (inspired by [claw-code](https://github.com/ultraworkers/claw-code)):

| Tool | Category | Description |
|------|----------|-------------|
| `read_file` | File | Read any file with optional offset/limit for large files |
| `write_file` | File | Write complete file content, creates parent dirs |
| `edit_file` | File | Surgical find-and-replace without rewriting entire file |
| `glob_files` | File | Pattern-based file discovery (`**/*.js`, `src/**/*.json`) |
| `grep_code` | File | Regex search across codebase with context lines |
| `list_dir` | File | List directory contents with sizes (find misplaced files) |
| `move_file` | File | Move or rename files (fix structure problems) |
| `bash_exec` | Shell | Sandboxed shell execution (npm install, chmod, kill, etc.) |
| `git_log` | Shell | View recent commit history |
| `git_diff` | Shell | View uncommitted changes |
| `inspect_db` | Database | List tables, show schema, run SELECT on SQLite databases |
| `run_db_fix` | Database | UPDATE/DELETE/INSERT/ALTER on SQLite (auto-backup before write) |
| `check_port` | Diagnostic | Check if a port is in use and by what process |
| `check_env` | Diagnostic | Check environment variables (values auto-redacted) |
| `web_fetch` | Research | Fetch URL content for documentation/research |
| `done` | Control | Signal task completion with summary |

**Blocked commands** (from claw-code's `destructiveCommandWarning`):
`rm -rf /`, `git push --force`, `git reset --hard`, `npm publish`, `curl | bash`, `eval()`

**Protected paths** — the agent can NEVER modify:
`src/`, `bin/`, `tests/`, `node_modules/`, `.env`, `package.json`

Only files in `server/` are editable.

### Sub-Agents

For complex repairs, wolverine spawns specialized sub-agents that run in sequence or parallel:

| Agent | Access | Model | Role |
|-------|--------|-------|------|
| `explore` | Read+diagnostics | REASONING | Investigate codebase, check env/ports/databases |
| `plan` | Read-only | REASONING | Analyze problem, propose fix strategy |
| `fix` | Read+write+shell | CODING | Execute targeted fix — code edits AND npm install/chmod |
| `verify` | Read-only | REASONING | Check if fix actually works |
| `research` | Read-only | RESEARCH | Search brain + web for solutions |
| `security` | Read-only | AUDIT | Audit code for vulnerabilities |
| `database` | Read+write+SQL | CODING | Database fixes: inspect_db + run_db_fix + SQL skill |

Each sub-agent gets **restricted tools** — the explorer can't write files, the fixer can't search the web. This prevents agents from overstepping their role. Diagnostic tools (check_port, check_env, inspect_db, list_dir) are available to explorers and planners for investigation.

**Workflows:**
- `exploreAndFix()` — explore → plan → fix (sequential, 3 agents)
- `spawnParallel()` — run multiple agents concurrently (e.g., security + explore)

---

## Dashboard

Real-time web UI at `http://localhost:PORT+1`:

| Panel | What it shows |
|-------|--------------|
| **Overview** | Heals, errors, rollbacks, memories, uptime + recent events |
| **Events** | Live SSE event stream with color-coded severity |
| **Performance** | Endpoint response times, request rates, error rates |
| **Command** | Admin chat interface — ask questions or build features |
| **Analytics** | Memory/CPU charts, route health, per-route response times + trends |
| **Backups** | Full backup management: rollback/hot-load buttons, undo, rollback log, admin IP allowlist |
| **Brain** | Vector store stats (23 seed docs), namespace counts, function map |
| **Repairs** | Error/resolution audit trail: error, fix, tokens, cost, duration |
| **Tools** | Agent tool harness listing (10 built-in + MCP) |
| **Usage** | Token analytics: by model, by category, by tool + USD cost per call |

### Command Interface

Three routes (AI-classified per command):

| Route | Model | Tools | When |
|-------|-------|-------|------|
| **SIMPLE** | CHAT_MODEL | None | Knowledge questions, explanations |
| **TOOLS** | TOOL_MODEL | call_endpoint, read_file, search_brain | Live data, file contents |
| **AGENT** | CODING_MODEL | Full 10-tool harness | Build features, fix code |

Secured with `WOLVERINE_ADMIN_KEY` + IP allowlist (localhost + `WOLVERINE_ADMIN_IPS`).

---

## 10-Model Configuration

Every AI task has its own model slot. Customize in `.env.local`:

| Env Variable | Role | Needs Tools? | Cost Impact |
|---|---|---|---|
| `REASONING_MODEL` | Multi-file agent | Yes | High (agent loop) |
| `CODING_MODEL` | Code repair/generation | Responses API | Medium-high |
| `CHAT_MODEL` | Simple text responses | No | Low |
| `TOOL_MODEL` | Chat with function calling | **Yes** | Medium |
| `CLASSIFIER_MODEL` | SIMPLE/TOOLS/AGENT routing | No | ~10 tokens |
| `AUDIT_MODEL` | Injection detection (every error) | No | Low |
| `COMPACTING_MODEL` | Text compression for brain | No | Low |
| `RESEARCH_MODEL` | Deep research on failures | No | High (rare) |
| `TEXT_EMBEDDING_MODEL` | Brain vector embeddings | No | Very low |

Reasoning models (`o-series`, `gpt-5-nano`) automatically get 4x token limits to accommodate chain-of-thought.

---

## Security

| Layer | What it does |
|-------|-------------|
| **Secret Redactor** | Reads `.env.local`, replaces secret values with `process.env.KEY_NAME` in all AI calls, logs, brain, dashboard |
| **Injection Detector** | Regex layer + AI audit (AUDIT_MODEL) on every error before repair |
| **Sandbox** | All file operations locked to project directory, symlink escape detection |
| **Protected Paths** | Agent blocked from modifying wolverine internals (`src/`, `bin/`, etc.) |
| **Admin Auth** | Dashboard requires key + IP allowlist. Localhost always allowed. Remote IPs via `WOLVERINE_ADMIN_IPS` env var or `POST /api/admin/add-ip` at runtime. Timing-safe comparison, lockout after 10 failures |
| **Rate Limiter** | Sliding window, min gap, hourly budget, exponential backoff on error loops |
| **MCP Security** | Per-server tool allowlists, arg sanitization, result injection scanning |
| **SQL Skill** | `sqlGuard()` middleware blocks 15 injection pattern families on all endpoints |

---

## Brain (Semantic Memory)

Vector database that gives wolverine long-term memory:

- **Function Map** — scans `server/` on startup, indexes all routes, functions, classes, exports
- **Error History** — past errors with context for loop prevention
- **Fix History** — successful and failed repairs for learning
- **Learnings** — research findings, admin commands, patterns discovered
- **Skill Knowledge** — embedded docs for SQL skill, best practices, wolverine itself

**Two-tier search** for speed:
1. Keyword match (instant, 0ms) — catches most lookups
2. Semantic embedding search (API call) — only when keywords miss

---

## Process Manager

Wolverine acts as a PM2-like process manager with AI-powered diagnostics:

| Feature | What it does |
|---------|-------------|
| **Heartbeat** | Checks if the process is alive every 10 seconds |
| **Memory monitoring** | Tracks RSS/heap, detects leaks (N consecutive growth samples → restart) |
| **Memory limit** | Auto-restart when RSS exceeds threshold (default 512MB, configurable) |
| **CPU tracking** | Samples CPU% with color-coded charting (green/yellow/red) |
| **Route probing** | Auto-discovers ALL routes from function map, probes every 30s |
| **Response time trends** | Per-route avg/min/max + trend detection (stable/degrading/improving) |
| **Frozen detection** | Health check failures trigger force-kill and heal cycle |
| **Auto-adaptation** | When you add new routes, the prober discovers and monitors them |

The `📊 Analytics` dashboard panel shows memory/CPU charts, route health status, and response time breakdowns — all updating in real-time.

---

## Auto-Clustering

Wolverine detects your machine and forks the optimal number of workers:

```bash
wolverine server/index.js           # auto-detect: 20 cores → 10 workers
wolverine server/index.js --single  # force single worker (dev mode)
wolverine server/index.js --workers 4  # force 4 workers
wolverine --info                    # show system capabilities
```

**System detection:**
- CPU cores, model, speed
- Total/free RAM, disk space
- Platform (Linux, macOS, Windows)
- Container environment (Docker, Kubernetes)
- Cloud provider (AWS, GCP, Azure, Railway, Fly, Render, Heroku)

**Scaling rules:**

| Cores | Workers |
|-------|---------|
| 1 | 1 (no clustering) |
| 2 | 2 |
| 3-4 | cores - 1 |
| 5-8 | cores - 1, cap 6 |
| 9+ | cores / 2, cap 16 |

Workers auto-respawn on crash with exponential backoff (1s → 30s). Max 5 restarts per worker.

---

## Configuration

```
.env.local                     ← Secrets only (API keys, admin key)
server/config/settings.json    ← Everything else (models, port, clustering, telemetry, limits)
```

`settings.json` is inside `server/` so the agent can read and edit it. Config loader priority: **env vars > settings.json > defaults**.

---

## Platform Telemetry

Every wolverine instance automatically broadcasts health data to the analytics platform. **Zero config** — telemetry is on by default.

```
Startup:
  📡 Registering with https://api.wolverinenode.xyz...
  📡 Registered: wlv_a8f3e9b1c4d7
  📡 https://api.wolverinenode.xyz (60s)
```

**How it works:**
- Auto-registers on first run, retries every 60s until platform responds
- Saves key to `.wolverine/platform-key` (survives restarts)
- Sends one ~2KB JSON POST every 60 seconds (5s timeout, non-blocking)
- Payload matches [PLATFORM.md](PLATFORM.md) spec: `instanceId`, `server`, `process`, `routes`, `repairs`, `usage` (tokens/cost/calls + `byCategory` + `byModel` + `byTool`), `brain`, `backups`
- Platform analytics aggregates across all servers: total tokens/cost, breakdown by category (heal/chat/develop/security/classify/research/brain), by model, by tool
- Secrets redacted before sending
- Offline-resilient: queues up to 1440 heartbeats locally, drains on reconnect

**Lightweight:** 4 files, ~250 lines. No external dependencies. Key/version cached in memory. Response bodies drained immediately. No blocking, no delays.

**Override:** `WOLVERINE_PLATFORM_URL=https://your-own-platform.com`
**Opt out:** `WOLVERINE_TELEMETRY=false`

See [PLATFORM.md](PLATFORM.md) for the backend spec and [TELEMETRY.md](TELEMETRY.md) for the protocol.

---

## Demos

All demos use the `server/` directory pattern. Each demo:
1. Backs up your current `server/`
2. Copies a buggy Express server into `server/`
3. Runs wolverine — you watch it fix the bug in real-time
4. Restores your original `server/` on Ctrl+C

| Demo | Bug | What it tests |
|------|-----|--------------|
| `01-basic-typo` | `userz` → `users` | Fast path, error parser, backup |
| `02-multi-file` | Import name mismatch across files | Agent multi-file understanding |
| `03-syntax-error` | Extra closing paren | Syntax check in verifier |
| `04-secret-leak` | Env var in error output | Secret redaction before AI |
| `05-expired-key` | External service 503 | Human notification system |
| `06-json-config` | Typo in JSON key | Agent edits non-JS files |
| `07-null-crash` | `null.toString()` | Fast path basic repair |

---

## Backup System

Full `server/` directory snapshots with lifecycle management:

- Created before every repair attempt and every smart edit (with reason string)
- Created on graceful shutdown (`createShutdownBackup()`)
- Includes all files: `.js`, `.json`, `.sql`, `.db`, `.yaml`, configs
- **Status lifecycle**: UNSTABLE → VERIFIED (fix passed) → STABLE (30min+ uptime)
- **Retention**: unstable/verified pruned after 7 days, stable keeps 1/day after 7 days
- Atomic writes prevent corruption on kill

**Rollback & Recovery:**

| Action | What it does |
|--------|-------------|
| **Rollback** | Restore any backup — creates a pre-rollback safety backup first, restarts server |
| **Undo Rollback** | Restore the pre-rollback state if the rollback made things worse |
| **Hot-load** | Load any backup as the current server state from the dashboard |
| **Rollback Log** | Full audit trail: timestamp, action, target backup, success/failure |

**Dashboard endpoints** (admin auth required):
- `POST /api/backups/:id/rollback` — rollback to specific backup
- `POST /api/backups/:id/hotload` — hot-load backup as current state
- `POST /api/backups/undo` — undo the last rollback

---

## Skills

Auto-discovered from `src/skills/`. Each skill exports metadata for the registry:

### SQL Skill (`src/skills/sql.js`)
- **sqlGuard()** — Express middleware blocking SQL injection (UNION, stacked queries, tautologies, timing attacks, etc.)
- **SafeDB** — Parameterized-only database wrapper (blocks string concatenation in queries)
- Auto-injected into agent prompts when building database features

Add new skills by creating a file in `src/skills/` with `SKILL_NAME`, `SKILL_DESCRIPTION`, `SKILL_KEYWORDS`, `SKILL_USAGE` exports.

---

## MCP Integration

Connect external tools via [Model Context Protocol](https://modelcontextprotocol.io):

```json
// .wolverine/mcp.json
{
  "servers": {
    "datadog": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@datadog/mcp-server"],
      "allowedTools": ["get_metrics", "list_monitors"],
      "enabled": true
    }
  }
}
```

Tools appear as `mcp__datadog__get_metrics` in the agent. All MCP data passes through the security stack (redaction, injection scan, rate limiting).

---

## Usage Tracking

Every API call tracked with input/output tokens + USD cost:

- **By Category**: heal, develop, chat, security, classify, research, brain
- **By Model**: which model costs the most
- **By Tool**: call_endpoint, search_brain, etc.
- **Timeline chart**: color-coded SVG bar chart
- **Persisted**: `.wolverine/usage-history.jsonl` survives restarts
- **Custom pricing**: override in `.wolverine/pricing.json`

---

## Notifications

Errors the AI can't fix trigger human alerts:

| Category | Examples |
|----------|---------|
| **auth** | 401 Unauthorized, expired API key, invalid credentials |
| **billing** | 429 rate limit, quota exceeded, credits depleted |
| **service** | ECONNREFUSED, ENOTFOUND, ETIMEDOUT, 503 |
| **cert** | SSL/TLS errors, self-signed certificate |
| **permission** | EACCES, EPERM |
| **disk** | ENOSPC, ENOMEM |

AI summary generated with CHAT_MODEL, secrets redacted, optional webhook delivery.

---

## License

MIT
