# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Wolverine is a self-healing Node.js server framework. It wraps a server process, catches crashes AND caught 500 errors, diagnoses them with AI (OpenAI or Anthropic), generates fixes, verifies them, and restarts — automatically. Published as `wolverine-ai` on npm (v6.0.0). 32 agent tools, 7 skills, ~50 injection patterns, adaptive rate limiter, encrypted vault, x402 paid APIs.

## Commands

```bash
npm start                        # Run server/index.js under wolverine (self-healing)
npm run server                   # Run server/index.js directly (no healing)
npm run test:pentest             # Security scan for secret leakage
npm run demo:list                # List demo scenarios
npm run demo -- 01               # Run specific demo
npx wolverine server/index.js    # CLI entry point
wolverine --info                 # System detection
wolverine --init                 # Scan server/ and build context map
wolverine --update               # Safe framework upgrade
wolverine --backup "reason"      # Create server snapshot
wolverine --list-backups         # Show all snapshots
wolverine --rollback <id>        # Restore specific backup
wolverine --rollback-latest      # Restore most recent
```

No standard test runner — demos in `tests/fixtures/` serve as integration tests.

## Architecture

### Heal Pipeline (src/core/wolverine.js)

```
Error detected (crash OR caught 500 via IPC)
  → Empty stderr? → Just restart, no AI ($0.00)
  → Parse error → classify type → redact secrets
  → Injection scan (skip if < 20 chars)
  → Loop guard: same error failed 3+ times in 10min? → File bug report, stop
  → Rate limit: 5 heals per 5min max
  → Operational fix (zero tokens):
      missing_module → deps.diagnose() → npm install
      EADDRINUSE → kill stale process
      ENOENT → create missing file (JSON configs: infers expected fields from source code)
      EACCES → chmod
  → Token budget by complexity: simple=20K, moderate=50K, complex=100K
  → Goal Loop (3 iterations):
      1. Fast path: CODING_MODEL, JSON with code+commands, backup diff context
      2. Agent: dynamic prompt (400 tokens simple, 1200 complex), 31 tools, 90s/call timeout
         Turn budget: simple=4, config/ENOENT=5, complex=8
      3. Sub-agents: explore→plan→fix (Haiku triage, Sonnet/Opus fix only)
  → Verify: syntax → boot probe (route probe skipped — ErrorMonitor is safety net)
  → Success: retryCount reset, record to brain with full context
  → Fail: rollback, brain records "DO NOT REPEAT", next iteration
```

`heal()` wraps `_healImpl()` with 5-minute `Promise.race` timeout.

### IPC Error Chain (caught 500s without crash)

1. **error-hook.js** — preloaded via `--require`, patches Fastify/Express for IPC. WeakSet dedup. Auto-registers default error handler if user never calls setErrorHandler (catches async route throws).
2. **runner.js** — spawns child with `stdio: ["inherit","inherit","pipe","ipc"]`, listens `child.on("message")`
3. **error-monitor.js** — tracks errors per normalized route (`/api/users/123` → `/api/users/:id`), threshold=1, 60s cooldown. Health check failures also trigger heal.

### AI Client (src/core/ai-client.js)

Dual provider: OpenAI + Anthropic. Auto-detected from model name (`claude-*` → Anthropic). All responses normalized to `{content, toolCalls, usage}`. **Anthropic prompt caching** — system prompt marked `cache_control: ephemeral`, 90% cheaper on repeat calls. Per-model output limits with 10% buffer. Every call tracked: latencyMs, success/failure, tokens, cost.

Embeddings always use OpenAI (Anthropic has no embedding API).

### Agent (src/agent/agent-engine.js)

**Dynamic system prompt**: simple errors (TypeError/ReferenceError) get 400-token compact prompt with 7 tools. Complex errors get full prompt with all 18 tools + strategy table.

18 tools: file (read/write/edit/glob/grep/list_dir/move_file), shell (bash_exec/git_log/git_diff), database (inspect_db/run_db_fix), diagnostics (check_port/check_env), deps (audit_deps/check_migration), research (web_fetch), control (done).

