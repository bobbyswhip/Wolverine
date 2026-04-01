# Wolverine Node.js

**Self-healing Node.js servers powered by an AI coding harness.**

Wolverine watches your server process, catches crashes, diagnoses errors with AI, generates fixes, verifies them, and restarts — automatically. It also has a dashboard with a command interface where you can tell the agent to build features, and it will modify your server code directly.

Built on patterns from [claw-code](https://github.com/instructkr/claw-code) — the open-source Claude Code harness.

---

## Quick Start

```bash
git clone https://github.com/bobbyswhip/Wolverine.git
cd Wolverine
npm install
cp .env.example .env.local
# Edit .env.local — add your OPENAI_API_KEY and generate an ADMIN_KEY
npm start
```

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
│   └── routes/              ← Route modules
├── src/
│   ├── core/                ← Wolverine engine
│   │   ├── wolverine.js     ← Heal pipeline + goal loop
│   │   ├── runner.js        ← Process manager (PM2-like)
│   │   ├── ai-client.js     ← OpenAI client (Chat + Responses API)
│   │   ├── models.js        ← 10-model configuration system
│   │   ├── verifier.js      ← Fix verification (syntax + boot probe)
│   │   ├── error-parser.js  ← Stack trace parsing
│   │   ├── patcher.js       ← File patching with sandbox
│   │   └── health-monitor.js← PM2-style health checks
│   ├── agent/               ← AI agent system
│   │   ├── agent-engine.js  ← Multi-turn agent with 10 tools
│   │   ├── goal-loop.js     ← Goal-driven repair loop
│   │   └── research-agent.js← Deep research + learning from failures
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
│   ├── monitor/             ← Performance
│   │   └── perf-monitor.js  ← Endpoint response times + spam detection
│   ├── dashboard/           ← Web UI
│   │   └── server.js        ← Real-time dashboard + command interface
│   ├── notifications/       ← Alerts
│   │   └── notifier.js      ← Human-required error detection
│   ├── mcp/                 ← External tools
│   │   ├── mcp-client.js    ← MCP protocol client (stdio + HTTP)
│   │   ├── mcp-registry.js  ← Server discovery + tool registration
│   │   └── mcp-security.js  ← Allowlists + injection scan on MCP results
│   └── skills/              ← Reusable capabilities
│       ├── skill-registry.js← Auto-discovery + prompt injection
│       └── sql.js           ← SQL injection prevention + safe DB interface
├── bin/wolverine.js         ← CLI entry point
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
  → Error parsed (file, line, message)
  → Secrets redacted from error output
  → Prompt injection scan (AUDIT_MODEL)
  → Human-required check (expired keys, service down → notify, don't waste tokens)
  → Rate limit check (error loop → exponential backoff)

Goal Loop (iterate until fixed or exhausted):
  Iteration 1: Fast path (CODING_MODEL, single file)
    → Apply patch → Verify (syntax check + boot probe) → Pass? Done.
  Iteration 2: Agent path (REASONING_MODEL, multi-file + tools)
    → 10-tool agent explores codebase → Fix → Verify → Pass? Done.
  Iteration 3: Deep research (RESEARCH_MODEL) → Agent retry with findings
    → Each failure feeds into the next attempt's context

After fix:
  → Record to repair history (error, resolution, tokens, cost)
  → Store in brain for future reference
  → Promote backup to stable after 30min uptime
```

---

## Agent Tool Harness

The AI agent has 10 built-in tools (ported from [claw-code](https://github.com/instructkr/claw-code)):

| Tool | Source | Description |
|------|--------|-------------|
| `read_file` | FileReadTool | Read any file with optional offset/limit for large files |
| `write_file` | FileWriteTool | Write complete file content, creates parent dirs |
| `edit_file` | FileEditTool | Surgical find-and-replace without rewriting entire file |
| `glob_files` | GlobTool | Pattern-based file discovery (`**/*.js`, `src/**/*.json`) |
| `grep_code` | GrepTool | Regex search across codebase with context lines |
| `bash_exec` | BashTool | Sandboxed shell execution with blocked dangerous commands |
| `git_log` | gitOperationTracking | View recent commit history |
| `git_diff` | gitOperationTracking | View uncommitted changes |
| `web_fetch` | WebFetchTool | Fetch URL content for documentation/research |
| `done` | — | Signal task completion with summary |

**Blocked commands** (from claw-code's `destructiveCommandWarning`):
`rm -rf /`, `git push --force`, `git reset --hard`, `npm publish`, `curl | bash`, `eval()`

**Protected paths** — the agent can NEVER modify:
`src/`, `bin/`, `tests/`, `node_modules/`, `.env`, `package.json`

Only files in `server/` are editable.

---

## Dashboard

Real-time web UI at `http://localhost:PORT+1`:

| Panel | What it shows |
|-------|--------------|
| **Overview** | Heals, errors, rollbacks, memories, uptime + recent events |
| **Events** | Live SSE event stream with color-coded severity |
| **Performance** | Endpoint response times, request rates, error rates |
| **Command** | Admin chat interface — ask questions or build features |
| **Backups** | Full server/ snapshot history with status badges |
| **Brain** | Vector store stats, namespace counts, function map |
| **Repairs** | Error/resolution audit trail with tokens and cost |
| **Tools** | Agent tool harness listing |
| **Usage** | Token analytics: by model, category, tool + USD cost breakdown |

### Command Interface

Three routes (AI-classified per command):

| Route | Model | Tools | When |
|-------|-------|-------|------|
| **SIMPLE** | CHAT_MODEL | None | Knowledge questions, explanations |
| **TOOLS** | TOOL_MODEL | call_endpoint, read_file, search_brain | Live data, file contents |
| **AGENT** | CODING_MODEL | Full 10-tool harness | Build features, fix code |

Secured with `WOLVERINE_ADMIN_KEY` + localhost-only IP check.

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
| **Admin Auth** | Dashboard command interface requires key + localhost IP, timing-safe comparison, lockout after 10 failures |
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

Full `server/` directory snapshots:

- Created before every repair attempt and every smart edit
- Includes all files: `.js`, `.json`, `.sql`, `.db`, `.yaml`, configs
- **Status lifecycle**: UNSTABLE → VERIFIED (fix passed) → STABLE (30min+ uptime)
- **Retention**: unstable pruned after 7 days, stable keeps 1/day after 7 days
- Atomic writes prevent corruption on kill

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
