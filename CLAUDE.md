# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Wolverine is a self-healing Node.js server framework. It wraps a server process, catches crashes AND caught 500 errors, diagnoses them with AI (OpenAI or Anthropic), generates fixes, verifies them, and restarts — automatically. Published as `wolverine-ai` on npm (v2.1.1).

## Commands

```bash
npm start                      # Run server/index.js under wolverine (self-healing)
npm run server                 # Run server/index.js directly (no healing)
npm run test:pentest           # Security scan for secret leakage
npm run demo:list              # List demo scenarios
npm run demo -- 01             # Run specific demo (backs up server/, runs buggy code, restores on exit)
npx wolverine server/index.js  # CLI entry point
wolverine --info               # Show system detection (cores, RAM, platform)
```

No standard test runner — demos in `tests/fixtures/` serve as integration tests. Run `node tests/run-all.js` for sequential execution.

## Architecture

### The Heal Pipeline (src/core/wolverine.js)

```
Error detected (crash OR caught 500 via IPC)
  → Parse error (file, line, message, errorType classification)
  → Redact secrets → Injection scan (skip if stderr < 20 chars)
  → Rate limit check (per-signature + global: max 5 heals per 5min)
  → Operational fix (zero AI tokens):
      missing_module → deps.diagnose() → npm install
      EADDRINUSE → find and kill stale process
      ENOENT → create missing file
      EACCES → chmod
  → If operational fix didn't apply:
      Goal Loop (3 iterations, escalating):
        1. Fast path: CODING_MODEL, JSON with code changes + shell commands
           (includes backup source code for revert-vs-patch decisions)
        2. Agent: REASONING_MODEL, 18 tools, multi-turn investigation
        3. Sub-agents: explore → plan → fix (specialized agents)
  → Verify: syntax check → boot probe → route probe (if route known)
  → Success: retryCount reset, record to repair history + brain
  → Fail: rollback, next iteration or give up
```

`heal()` wraps `_healImpl()` with a 5-minute `Promise.race` timeout. File path is optional — when no file identified, skips fast path and goes straight to agent.

### IPC Error Chain (caught 500s without crash)

1. **error-hook.js** — preloaded via `--require`, patches `require("fastify")` and `require("express")` to add IPC error reporting. Uses `WeakSet` dedup.
2. **runner.js** — spawns child with `stdio: ["inherit","inherit","pipe","ipc"]`, listens on `child.on("message")`
3. **error-monitor.js** — tracks errors per normalized route (`/api/users/123` → `/api/users/:id`), triggers heal after threshold (default: 1). Health check failures also trigger heal (not just restart).

### Dual Provider AI Client (src/core/ai-client.js)

Supports OpenAI and Anthropic through a unified interface. Provider auto-detected from model name (`claude-*` → Anthropic, everything else → OpenAI). All responses normalized to `{content, toolCalls, usage}` regardless of provider. Tool definitions auto-converted between formats.

Every call tracked with: latencyMs, success/failure, input/output tokens, cost. Failed API calls are logged per-model for reliability tracking.

Embeddings always use OpenAI (Anthropic has no embedding API).

### Agent Tool Harness (src/agent/agent-engine.js)

18 tools: file (read/write/edit/glob/grep/list_dir/move_file), shell (bash_exec/git_log/git_diff), database (inspect_db/run_db_fix), diagnostics (check_port/check_env), deps (audit_deps/check_migration), research (web_fetch), control (done).

**Protected paths** — agent CANNOT modify: `src/`, `bin/`, `tests/`, `node_modules/`, `.env`, `package.json`. Only `server/` is editable.

Sub-agents get restricted tool sets. Explorer gets diagnostic tools, fixer gets bash_exec + move_file + run_db_fix, planner gets audit_deps + check_migration.

### Provider Configuration (server/config/settings.json)

Three named presets, selected by `"provider"` field:

```json
{
  "provider": "hybrid",              // "openai" | "anthropic" | "hybrid"
  "openai_settings": { ... },        // all OpenAI models
  "anthropic_settings": { ... },     // all Anthropic models
  "hybrid_settings": { ... }         // mix: Anthropic for heavy, OpenAI for cheap
}
```

Config loader (`src/core/config.js`) reads `{provider}_settings` as the model source. Env vars override per-role. `WOLVERINE_PROVIDER` env var overrides the settings.json value.

### Backup Lifecycle (src/backup/backup-manager.js)

Full `server/` snapshots. States: UNSTABLE → VERIFIED → STABLE (30min uptime). Every fix attempt creates a backup with a reason string. Rollback creates a pre-rollback safety backup. Dashboard endpoints: rollback, undo, hot-load.

### Skills (src/skills/)

- **sql.js** — `sqlGuard()` injection prevention, `SafeDB` cluster-safe database, `idempotencyGuard()` + `db.idempotent()` for double-fire protection
- **deps.js** — `diagnose()` for dependency errors (zero tokens), `healthReport()` for full audit, `getMigration()` for known upgrade paths (express→fastify, moment→dayjs, etc.)

### Telemetry (src/platform/)

Heartbeats every 60s to `api.wolverinenode.xyz`. Payload includes `usage.byModel` (with latency, success rate, tokens/sec, cost/call per model), `usage.byProvider` (aggregated by openai/anthropic), `usage.byCategory`, repairs, routes, brain stats. All secrets redacted before sending.

## Key Constraints

- **Server port is always 3000.** Any other port breaks login and APIs. Kill anything on 3000 and bind there.
- **Dashboard runs on PORT+1** (3001).
- **heal() has a 5-minute timeout.** System recovers via `Promise.race`.
- **Global rate limit: 5 heals per 5 minutes** regardless of error signature.
- **Error threshold: 1** — a single caught 500 triggers heal immediately. 60s cooldown per route.
- **bash_exec timeout: 30s default, 60s hard cap.**
- **Process tree kill** — `_killProcessTree()` kills child + all descendants on restart (handles cluster workers).
- **Verifier uses error classification, not string matching.** Compares error type + class.
- **Backup before every fix attempt** with reason string.
- **Both API keys needed for hybrid/anthropic mode** — OPENAI_API_KEY for embeddings, ANTHROPIC_API_KEY for everything else.

## Configuration

- **Secrets:** `.env.local` (OPENAI_API_KEY, ANTHROPIC_API_KEY, WOLVERINE_ADMIN_KEY)
- **Settings:** `server/config/settings.json` — provider, model presets, cluster, telemetry, rate limits, health checks
- **10 model slots:** reasoning, coding, chat, tool, classifier, audit, compacting, research, embedding
- **Config priority:** env vars > `{provider}_settings` in settings.json > defaults

## Files That Matter Most

| File | Why |
|------|-----|
| `src/core/wolverine.js` | Heal pipeline + operational fixes + goal loop orchestration |
| `src/core/runner.js` | Process manager, IPC listener, health/error monitor, process tree kill |
| `src/core/ai-client.js` | Dual provider (OpenAI + Anthropic), response normalization, latency tracking |
| `src/agent/agent-engine.js` | Agent system prompt, 18 tool definitions + implementations |
| `src/core/verifier.js` | Fix verification: syntax + boot probe + route probe |
| `src/core/config.js` | Provider resolution: reads `{provider}_settings` from settings.json |
| `src/core/error-hook.js` | Auto-injected into child, patches Fastify/Express for IPC |
| `src/security/secret-redactor.js` | Singleton redactor used everywhere |
| `src/logger/token-tracker.js` | Per-model KPIs: latency, success rate, tokens/sec, cost/call |
| `src/skills/sql.js` | SafeDB, idempotency guard, SQL injection prevention |
| `src/skills/deps.js` | Dependency diagnosis, health report, migration knowledge |
| `src/brain/brain.js` | 55+ seed docs, vector store, semantic search, function map |
| `server/config/settings.json` | Provider selection + 3 named model presets |
