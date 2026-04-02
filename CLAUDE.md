# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Wolverine is a self-healing Node.js server framework. It wraps a server process, catches crashes AND caught 500 errors, diagnoses them with AI, generates fixes, verifies them, and restarts — automatically. Published as `wolverine-ai` on npm.

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

This is the core loop. Understanding it is key to working on this project:

```
Error detected (crash OR caught 500 via IPC)
  → Parse error (file, line, message, errorType classification)
  → Redact secrets → Injection scan → Rate limit check
  → Operational fix attempt (zero AI tokens):
      missing_module → npm install
      EADDRINUSE → kill stale process
      ENOENT → create missing file
      EACCES → chmod
  → If operational fix didn't apply:
      Goal Loop (3 iterations, escalating):
        1. Fast path: CODING_MODEL, returns JSON with code changes + shell commands
        2. Agent: REASONING_MODEL, 16 tools, multi-turn investigation
        3. Sub-agents: explore → plan → fix (3 specialized agents)
  → Verify: syntax check → boot probe → route probe (if route known)
  → Success: record to repair history + brain, promote backup
  → Fail: rollback, next iteration or give up
```

The `heal()` function wraps `_healImpl()` with a 5-minute `Promise.race` timeout.

### IPC Error Chain (caught 500s without crash)

Three components must work together:

1. **error-hook.js** — preloaded via `--require`, patches `require("fastify")` and `require("express")` at module load time to add IPC error reporting
2. **runner.js** — spawns child with `stdio: ["inherit","inherit","pipe","ipc"]`, listens on `child.on("message")`
3. **error-monitor.js** — counts consecutive 500s per normalized route, triggers heal after threshold (default: 3 in 30s)

Routes are normalized: `/api/users/123` → `/api/users/:id` so distributed errors aggregate.

### Agent Tool Harness (src/agent/agent-engine.js)

16 tools in categories: file (read/write/edit/glob/grep/list_dir/move_file), shell (bash_exec/git_log/git_diff), database (inspect_db/run_db_fix), diagnostics (check_port/check_env), research (web_fetch), control (done).

**Protected paths** — agent CANNOT modify: `src/`, `bin/`, `tests/`, `node_modules/`, `.env`, `package.json`. Only `server/` is editable. Guard is in `_isProtectedPath()`.

Sub-agents get restricted tool sets (e.g., explorer has no write tools, fixer has no web_fetch).

### Backup Lifecycle (src/backup/backup-manager.js)

Full `server/` snapshots. States: UNSTABLE → VERIFIED (fix passed) → STABLE (30min uptime). Retention: 7 days for unstable/verified, 1/day for old stable. Backups store reason strings and support rollback with pre-rollback safety backup + undo.

### Secret Redactor (src/security/secret-redactor.js)

Singleton initialized once via `initRedactor(projectRoot)`. Reads `.env.local`, maps values to key names. Every outbound path auto-redacts: AI calls, logs, brain, dashboard, telemetry. Use `redact(text)` and `redactObj(obj)` from `require("../security/secret-redactor")`.

## Key Constraints

- **Server port is always 3000.** Any other port breaks login and APIs. If 3000 is taken, kill it and start on 3000.
- **Dashboard runs on PORT+1** (3001 by default).
- **File path is optional for healing.** Database errors, config errors, port conflicts may not trace to a file — the pipeline skips fast path and goes straight to agent investigation.
- **heal() has a 5-minute timeout.** If AI hangs, system recovers via `Promise.race`.
- **Global rate limit: 5 heals per 5 minutes** regardless of error signature. Prevents infinite heal loops.
- **bash_exec timeout: 30s default, 60s hard cap.**
- **Verifier compares error classification, not strings.** Same TypeError class + same file = "same error". Different class = "new error".
- **Backup before every fix attempt.** The fast path also creates a backup with a reason string before patching.

## Configuration

- **Secrets:** `.env.local` (OPENAI_API_KEY, WOLVERINE_ADMIN_KEY)
- **Settings:** `server/config/settings.json` (models, cluster, telemetry, rate limits, health checks)
- **10 model slots:** reasoning, coding, chat, tool, classifier, audit, compacting, research, embedding — each independently configurable
- **Config priority:** env vars > settings.json > defaults

## Files That Matter Most

| File | Why |
|------|-----|
| `src/core/wolverine.js` | Heal pipeline + operational fixes + goal loop orchestration |
| `src/core/runner.js` | Process manager, IPC listener, health/error monitor wiring |
| `src/agent/agent-engine.js` | Agent system prompt, 16 tool definitions + implementations |
| `src/core/verifier.js` | Fix verification: syntax + boot probe + route probe |
| `src/core/error-hook.js` | Auto-injected into child, patches Fastify/Express for IPC |
| `src/security/secret-redactor.js` | Singleton redactor used everywhere |
| `src/core/ai-client.js` | OpenAI client, dual API support (Chat + Responses), fast path prompt |
| `src/brain/brain.js` | 50+ seed docs, vector store, semantic search, function map |
| `server/index.js` | The default server — has IPC error handler for process.send() |
