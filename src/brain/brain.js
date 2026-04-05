const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const { VectorStore } = require("./vector-store");
const { embed, embedBatch, compactAndEmbed } = require("./embedder");
const { scanProject, mapToChunks } = require("./function-map");

/**
 * The Wolverine Brain — semantic memory + project context.
 *
 * On startup:
 * 1. Load persisted vector store from .wolverine/brain/
 * 2. Scan the project to build a live function map
 * 3. Seed wolverine documentation (only on first init)
 * 4. Embed function map chunks into the "functions" namespace
 *
 * During operation:
 * - remember(): Compact + embed + store a new memory
 * - recall(): Semantic search for relevant context
 * - getContext(): Build a context string for the AI agent
 *
 * Namespaces:
 * - "docs"      — wolverine documentation, how self-healing works
 * - "functions"  — live function map (routes, exports, classes)
 * - "errors"     — past errors and their contexts
 * - "fixes"      — successful fixes and their explanations
 * - "learnings"  — patterns learned from fix successes/failures
 */

// Seed documents — wolverine's knowledge about itself
const SEED_DOCS = [
  {
    text: "Wolverine Node.js is an autonomous self-healing server agent. It monitors a Node.js process, catches crashes, analyzes errors using AI, generates code fixes, verifies them, and restarts the server. It operates as a process manager similar to PM2 but with AI-powered repair capabilities.",
    metadata: { topic: "overview" },
  },
  {
    text: "Wolverine heal pipeline: crash detected → error parsed (file, line, message, errorType) → prompt injection scan (AUDIT_MODEL) → rate limit check (per-signature + global 5/5min cap) → operational fix attempt (missing_module → npm install, missing_file → create file with inferred config, permission → chmod, port conflict → kill stale process — zero AI tokens) → if operational fix doesn't apply → fast path repair (CODING_MODEL, supports both code changes AND shell commands like npm install) → if fast path fails → agent path (REASONING_MODEL with tools including bash_exec, 45s per-API-call timeout) → if agent fails → sub-agents (explore → plan → fix, fixer has bash_exec) → verify fix (syntax check + boot probe + error classification comparison) → rollback on failure. Error types classified: missing_module, missing_file, permission, port_conflict, syntax, runtime, unknown. Heal timeout: 5 minutes via Promise.race. Config-aware turn budget: simple=4, config/ENOENT=5, complex=8 turns.",
    metadata: { topic: "heal-pipeline" },
  },
  {
    text: "Wolverine backup system: ALL backups stored in ~/.wolverine-safe-backups/ (OUTSIDE project, survives git pull/npm install/rm -rf). Structure: snapshots/ (heal backups per fix attempt), updates/ (pre-update snapshots), manifest.json (backup registry). Old .wolverine/backups/ auto-migrated on first run. Full server/ directory snapshots with lifecycle management. Every fix creates a backup with a reason string before patching. Status lifecycle: UNSTABLE (just created) → VERIFIED (fix passed boot probe) → STABLE (server ran 30min+ without crash). Features: rollbackTo(backupId) creates pre-rollback backup then restores files and restarts server. undoRollback() restores pre-rollback state. Hot-load: admin can load any backup as current server state from dashboard. Shutdown backup on graceful exit. Retention: unstable/verified pruned after 7 days. Stable backups older than 7 days keep 1 per day. Rollback log tracks all rollback/undo operations with timestamps and success status. Dashboard endpoints: POST /api/backups/:id/rollback, POST /api/backups/undo, POST /api/backups/:id/hotload (all require admin auth).",
    metadata: { topic: "backup-system" },
  },
  {
    text: "Wolverine security: file sandbox restricts all reads/writes to the project directory. Prompt injection detection runs on every error (regex layer + AI audit via AUDIT_MODEL). Rate limiter prevents error explosion cost with sliding window, min gap, hourly token budget, and exponential backoff for error loops.",
    metadata: { topic: "security" },
  },
  {
    text: "Wolverine supports both OpenAI and Anthropic models. Provider auto-detected from model name: claude-* → Anthropic, gpt-*/o1-*/o3-* → OpenAI. Mix and match per role: e.g., Anthropic for reasoning (claude-sonnet-4), OpenAI for coding (gpt-5.3-codex). 10 model slots: REASONING_MODEL, CODING_MODEL, CHAT_MODEL, TOOL_MODEL, CLASSIFIER_MODEL, AUDIT_MODEL, COMPACTING_MODEL, RESEARCH_MODEL, TEXT_EMBEDDING_MODEL (always OpenAI — Anthropic has no embeddings). Configure in .env.local or settings.json. Tools work identically on both providers — ai-client.js normalizes all responses to same {content, toolCalls, usage} shape. Telemetry tracks usage byModel AND byProvider (openai/anthropic) automatically.",
    metadata: { topic: "model-config" },
  },
  {
    text: "Wolverine performance monitoring: tracks HTTP endpoint response times, detects slow endpoints (>2s avg), identifies spam/DDoS patterns (>100 req/min to one endpoint), flags response time spikes (5x normal), detects high error rates (>20%). Triggers AI analysis for optimization suggestions.",
    metadata: { topic: "perf-monitoring" },
  },
  {
    text: "Wolverine brain: high-performance vector database for long-term memory. 4 search optimizations: (1) Pre-normalized vectors — cosine similarity = dot product (no sqrt), 7x faster. (2) IVF index — k-means++ clustering into √N buckets (10 at 100 entries, 100 at 10K, 224 at 50K), search probes nearest 20% of clusters. (3) BM25 keyword search — inverted index with TF-IDF scoring, O(query_tokens) not O(N). (4) Binary persistence — Float32Array buffers, 10x faster load. Benchmarks: 100=0.2ms, 1K=0.4ms, 5K=2ms, 10K=4.4ms, 50K=23.7ms (was 160ms brute force). Stores: function maps, errors, fixes, learnings, seed docs. New seeds merged on framework update without erasing existing memories.",
    metadata: { topic: "brain" },
  },
  {
    text: "Wolverine health checks: periodically pings the server's /health endpoint. After 3 consecutive failures, force-kills and triggers heal cycle. Configurable interval, timeout, and fail threshold. Prevents undetected hangs and frozen servers.",
    metadata: { topic: "health-checks" },
  },
  {
    text: "Wolverine fix verification: after applying a patch, runs a 2-step validation. Step 1: node --check for syntax errors. Step 2: boot probe — starts the server on an ephemeral port for 10s. If same error recurs: fix didn't work, rollback. If different error: fix broke something else, rollback. If alive: fix works, proceed.",
    metadata: { topic: "verification" },
  },
  {
    text: "Wolverine multi-file agent: turn-limited agent loop with 24 tools across 8 categories. Turn budget adapts to error type: simple (TypeError)=4, config/ENOENT=5, complex=8. Each AI call has 90s timeout via Promise.race. FILE: read_file, write_file, edit_file, glob_files, grep_code, list_dir, move_file. SHELL: bash_exec (30s default, 60s cap), git_log, git_diff. DATABASE: inspect_db (tables/schema/SELECT on SQLite), run_db_fix (UPDATE/DELETE/ALTER with auto-backup). DIAGNOSTICS: check_port, check_env, check_memory (RSS/heap/system with OOM detection), list_processes (find zombie/orphan node processes), check_logs (read recent journalctl/log file), check_network (DNS/port/URL reachability), inspect_env (list env var names without values, check if required vars exist). SERVER: restart_service (request graceful restart after fix). DEPS: audit_deps, check_migration. RESEARCH: web_fetch. CONTROL: done.",
    metadata: { topic: "agent" },
  },
  {
    text: "Wolverine supports dual providers: OpenAI (Chat Completions + Responses API) and Anthropic (Messages API). Provider auto-detected from model name: claude-* → Anthropic, gpt-*/o1-*/codex → OpenAI. All responses normalized to same {content, toolCalls, usage} shape — downstream code doesn't know which provider was used. Tool definitions auto-converted between formats. Every call tracked with latencyMs, success/failure, input/output tokens. Three provider modes in settings.json: openai_settings, anthropic_settings, hybrid_settings (Anthropic for heavy tasks, OpenAI for cheap tasks + embeddings).",
    metadata: { topic: "api-support" },
  },
  {
    text: "Common Node.js errors Wolverine fixes: ReferenceError (undefined variables, typos), TypeError (calling methods on wrong types, null access), SyntaxError (missing brackets, invalid JSON), EADDRINUSE (port already in use), MODULE_NOT_FOUND (missing dependencies), ECONNREFUSED (database/service connection failures), unhandled promise rejections.",
    metadata: { topic: "common-errors" },
  },
  {
    text: "Server uses Fastify (5.6x faster than Express, 114k req/s). server/index.js wires routes with fastify.register(require('./routes/X'), {prefix:'/X'}). Route files: async function routes(fastify) { fastify.get('/', async () => ({...})); } module.exports = routes. server/routes/ has one file per resource. server/config/settings.json for all settings.",
    metadata: { topic: "server-structure" },
  },
  {
    text: "Server best practices: validate all input, use express.json() with size limits. Never expose secrets in responses. Use env vars for config. Add /health endpoint returning status+uptime+memory. Keep routes thin — logic in services. Use async/await never block event loop. Global error handler middleware. Consistent error format: {error:'message'}. One route file per resource. Rate limit public endpoints.",
    metadata: { topic: "server-best-practices" },
  },
  {
    text: "Wolverine editable scope: only files inside server/ can be modified by the agent. src/, bin/, tests/, .env, package.json, node_modules/ are all protected. The agent's _isProtectedPath guard blocks writes to anything outside server/. Direct edits target the script wolverine was launched with (server/index.js by default).",
    metadata: { topic: "editable-scope" },
  },
  {
    text: "SQL Skill: wolverine has a SQL skill at src/skills/sql.js providing: (1) sqlGuard() middleware that blocks SQL injection attacks on all endpoints by scanning query params, body, URL params, and headers for injection patterns like UNION SELECT, stacked queries, tautologies, comment bypass, hex encoding, timing attacks. (2) SafeDB class for parameterized-only database queries — blocks string concatenation in SQL. Usage: const {db,sqlGuard}=require('../src/skills/sql'); app.use(sqlGuard()); db.all('SELECT * FROM users WHERE id=?',[id]);",
    metadata: { topic: "skill-sql" },
  },
  {
    text: "SQL injection patterns wolverine detects: OR/AND tautologies ('1'='1'), UNION SELECT, stacked queries (;DROP TABLE), comment bypass (-- or #), hex encoding (0x), CHAR() encoding, SLEEP/BENCHMARK timing attacks, INFORMATION_SCHEMA probing, LOAD_FILE/INTO OUTFILE data exfiltration. All blocked with 403 and logged as security.sqli_blocked events.",
    metadata: { topic: "skill-sql-patterns" },
  },
  {
    text: "Database best practices: SafeDB uses split connections — separate read connection (concurrent, never waits) and write connection (single writer, FIFO queue). Write queue drains synchronously in one microtask, zero delays. WAL mode means readers never block writers. Each write is microseconds. db.transaction(fn) queues as single atomic unit. No busy_timeout, no blocking, no IPC. Reads: db.get(), db.all() are instant. Writes: db.run(), db.exec() go through queue. Idempotent writes: db.idempotent(key, fn, ttlSeconds) executes fn only once per key — prevents double-charge/double-insert when retries or cluster workers duplicate a request. Idempotency keys stored in _idempotency table (auto-created on connect), shared across all workers via WAL mode.",
    metadata: { topic: "skill-sql-best-practices" },
  },
  {
    text: "Sub-agent system: wolverine can spawn specialized sub-agents for divide-and-conquer. 7 types: explore (read-only, investigates codebase), plan (read-only, proposes fix strategy), fix (read+write, applies targeted fix), verify (read-only, checks if fix works), research (searches brain+web for solutions), security (audits for vulnerabilities), database (handles DB issues with SQL skill). Each type has restricted tools and a specific model.",
    metadata: { topic: "sub-agents" },
  },
  {
    text: "Sub-agent workflow: explore→plan→fix. Explorer finds relevant files, Planner proposes a strategy using exploration results, Fixer executes the plan. Used automatically on goal loop iteration 3+ and dashboard LARGE tier commands. Sub-agents can also run in parallel via spawnParallel() for independent tasks like running security audit + explore simultaneously.",
    metadata: { topic: "sub-agent-workflow" },
  },
  {
    text: "Sub-agent tool restrictions: explore gets read_file/glob/grep/git_log/git_diff/list_dir/check_env/check_port/check_memory/check_network/list_processes/inspect_db/audit_deps. plan gets read_file/glob/grep/list_dir/inspect_db/check_env/inspect_env/audit_deps/check_migration. fix gets read_file/write_file/edit_file/glob/grep/bash_exec/move_file/run_db_fix/audit_deps/restart_service. verify gets read_file/glob/grep/bash_exec/inspect_db/check_port/check_memory/check_logs. research gets read_file/grep/web_fetch/check_logs. security gets read_file/glob/grep/inspect_db/inspect_env. database gets read_file/write_file/edit_file/glob/grep/bash_exec/inspect_db/run_db_fix. 24 tools total, each sub-agent type gets tools relevant to its role.",
    metadata: { topic: "sub-agent-tools" },
  },
  {
    text: "Heal pipeline analytics — categories track ACTIVITY not model slot. Every heal fires: (1) audit: injection scan. (2) classifier: AI classifies error complexity. (3) research: deep research for moderate/complex errors. (4) coding: fast path single-shot repair (no tools). (5) tool: main agent + sub-agents that USE tools (read_file, write_file, bash_exec, etc). (6) chat: post-heal summary. (7) compacting: brain text compression. (8) embedding: brain vectors. (9) reasoning: reserved for deep analysis without tools. Key: agent using tools = 'tool' category regardless of which model slot (reasoning/coding) provided the model. Fast path code gen without tools = 'coding'. Sub-agent explore/verify/fix = 'tool' (they use tools). Sub-agent plan = 'classifier' (no tools, just classifies). Billing: unified credit proxy. 402 stops healing immediately.",
    metadata: { topic: "heal-escalation" },
  },
  {
    text: "Process manager: wolverine monitors memory (RSS/heap) every 10s, detects memory leaks (N consecutive growth samples → auto-restart), enforces memory limit (default 512MB), tracks CPU%, probes all routes every 30s, detects response time degradation trends (stable/degrading/improving). Analytics dashboard shows memory/CPU charts and per-route health.",
    metadata: { topic: "process-manager" },
  },
  {
    text: "Cluster mode: server handles its own clustering (not wolverine-level). WOLVERINE_CLUSTER=true enables it. Server forks N workers (WOLVERINE_RECOMMENDED_WORKERS set by system detection). Workers share port 3000 via reusePort. Wolverine kills entire process tree on restart (_killProcessTree: taskkill /T on Windows, kill -pgid + pgrep -P on Linux). Idempotency protection prevents double-fire: idempotencyGuard() middleware deduplicates write requests across workers using shared SQLite _idempotency table. Client sends X-Idempotency-Key header, or auto-generated from method+path+body hash. All workers see the same table via WAL mode. SafeDB.idempotent(key, fn) for database-level dedup.",
    metadata: { topic: "clustering" },
  },
  {
    text: "System detection: wolverine --info shows CPU cores/model/speed, total/free RAM, disk space, Node version, platform, container environment (Docker, Kubernetes), cloud provider (AWS, GCP, Azure, Railway, Fly, Render, Heroku). Used by ClusterManager to auto-scale worker count. Dashboard API: GET /api/system returns full machine info.",
    metadata: { topic: "system-detection" },
  },
  {
    text: "Configuration: hybrid-always architecture — no provider selection. Users pick the best model for each of 8 task roles directly in settings.json 'models' section. Mix and match: wolverine for audit, claude for reasoning, gpt for coding. Provider auto-detected from model name. Embedding is separate ('embedding' key) — always wolverine-embedding-1 billed through credits (proxies to text-embedding-3-small at 2x markup). Secrets in .env.local. Config priority: env vars > settings.json > defaults.",
    metadata: { topic: "configuration" },
  },
  {
    text: "AI client prompt caching: all 3 providers cache automatically. Anthropic: system prompt marked cache_control:ephemeral, 90% cheaper on repeat calls within 5 min TTL. OpenAI: automatic prefix caching for >=1024 token prefixes, 50% cheaper on cached input, tracked via usage.prompt_tokens_details.cached_tokens. Wolverine/llama.cpp: cache_prompt:true in request body reuses KV cache for identical prefixes between requests, near-zero TTFT on second+ call in a heal pipeline. Cache savings tracked in analytics: cacheCreation (tokens written to cache) and cacheRead (tokens served from cache).",
    metadata: { topic: "prompt-caching" },
  },
  {
    text: "Platform telemetry: lightweight background process, zero-config. Default platform: api.wolverinenode.xyz. Auto-registers on first run (retries every 60s until platform responds), saves key to .wolverine/platform-key. Heartbeat payload matches PLATFORM.md spec: instanceId, server (name/port/uptime/status/pid), process (memoryMB/cpuPercent), routes, repairs, usage (tokens/cost/calls/byCategory), brain, backups. Offline-resilient: queues up to 1440 heartbeats locally, drains on reconnect. No chalk dependency, cached version/key in memory, minimal IO. Opt out: WOLVERINE_TELEMETRY=false. Override URL: WOLVERINE_PLATFORM_URL.",
    metadata: { topic: "platform-telemetry" },
  },
  {
    text: "Telemetry architecture: 4 files, ~250 lines total. heartbeat.js sends one HTTP POST every 60s (5s timeout, non-blocking). register.js auto-registers and caches key in memory + disk. queue.js appends to JSONL file only on failure, trims lazily. telemetry.js collects from subsystems using optional chaining (no crashes if subsystem missing). All secrets redacted before sending. Response bodies drained immediately (res.resume). No blocking, no delays, no busy waits.",
    metadata: { topic: "telemetry-architecture" },
  },
  {
    text: "Server uses Fastify (migrated from Express). 5.6x faster routing: ~114k req/s vs Express ~20k req/s. Routes are async plugin functions: async function routes(fastify) { fastify.get('/', async () => ({...})); } module.exports = routes. Registered in index.js with fastify.register(require('./routes/X'), {prefix:'/X'}). JSON parsing is built-in, no middleware needed.",
    metadata: { topic: "fastify" },
  },
  {
    text: "npm package: wolverine-ai on npmjs.com (v3.7.7). Install: npm i wolverine-ai. CLI: npx wolverine server/index.js. 85 files, 190KB compressed. Includes src/, bin/, examples/. Server directory created from src/templates/server/ on first run (never overwritten). GitHub: https://github.com/bobbyswhip/Wolverine. Unified billing: all AI calls route through inference proxy with credit-based billing. WOLVERINE_API_KEY authenticates through billing proxy, WOLVERINE_GPU_KEY for direct GPU access. 3 providers: openai, anthropic, wolverine (self-hosted GPU via Vast.ai).",
    metadata: { topic: "npm-package" },
  },
  {
    text: "Dashboard has 9 panels: Overview (stats cards + recent events), Events (live SSE stream), Performance (endpoint metrics), Analytics (memory/CPU charts, route health, response times), Command (admin chat with 3-route classifier), Backups (full backup management: stats cards, backup list with rollback/hot-load buttons per entry, reason display, status badges, undo last rollback button, rollback log, admin IP allowlist management), Brain (vector store stats + function map), Repairs (error/resolution audit trail with tokens and cost), Tools (agent tool harness listing), Usage (token analytics by model/category/tool with USD costs).",
    metadata: { topic: "dashboard-panels" },
  },
  {
    text: "Command interface routing: AI classifier (CLASSIFIER_MODEL) returns SIMPLE/TOOLS/AGENT. SIMPLE = brain knowledge only (CHAT_MODEL, no tools). TOOLS = live data with function calling (TOOL_MODEL, call_endpoint/read_file/search_brain). AGENT SMALL = smart edit (CODING_MODEL, 1 AI call, structured JSON file operations). AGENT MEDIUM = single agent (REASONING_MODEL, 8 turns). AGENT LARGE = sub-agents (explore→plan→fix).",
    metadata: { topic: "command-routing" },
  },
  {
    text: "Smart edit: for SMALL tier tasks, one AI call returns JSON with file operations: [{action:'create',path:'server/routes/X.js',content:'...'},{action:'edit',path:'server/index.js',find:'...',replace:'...'}]. Creates backup before changes, restarts server after, tests endpoint, rescans brain with new routes. Skills auto-injected into prompt when relevant.",
    metadata: { topic: "smart-edit" },
  },
  {
    text: "Token tracking: every AI call tracked with input/output tokens, USD cost, latencyMs, success/failure, and TPOT (time per output token). 8 task roles + embedding tracked separately. Categories by ACTIVITY: audit (injection scan), classifier (error classification), reasoning (AI analyzes error), coding (code generation without tools), tool (agent using read_file/write_file/bash_exec), research (deep investigation), chat (summaries), compacting (brain compression). Embedding billed through wolverine-embedding-1 (proxies text-embedding-3-small at 2x). Benchmark metrics: Speed (tok/s), TPOT (ms/output token), Cost/Call, Pass%. All tracked in byModelCategory for per-task model comparison.",
    metadata: { topic: "token-tracking" },
  },
  {
    text: "Repair history: dedicated audit trail at .wolverine/repair-history.json. Each entry: error, file, line, resolution, success, mode (fast/agent/sub-agents), model, tokens, cost, iteration, duration, filesModified. Dashboard Repairs panel shows stats (total, success rate, total cost, avg tokens) + scrollable history with per-repair details.",
    metadata: { topic: "repair-history" },
  },
  {
    text: "Skill registry: auto-discovers skills from src/skills/ on startup. Each skill exports SKILL_NAME, SKILL_DESCRIPTION, SKILL_KEYWORDS, SKILL_USAGE. Registry matches skills to commands using token scoring (claw-code pattern). Matched skills get injected into agent prompts before AI calls. SQL skill auto-injects when building database features.",
    metadata: { topic: "skill-registry" },
  },
  {
    text: "Notifications: detects human-required errors (expired keys, billing, service down, certs, permissions, disk). Classifies errors as AI-fixable vs human-required using pattern matching. Generates AI summary (CHAT_MODEL). Fires before wasting tokens on repair. Console alert + dashboard event + optional webhook. Categories: auth, billing, service, cert, permission, disk.",
    metadata: { topic: "notifications" },
  },
  {
    text: "Vault: encrypted key storage in .wolverine/vault/. AES-256-GCM encryption. master.key (32 bytes raw) encrypts eth.vault (Ethereum private key). Generated on first run if missing. Private key NEVER exists as a JS string — only Buffer, wiped after use. wallet-ops.js exposes getWalletAddress(), signTransaction(), signMessage() — all decrypt→use→wipe with generic error messages only. Injection detector blocks heal if 0x+64hex chars detected in error (key_leak_critical). Redactor scrubs all hex key patterns. Sandbox blocks agent access to vault paths. Backed up in every snapshot. Rollback-protected (NEVER_ROLLBACK list). Vault skill in src/skills/vault.js for agent discovery. Server code uses vault skill to earn/spend ETH without touching the private key.",
    metadata: { topic: "vault-security" },
  },
  {
    text: "MCP integration: connect external tools via Model Context Protocol. Configure in .wolverine/mcp.json with per-server tool allowlists. Security: arg sanitization (secrets redacted before sending to MCP servers), result injection scanning, rate limiting per server, audit logging. Tools appear as mcp__server__tool in the agent. Supports stdio and HTTP transports.",
    metadata: { topic: "mcp" },
  },
  {
    text: "Demos: 7 demo servers in examples/demos/. Demo runner (examples/run-demo.js) copies demo into server/, runs wolverine, restores on exit. npm run demo:list shows all demos. Each demo is a proper Fastify server with routes/ that mirrors the real server/ structure. Tests: basic typo, multi-file, syntax error, secret leak, expired key, JSON config, null crash.",
    metadata: { topic: "demos" },
  },
  {
    text: "10 model slots configurable per provider. settings.json has 3 presets: openai_settings, anthropic_settings, hybrid_settings. Set 'provider' to switch all at once. Slots: REASONING_MODEL (agent), CODING_MODEL (repair), CHAT_MODEL (text), TOOL_MODEL (function calling), CLASSIFIER_MODEL (routing), AUDIT_MODEL (injection), COMPACTING_MODEL (brain), RESEARCH_MODEL (deep research), TEXT_EMBEDDING_MODEL (vectors, always OpenAI). Hybrid mode uses Anthropic for heavy tasks (reasoning/coding/tool/research) and OpenAI for cheap tasks (audit/compacting/embedding). Every call tracked per-model with latencyMs, successRate, tokensPerSecond, costPerCall for performance comparison.",
    metadata: { topic: "model-slots" },
  },
  {
    text: "Port best practices: development uses port 3000 (standard, no admin, firewall-friendly). Production uses 443 (HTTPS) or 80 (HTTP) behind a reverse proxy (nginx/caddy). Never use random high ports in production — they bypass firewalls and confuse load balancers. Always use HTTPS in production — terminate TLS at the proxy, not in Node. Dashboard auto-runs on port+1. Wolverine warns on startup if the port is non-standard.",
    metadata: { topic: "port-security" },
  },
  {
    text: "Secret redaction is a singleton: initRedactor(projectRoot) called once on startup, then redact(text), redactObj(obj), hasSecrets(text) available everywhere via require('../security/secret-redactor'). No need to pass redactor instances. Every outbound path auto-redacts: event logger, repair history, telemetry heartbeats, brain memories, AI calls, dashboard output. Env variable values replaced with process.env.KEY_NAME.",
    metadata: { topic: "redaction-singleton" },
  },
  {
    text: "Admin auth: two-factor gate — WOLVERINE_ADMIN_KEY (header/cookie/query) + IP allowlist. Localhost always allowed (127.0.0.1, ::1, ::ffff:127.0.0.1). Remote IPs added via WOLVERINE_ADMIN_IPS env var (comma-separated) or POST /api/admin/add-ip at runtime from dashboard. addAllowedIp(ip) adds both IPv4 and IPv4-mapped IPv6. 10 failed attempts = 5min lockout. Timing-safe key comparison. Dashboard stores key as cookie after first auth.",
    metadata: { topic: "admin-auth" },
  },
  {
    text: "Operational fix layer: before calling AI, wolverine checks for common non-code errors that can be fixed instantly with zero tokens. Pattern 1: 'Cannot find module X' (where X is a package name, not a relative path) → runs npm install X via deps skill diagnosis. Pattern 2: ENOENT on config/data files (.json, .yaml, .env, .log, etc.) → for JSON configs, reads the source code that loads the file to infer expected fields (apiUrl, timeout, etc.) and creates the file with correct structure; for other types, creates empty file. Pattern 3: EACCES/EPERM → chmod 755 on the file. Pattern 4: EADDRINUSE → finds and kills stale process on the port (lsof on Linux, netstat on Windows). This layer runs before the AI repair loop and handles ~30% of production crashes at zero cost.",
    metadata: { topic: "operational-fix" },
  },
  {
    text: "Error classification: error-parser.js classifies every crash into a type that guides fix strategy. Types: missing_module (Cannot find module 'X' where X is npm package), missing_file (Cannot find module './X' or ENOENT), permission (EACCES/EPERM), port_conflict (EADDRINUSE), syntax (SyntaxError), runtime (TypeError/ReferenceError/RangeError), unknown. The errorType field is available to all downstream handlers: operational fix, fast path, agent, sub-agents.",
    metadata: { topic: "error-classification" },
  },
  {
    text: "Agent fix strategy table: the agent system prompt includes a decision table mapping error patterns to correct fix actions. Cannot find module 'X' (package) → bash_exec: npm install X. Cannot find module './X' (local) → edit_file: fix require path. ENOENT → write_file: create missing file. EACCES → bash_exec: chmod. EADDRINUSE → bash_exec: kill process. SyntaxError → edit_file: fix code. TypeError → edit_file: fix logic. MODULE_NOT_FOUND + node_modules → bash_exec: rm -rf node_modules && npm install. The fast path AI response format now supports both 'changes' (code edits) and 'commands' (shell commands like npm install). Dangerous commands blocked: rm -rf /, format, mkfs.",
    metadata: { topic: "agent-fix-strategy" },
  },
  {
    text: "Error Monitor: detects caught 500 errors that don't crash the process. Most production bugs are caught by Fastify/Express error handlers — the server stays alive but routes return 500. Wolverine's crash-based heal pipeline never triggers for these. ErrorMonitor tracks 5xx errors per normalized route (/api/users/123 → /api/users/:id) via IPC from child process. Single error triggers heal (threshold=1, configurable). Error hook auto-injected via --require preload (no user code changes) — hooks Fastify onError + setErrorHandler wrapper + auto-registers default error handler if user never sets one (catches async route throws). Cooldown prevents heal spam (default: 60s per route). Health check failures also trigger heal (not just restart). Config: WOLVERINE_ERROR_THRESHOLD, WOLVERINE_ERROR_WINDOW_MS, WOLVERINE_ERROR_COOLDOWN_MS.",
    metadata: { topic: "error-monitor" },
  },
  {
    text: "Agent tool details: read_file supports offset/limit for large files. edit_file does surgical find-and-replace (preferred for small fixes). glob_files discovers files by pattern (**/*.js). grep_code does regex search with context lines. list_dir shows directory contents with file sizes. move_file relocates/renames files. bash_exec runs shell commands (30s default timeout, 60s hard cap, dangerous commands blocked: rm -rf /, git push --force, npm publish). inspect_db reads SQLite: action=tables (list), action=schema (CREATE statements), action=query (SELECT/PRAGMA only). run_db_fix writes SQLite with SAFETY: auto-snapshots affected rows BEFORE write (SELECT WHERE matching the UPDATE/DELETE), executes the fix, snapshots AFTER, returns before/after comparison so agent can verify. Always backs up the DB file. Agent MUST inspect_db before run_db_fix — never write blind. For NaN/null data errors: prefer fixing code to handle edge cases over modifying production data. check_port finds what process is using a port (netstat/lsof). check_env lists environment variables with values redacted. audit_deps runs full npm health check. check_migration returns known upgrade paths. web_fetch retrieves URL content.",
    metadata: { topic: "agent-tools-detail" },
  },
  {
    text: "Server problem categories the agent can fix: CODE BUGS (SyntaxError, TypeError, ReferenceError → edit_file), DEPENDENCIES (Cannot find module → npm install, corrupted node_modules → rm + reinstall), DATABASE (invalid entries → run_db_fix UPDATE, missing table → CREATE TABLE, schema mismatch → ALTER TABLE, constraint violation → fix data or schema), CONFIG (invalid JSON → edit_file, missing env vars → write .env, wrong port → edit config), FILESYSTEM (misplaced files → move_file, missing directories → bash_exec mkdir, wrong permissions → chmod), NETWORK (port conflict → check_port + kill, service down → restart, connection refused → check config), STATE (corrupted cache → delete + restart, stale locks → remove lock file, git conflicts → resolve markers), IDEMPOTENCY (double-fire → add idempotencyGuard middleware, missing idempotency key → add X-Idempotency-Key header support, duplicate DB entries → add UNIQUE constraint or use db.idempotent()). The agent investigates before fixing — reads files, checks directories, inspects databases, never guesses.",
    metadata: { topic: "server-problems" },
  },
  {
    text: "Idempotency protection: two layers prevent double-fire in cluster mode. Layer 1: idempotencyGuard() Fastify middleware — intercepts POST/PUT/PATCH/DELETE, checks X-Idempotency-Key header (or auto-generates key from method+path+body hash), queries _idempotency table. If key exists and not expired → return cached response with X-Idempotency-Cached:true header, skip handler. If new → pass through, idempotencyAfterHook() stores response. Layer 2: SafeDB.idempotent(key, fn) — database-level dedup. Wraps fn in transaction, checks key, executes only if new. Returns {executed:true/false, result, cached}. Keys expire after TTL (default 24h). All workers share the SQLite _idempotency table via WAL mode — globally consistent. Auto-pruned on connect and via db.pruneIdempotency().",
    metadata: { topic: "idempotency" },
  },
  {
    text: "Heal pipeline no longer requires a file path. When no file is identified from the error (database errors, config problems, port conflicts), the pipeline skips fast path and goes straight to the agent, which uses investigation tools (glob_files, grep_code, list_dir, inspect_db, check_env, check_port, audit_deps) to find the root cause. Agent verification for no-file errors: if agent made changes or ran commands, trust the agent's assessment. For file-based errors, verification uses syntax check + boot probe + route probe as before.",
    metadata: { topic: "fileless-heal" },
  },
  {
    text: "Dependency manager skill (src/skills/deps.js): structured npm dependency analysis + repair. diagnose(errorMessage, cwd) returns {diagnosed, category, summary, fixes} — categories: missing_install, missing_package, version_conflict, outdated_api, corrupted_modules. healthReport(cwd) returns full health check: npm audit (vulnerabilities), outdated packages, peer dep conflicts, unused packages, lock file status, health score 0-100. getMigration(packageName) returns known upgrade paths: express→fastify (5.6x faster), moment→dayjs (2KB vs 70KB), request→node-fetch (deprecated), body-parser→built-in, callbacks→async/await. Agent tools: audit_deps (full health check), check_migration (upgrade paths). Heal pipeline uses diagnose() in tryOperationalFix before AI — zero tokens for dependency issues.",
    metadata: { topic: "skill-deps" },
  },
  {
    text: "Backup skill (src/skills/backup.js): agent-friendly backup/rollback. Functions: backup(cwd, reason) creates snapshot, rollback(cwd, id) restores specific backup, rollbackLatest(cwd) restores most recent, undoRollback(cwd) undoes last rollback, listBackups(cwd) shows all with status/age/reason. Agent can use via bash_exec: node -e \"require('./src/skills/backup').backup('.', 'before change')\". CLI: wolverine --backup 'reason', wolverine --list-backups, wolverine --rollback <id>, wolverine --rollback-latest, wolverine --undo-rollback. All stored in ~/.wolverine-safe-backups/snapshots/. Create backup BEFORE any risky server change.",
    metadata: { topic: "backup-skill" },
  },
  {
    text: "CRITICAL: Never run raw 'npm install wolverine-ai' or 'git pull' to update — these OVERWRITE server/, .wolverine/ (brain, backups, events), and .env.local. Always use the safe update skill: wolverine --update (CLI), safeUpdate(cwd) (programmatic), or let auto-update handle it. Startup backup: wolverine creates a safety snapshot of server/ before first spawn on every start. If the server crashes immediately after a bad update and healing fails/is blocked, wolverine auto-rollbacks to the startup snapshot after max retries — prevents permanent breakage from corrupted server/ files. ALL backups (heal snapshots + update snapshots + startup snapshots) stored in ~/.wolverine-safe-backups/ (OUTSIDE project, survives git clean, rm -rf, project deletion). Restore with: wolverine --restore <name>. List: wolverine --backups.",
    metadata: { topic: "safe-update-warning" },
  },
  {
    text: "Auto-update: wolverine checks npm registry hourly for new versions. When found, runs npm install wolverine-ai@latest, backs up settings.json/.env.local before update and restores after. Config: autoUpdate.enabled (default true) in settings.json. Disable with WOLVERINE_AUTO_UPDATE=false env var. On successful update, signals runner to restart. Protected files never overwritten: settings.json, .env.local, .env, db.js. Update check runs 30s after startup then every hour (configurable via autoUpdate.intervalMs).",
    metadata: { topic: "auto-update" },
  },
  {
    text: "Loop guard: detects infinite heal loops and stops burning tokens. Tracks heal attempts by error signature — if 3+ heals fail on same error in 10 minutes, STOPS healing and generates a bug report. Bug report sent to platform backend for human review (security scanned for injection/secrets first). 30-minute cooldown after bug report filed. Process dedup via PID file (.wolverine/wolverine.pid) ensures only one wolverine instance runs — kills old process on startup. Config: WOLVERINE_LOOP_MAX_ATTEMPTS (default 3), WOLVERINE_LOOP_WINDOW_MS (default 600000).",
    metadata: { topic: "loop-guard" },
  },
  {
    text: "Token waste prevention: 3 layers. (1) Empty stderr guard — signal kills with no error output just restart, no AI ($0.00). (2) Loop guard — 3 failed heals on same error → stop and file bug report, no more AI calls. (3) Global rate limit — max 5 heals per 5 minutes regardless of error signature. Idle server burns exactly $0.00 in tokens.",
    metadata: { topic: "token-protection" },
  },
  {
    text: "Audit optimizations: (1) Brain namespace isolation — seed docs (20K tokens of wolverine self-knowledge) excluded from error healing searches. Only searched when query is about wolverine itself. Cuts context by 50%. (2) Dynamic system prompt — simple errors (TypeError/ReferenceError) get 400-token compact prompt with 7 tools. Complex errors get full 1200-token prompt with 18 tools + strategy table. Saves 50% on 70% of heals. (3) Stability timer race fix — backup ID captured in closure, prevents wrong backup promoted if new heal starts before 30min timer. (4) Dynamic sub-agent budgets — simple: explore 8K/fix 25K, moderate: 15K/50K, complex: 25K/80K. Saves 40% on simple fixes. (5) Function map hash check — skips re-embedding if unchanged (MD5 hash stored in .wolverine/brain/.fmap-hash). 10-20% faster startup.",
    metadata: { topic: "audit-optimizations" },
  },
  {
    text: "Agent efficiency (claw-code patterns): (1) Anthropic prompt caching — system prompt marked with cache_control:{type:'ephemeral'}, cached server-side across agent turns, 90% cheaper on repeat calls (12-16K saved tokens per heal). (2) Tool result truncation — capped at 4K chars before entering message history, prevents context blowup from large grep/file reads. (3) Zero-cost structural compaction — extracts signals (tools used, files touched, errors found, actions taken) from message history WITHOUT an LLM call. Costs $0.00 vs old method that burned tokens on a compacting model. Triggers when estimated tokens > 10K (text.length/4 approximation). Preserves last 4 messages verbatim. (2) Token estimation — text.length/4+1, fast approximation without tokenizer, ~10% accurate. Used for budget decisions before API calls. (3) Error-graceful tools — tool errors returned as [ERROR] prefixed results, not thrown. Model sees the error and decides how to proceed. (4) Pre/post tool hooks — shell commands in .wolverine/hooks.json, exit 0=allow, 2=deny. Enables audit logging and policy enforcement without hard-coding.",
    metadata: { topic: "agent-efficiency" },
  },
  {
    text: "Robustness guards: (1) Heal concurrency guard — _healInProgress flag prevents parallel heals from health monitor + crash handler racing. (2) Global rate limit — 5 heals per 5 minutes regardless of error signature, prevents infinite loop of different errors burning API quota. (3) Heal timeout — Promise.race wraps _healImpl() with 5-minute timeout, clears _healInProgress on timeout. (4) Per-API-call timeout — 45s timeout in agent engine via Promise.race, returns partial results if files already modified. (5) bash_exec enforced timeout — 30s default, 60s hard cap via Math.min(). (6) PID file race prevention — exit handler only deletes PID file if it still belongs to current process. (7) SIGTERM startup grace — 3s grace period ignores SIGTERM on startup, prevents restart scripts from killing both old and new processes. (8) Research timeout — deep research capped at 30s, deferred to iteration 3+ to avoid slowing early fix attempts.",
    metadata: { topic: "robustness-guards" },
  },
  {
    text: "Cost optimization: 7 techniques reduce heal cost from $0.31 to $0.02 for simple errors. (1) Verifier skips route probe for simple errors (TypeError/ReferenceError/SyntaxError) — trusts syntax+boot, ErrorMonitor is safety net. Prevents false-rejection cascades. (2) Sub-agents use Haiku (classifier model) for explore/plan/verify/research — only fixer uses Sonnet/Opus. 6 Haiku calls=$0.006 vs 6 Sonnet calls=$0.12. (3) Agent context compacted every 3 turns using compacting model — prevents 15K→95K token blowup. (4) Brain checked for cached fix patterns before AI — repeat errors cost $0. (5) Token budgets capped by error complexity: simple=20K agent budget, moderate=50K, complex=100K. Simple errors get 4 agent turns max. (6) Prior attempt summaries (not full context) passed between iterations — concise 'do NOT repeat' directives. (7) Fast path includes last known good backup code so AI can revert broken additions instead of patching around them.",
    metadata: { topic: "cost-optimization" },
  },
];