**Cost optimizations**: zero-cost structural compaction (no LLM, extracts signals from messages), tool result truncation (4K cap), token estimation (`text.length/4`), pre/post tool hooks (`.wolverine/hooks.json`), error-graceful tools (`[ERROR]` results not thrown).

**Protected paths**: agent cannot modify `src/`, `bin/`, `tests/`, `node_modules/`, `.env`, `package.json`. Only `server/` is editable.

### Config (server/config/settings.json)

```json
{ "models": { "reasoning": "wolverine-test-1", "coding": "claude-sonnet-4-6", ... }, "embedding": "wolverine-embedding-1" }
```

No provider selection — always hybrid. Users pick any model per task. Provider auto-detected from name. Embedding separate — always billed through wolverine credits. Legacy `provider`/`*_settings` configs auto-migrated. Env vars override per-role.

### Brain (src/brain/vector-store.js + brain.js)

IVF-indexed vector store: k-means++ clustering, BM25 keyword search, binary persistence. 60 seed docs. Benchmarks: 100=0.2ms, 10K=4.4ms, 50K=23.7ms.

**Namespace isolation**: error heals search only `errors/fixes/learnings/functions` — seed docs (20K tokens) excluded unless query is about wolverine itself. Function map hash check skips re-embedding if unchanged.

### Backup (src/backup/backup-manager.js)

All backups in `~/.wolverine-safe-backups/` (outside project, survives git pull/npm install). States: UNSTABLE → VERIFIED → STABLE (30min). Protected files never rolled back: `settings.json`, `db.js`, `.env.local`.

### Skills (src/skills/ — 6 files)

- **sql.js** — injection prevention, SafeDB, idempotency guard
- **deps.js** — dependency diagnosis (zero tokens), npm audit, migration paths
- **update.js** — safe framework upgrade, emergency backup, brain seed merge
- **backup.js** — agent-friendly backup/rollback with CLI commands
- **loop-guard.js** — infinite loop detection, bug reports, process dedup (PID file)
- **skill-registry.js** — auto-discovery + token-scored matching

### Telemetry (src/platform/)

Heartbeats every 60s. Stable instance ID (persisted to `.wolverine/instance-id`). Cumulative usage from disk (not session-only). `byModel` with latency/success/tokens-per-sec/cost-per-call. `byProvider` aggregated. Auto-update checks every 5min, selective git checkout (never touches `server/`).

## Key Constraints

- **Server port is always 3000.** Any other port breaks APIs. Kill 3000 and bind there.
- **Dashboard on PORT+1** (3001).
- **heal() has 5-minute timeout.** `Promise.race` recovery.
- **Global rate limit: 5 heals per 5 minutes.**
- **Loop guard: 3 failed heals on same error in 10min → stop + bug report.**
- **Error threshold: 1** — single 500 triggers heal. 60s cooldown per route.
- **Empty stderr → just restart, no AI.** Prevents token burn on signal kills.
- **bash_exec: 30s default, 60s cap.**
- **AI call timeout: 90s default** (configurable via `WOLVERINE_AI_CALL_TIMEOUT_MS`). Self-hosted GPU needs more time.
- **Agent per-API-call timeout: 90s default** (configurable via `WOLVERINE_AI_CALL_TIMEOUT_MS`). Returns partial results if files already modified.
- **Agent turn budget: simple=4, config=5, complex=8.**
- **SIGTERM startup grace: 3s.** Prevents restart scripts from killing newly spawned process.
- **Process dedup via PID file.** Kills old process on startup. Race-safe PID cleanup.
- **Both API keys needed for hybrid mode** — OPENAI_API_KEY for embeddings.
- **Unified billing:** All wolverine provider calls route through billing proxy (`WOLVERINE_INFERENCE_URL`). `WOLVERINE_API_KEY` (billed, priority) vs `WOLVERINE_GPU_KEY` (direct, admin). Inference proxy deducts credits from `api_credits` + syncs to `credit_accounts`. Billing errors (402) stop heal immediately.
- **Vault:** Encrypted key storage in `.wolverine/vault/`. AES-256-GCM. Private keys never as JS strings. Agent cannot access vault files (sandbox-blocked). Injection detector blocks heal on key_leak. Backed up in every snapshot. Rollback-protected.
- **x402 Paid APIs:** Turn any route into a USDC-paid API with one flag: `{ config: { x402: { price: "$0.10" } } }`. Variable pricing: `{ x402: { variable: true, priceField: "dollars" } }`. Plugin: `src/middleware/x402-fastify.js`. Uses x402 v2 protocol: `@x402/core` SDK with `@coinbase/x402` facilitator for CDP auth. Network: `"eip155:8453"` (CAIP-2). Requires: Node 22+, `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` in `.env.local`. Packages auto-installed on startup when vault exists. Verify + settle both in preHandler — handler only runs after USDC moves on-chain. Vault wallet auto-detected as payTo. CLI: `wolverine --x402-info`.
- **Auto-update: selective git checkout** — only updates `src/`, `bin/`, `package.json`. Never touches `server/`.
- **Rollback protects:** `settings.json`, `db.js`, `.env.local` never overwritten.