class Brain {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.store = new VectorStore(projectRoot);
    this.functionMap = null;
    this._initialized = false;
  }

  /**
   * Initialize the brain. Call once on startup.
   * Scans project, seeds docs if needed, embeds function map.
   */
  async init() {
    const stats = this.store.getStats();
    const isFirstRun = stats.totalEntries === 0;

    console.log(chalk.gray(`  🧠 Brain: ${stats.totalEntries} memories loaded`));

    // 1. Seed wolverine docs on first run OR merge new seeds after framework update
    const seedRefreshPath = path.join(this.projectRoot, ".wolverine", "brain", ".seed-refresh");
    const needsSeedRefresh = fs.existsSync(seedRefreshPath);

    if (isFirstRun) {
      console.log(chalk.gray("  🧠 First run — seeding wolverine documentation..."));
      await this._seedDocs();
    } else if (needsSeedRefresh) {
      console.log(chalk.gray("  🧠 Framework updated — merging new seed docs..."));
      await this._mergeSeedDocs();
      try { fs.unlinkSync(seedRefreshPath); } catch {}
    } else {
      // Auto-detect new seeds: if SEED_DOCS count > docs namespace count, merge
      const docsCount = (this.store.getNamespace("docs") || []).length;
      if (SEED_DOCS.length > docsCount) {
        console.log(chalk.gray(`  🧠 New seed docs detected (${SEED_DOCS.length} vs ${docsCount}) — merging...`));
        await this._mergeSeedDocs();
      }
    }

    // 2. Scan project for live function map
    console.log(chalk.gray("  🧠 Scanning project for function map..."));
    this.functionMap = scanProject(this.projectRoot);
    console.log(chalk.gray(`  🧠 Found: ${this.functionMap.routes.length} routes, ${this.functionMap.functions.length} functions, ${this.functionMap.classes.length} classes`));

    // 3. Embed function map — only if changed (hash check saves 10-20% startup time)
    const crypto = require("crypto");
    const mapHash = crypto.createHash("md5").update(JSON.stringify(this.functionMap)).digest("hex");
    const hashPath = path.join(this.projectRoot, ".wolverine", "brain", ".fmap-hash");
    let lastHash = "";
    try { lastHash = fs.readFileSync(hashPath, "utf-8").trim(); } catch {}
    if (mapHash !== lastHash) {
      await this._embedFunctionMap();
      try { fs.writeFileSync(hashPath, mapHash, "utf-8"); } catch {}
    } else {
      console.log(chalk.gray("  🧠 Function map unchanged — skipping re-embed"));
    }

    // 4. Save
    this.store.save();

    this._initialized = true;
    const finalStats = this.store.getStats();
    console.log(chalk.gray(`  🧠 Brain ready: ${finalStats.totalEntries} total memories`));
    if (finalStats.namespaces) {
      const ns = Object.entries(finalStats.namespaces).map(([k, v]) => `${k}:${v}`).join(", ");
      console.log(chalk.gray(`  🧠 Namespaces: ${ns}`));
    }
  }

  /**
   * Remember something — compact, embed, and store.
   *
   * @param {string} namespace - "errors", "fixes", "learnings"
   * @param {string} rawText - The raw text to remember
   * @param {object} metadata - Structured metadata
   */
  async remember(namespace, rawText, metadata = {}) {
    const { compacted, embedding } = await compactAndEmbed(rawText);
    const id = this.store.add(namespace, compacted, embedding, metadata);
    this.store.save();
    return id;
  }

  /**
   * Recall relevant memories — two-tier search for speed.
   *
   * Tier 1: Fast keyword search (instant, no API call)
   * Tier 2: Semantic embedding search (API call, only if keywords miss)
   */
  async recall(query, options = {}) {
    const topK = options.topK || 5;

    // Tier 1: keyword search (instant)
    const keywordResults = this.store.keywordSearch(query, { topK, namespace: options.namespace, minTokens: 1 });
    if (keywordResults.length >= topK) {
      return keywordResults;
    }

    // Tier 2: semantic search (API call — only if keyword search didn't find enough)
    try {
      const queryEmbedding = await embed(query);
      const semanticResults = this.store.search(queryEmbedding, { topK, ...options });

      // Merge: keyword results first (they're more precise), then semantic
      const seen = new Set(keywordResults.map(r => r.id));
      const merged = [...keywordResults];
      for (const r of semanticResults) {
        if (!seen.has(r.id)) {
          merged.push(r);
          seen.add(r.id);
        }
      }
      return merged.slice(0, topK);
    } catch {
      // If embedding API fails, return keyword results only
      return keywordResults;
    }
  }

  /**
   * Build a full context string for the agent.
   * Includes: function map summary + relevant memories.
   */
  async getContext(errorMessage) {
    const parts = [];

    // Function map summary (always included — fast, no API call)
    if (this.functionMap) {
      parts.push("## Server Function Map\n" + this.functionMap.summary);
    }

    // Search only operational namespaces — NOT docs (seed docs add 20K tokens of
    // wolverine self-knowledge that's irrelevant to fixing a TypeError).
    // Docs are only searched when user asks about wolverine itself.
    const isAboutWolverine = /wolverine|heal|pipeline|agent|backup|brain|dashboard/i.test(errorMessage || "");
    if (errorMessage) {
      const searchNamespaces = isAboutWolverine ? undefined : undefined; // search all but filter below
      const allMemories = await this.recall(errorMessage, { topK: 8, minScore: 0.3 });
      // Filter: exclude seed docs unless query is about wolverine
      const memories = isAboutWolverine
        ? allMemories.slice(0, 5)
        : allMemories.filter(m => m.namespace !== "docs").slice(0, 5);
      if (memories.length > 0) {
        parts.push("\n## Relevant Context from Brain");
        for (const mem of memories) {
          const nsLabel = mem.namespace.toUpperCase();
          parts.push(`[${nsLabel}] ${mem.text}`);
        }
      }
    }

    return parts.join("\n");
  }

  /**
   * Get stats for dashboard/logging.
   */
  getStats() {
    return {
      ...this.store.getStats(),
      functionMap: this.functionMap ? {
        routes: this.functionMap.routes.length,
        functions: this.functionMap.functions.length,
        classes: this.functionMap.classes.length,
        files: this.functionMap.files.length,
      } : null,
    };
  }

  // -- Private --

  async _seedDocs() {
    const texts = SEED_DOCS.map(d => d.text);
    const embeddings = await embedBatch(texts);

    for (let i = 0; i < SEED_DOCS.length; i++) {
      this.store.add("docs", SEED_DOCS[i].text, embeddings[i], SEED_DOCS[i].metadata);
    }

    console.log(chalk.gray(`  🧠 Seeded ${SEED_DOCS.length} documentation entries`));
  }

  /**
   * Merge new seed docs into existing brain — append only, never delete.
   * Compares by topic metadata to find new/updated docs.
   * Existing memories (errors, fixes, learnings) are untouched.
   */
  async _mergeSeedDocs() {
    const existing = this.store.getNamespace("docs") || [];
    const existingTopics = new Set(existing.map(e => e.metadata?.topic).filter(Boolean));

    // Find seed docs whose topic isn't already in the brain
    const newDocs = SEED_DOCS.filter(d => !existingTopics.has(d.metadata?.topic));
    // Find seed docs whose topic exists but text has changed (updated knowledge)
    const updatedDocs = SEED_DOCS.filter(d => {
      if (!existingTopics.has(d.metadata?.topic)) return false;
      const match = existing.find(e => e.metadata?.topic === d.metadata?.topic);
      return match && match.text !== d.text;
    });

    const toEmbed = [...newDocs, ...updatedDocs];
    if (toEmbed.length === 0) {
      console.log(chalk.gray("  🧠 Brain seeds already up to date"));
      return;
    }

    // Remove old versions of updated docs
    for (const doc of updatedDocs) {
      const old = existing.find(e => e.metadata?.topic === doc.metadata?.topic);
      if (old) this.store.delete(old.id);
    }

    // Embed and add new/updated docs
    const texts = toEmbed.map(d => d.text);
    const embeddings = await embedBatch(texts);
    for (let i = 0; i < toEmbed.length; i++) {
      this.store.add("docs", toEmbed[i].text, embeddings[i], toEmbed[i].metadata);
    }

    this.store.save();
    console.log(chalk.gray(`  🧠 Merged: ${newDocs.length} new + ${updatedDocs.length} updated seed docs`));
  }

  async _embedFunctionMap() {
    // Clear old function map entries
    const oldEntries = this.store.getNamespace("functions");
    for (const entry of oldEntries) {
      this.store.delete(entry.id);
    }

    // Generate chunks from the live map
    const chunks = mapToChunks(this.functionMap);
    if (chunks.length === 0) return;

    const texts = chunks.map(c => c.text);
    const embeddings = await embedBatch(texts);

    for (let i = 0; i < chunks.length; i++) {
      this.store.add("functions", chunks[i].text, embeddings[i], chunks[i].metadata);
    }

    console.log(chalk.gray(`  🧠 Indexed ${chunks.length} function map chunks`));
  }
}

module.exports = { Brain, SEED_DOCS };