## WARNING: Never `git pull` or `npm install` on Deployed Servers

**NEVER run `git pull` or raw `npm install wolverine-ai` on a running server.** These overwrite `server/` which contains user code, routes, database config, and settings. Use the built-in update system instead:

- `wolverine --update` — safe CLI update (backs up server/, only updates src/bin/)
- Auto-update runs hourly by default (same safe path)
- If you must update manually: `wolverine --backup "before update"` first

The startup backup system snapshots `server/` before first spawn. If the server crashes immediately after a bad update, wolverine auto-rollbacks to the startup snapshot after max retries.

## Configuration

- **Secrets:** `.env.local` (OPENAI_API_KEY, ANTHROPIC_API_KEY, WOLVERINE_ADMIN_KEY)
- **Settings:** `server/config/settings.json` — provider, 3 model presets, cluster, telemetry, rate limits, health checks, autoUpdate, errorMonitor
- **8 task model slots + embedding:** No provider selection — always hybrid. Users pick any model per task in `settings.json` `models` section. Provider auto-detected from model name. Embedding is separate (`embedding` key) — always `wolverine-embedding-1` (proxies text-embedding-3-small at 2x markup through credits).
- **9 analytics categories by ACTIVITY:** audit (injection scan), classifier (error classification), coding (fast path, no tools), tool (agent + sub-agents WITH tools), research (deep investigation), chat (summaries), compacting (brain compression), embedding (brain vectors), reasoning (AI analysis). Category = what AI is DOING, not which model slot.
- **Config priority:** env vars > `{provider}_settings` > defaults

## Files That Matter Most

| File | Why |
|------|-----|
| `src/core/wolverine.js` | Heal pipeline, operational fixes, goal loop, token budgets |
| `src/core/runner.js` | Process manager, IPC, health/error monitors, loop guard, auto-update |
| `src/core/ai-client.js` | Dual provider, prompt caching, output limits, latency tracking |
| `src/agent/agent-engine.js` | Dynamic prompt, 18 tools, zero-cost compaction, hooks |
| `src/agent/sub-agents.js` | Dynamic token budgets, Haiku triage, restricted tool sets |
| `src/core/verifier.js` | Syntax + boot probe, error classification comparison |
| `src/brain/vector-store.js` | IVF + BM25 + binary persistence |
| `src/brain/brain.js` | 60 seed docs, namespace isolation, function map hash |
| `src/skills/loop-guard.js` | Infinite loop detection, bug reports, process dedup |
| `src/skills/update.js` | Safe upgrade, emergency backup, brain seed merge |
| `src/platform/auto-update.js` | Version lock, dep verification, max 1 attempt per boot |
| `server/config/settings.json` | Provider selection, 3 model presets, all config |
