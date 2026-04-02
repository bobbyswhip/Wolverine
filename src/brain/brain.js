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
    text: "Wolverine heal pipeline: crash detected → error parsed (file, line, message) → prompt injection scan (AUDIT_MODEL) → rate limit check → fast path repair (CODING_MODEL via Responses/Chat API) → if fast path fails verification → escalate to multi-file agent (REASONING_MODEL with tools: read_file, write_file, list_files, search_files) → verify fix (syntax check + boot probe) → rollback on failure.",
    metadata: { topic: "heal-pipeline" },
  },
  {
    text: "Wolverine backup system: every fix creates a backup before patching. Status lifecycle: UNSTABLE (just created) → VERIFIED (fix passed boot probe) → STABLE (server ran 30min+ without crash). Retention: unstable backups pruned after 7 days. Stable backups older than 7 days keep 1 per day.",
    metadata: { topic: "backup-system" },
  },
  {
    text: "Wolverine security: file sandbox restricts all reads/writes to the project directory. Prompt injection detection runs on every error (regex layer + AI audit via AUDIT_MODEL). Rate limiter prevents error explosion cost with sliding window, min gap, hourly token budget, and exponential backoff for error loops.",
    metadata: { topic: "security" },
  },
  {
    text: "Wolverine model tiers: REASONING_MODEL for deep multi-step debugging. CODING_MODEL for code repair generation. CHAT_MODEL for explanations and summaries. AUDIT_MODEL for security scans (runs every error, keep cheap). UTILITY_MODEL for JSON formatting and thought compaction. TEXT_EMBEDDING_MODEL for brain vector embeddings.",
    metadata: { topic: "model-config" },
  },
  {
    text: "Wolverine performance monitoring: tracks HTTP endpoint response times, detects slow endpoints (>2s avg), identifies spam/DDoS patterns (>100 req/min to one endpoint), flags response time spikes (5x normal), detects high error rates (>20%). Triggers AI analysis for optimization suggestions.",
    metadata: { topic: "perf-monitoring" },
  },
  {
    text: "Wolverine brain: semantic vector database for long-term memory. Stores project function maps, past errors, successful fixes, and learned patterns. Uses TEXT_EMBEDDING_MODEL for embeddings and UTILITY_MODEL to compact thoughts before embedding. In-memory cosine similarity search for speed. Persisted to .wolverine/brain/.",
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
    text: "Wolverine multi-file agent: 15-turn agent loop with tools. Can read any file, write any file type (js, json, sql, yaml, env, dockerfile), list directories, and search across the codebase. Used when the fast path single-file fix fails. Tracks token budget (50k max) to control costs.",
    metadata: { topic: "agent" },
  },
  {
    text: "Wolverine supports the Responses API for codex models and Chat Completions API for standard models. Auto-detects based on model name. Codex models use openai.responses.create() with input/instructions/tools. Standard models use openai.chat.completions.create() with messages/tools.",
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
    text: "Database best practices: SafeDB uses split connections — separate read connection (concurrent, never waits) and write connection (single writer, FIFO queue). Write queue drains synchronously in one microtask, zero delays. WAL mode means readers never block writers. Each write is microseconds. db.transaction(fn) queues as single atomic unit. No busy_timeout, no blocking, no IPC. Reads: db.get(), db.all() are instant. Writes: db.run(), db.exec() go through queue.",
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
    text: "Sub-agent tool restrictions (claw-code pattern): explore gets read_file/glob/grep/git. plan gets read_file/glob/grep/brain. fix gets read_file/write_file/edit_file/glob/grep. verify gets read_file/glob/grep/bash. research gets read_file/grep/web_fetch/brain. security gets read_file/glob/grep. database gets read_file/write_file/edit_file/glob/grep/bash. No agent gets tools it doesn't need.",
    metadata: { topic: "sub-agent-tools" },
  },
  {
    text: "Heal pipeline escalation: Iteration 1 uses fast path (CODING_MODEL, single file, cheapest). Iteration 2 uses single agent (REASONING_MODEL, multi-file, 8 turns). Iteration 3+ uses sub-agents (explore→plan→fix, 3 specialized agents with restricted tools). Each iteration gets context from previous failures. Deep research (RESEARCH_MODEL) triggers after 2+ failures.",
    metadata: { topic: "heal-escalation" },
  },
  {
    text: "Process manager: wolverine monitors memory (RSS/heap) every 10s, detects memory leaks (N consecutive growth samples → auto-restart), enforces memory limit (default 512MB), tracks CPU%, probes all routes every 30s, detects response time degradation trends (stable/degrading/improving). Analytics dashboard shows memory/CPU charts and per-route health.",
    metadata: { topic: "process-manager" },
  },
  {
    text: "Auto-clustering: wolverine detects machine capabilities (cores, RAM, disk, platform, Docker/K8s, cloud provider) and forks optimal workers. 2 cores = 2 workers, 3-4 = cores-1, 5-8 = cores-1 cap 6, 9+ = cores/2 cap 16. Workers auto-respawn on crash with exponential backoff. CLI: --single (no cluster), --workers N (fixed), --info (show system). Settings in server/config/settings.json cluster.mode.",
    metadata: { topic: "clustering" },
  },
  {
    text: "System detection: wolverine --info shows CPU cores/model/speed, total/free RAM, disk space, Node version, platform, container environment (Docker, Kubernetes), cloud provider (AWS, GCP, Azure, Railway, Fly, Render, Heroku). Used by ClusterManager to auto-scale worker count. Dashboard API: GET /api/system returns full machine info.",
    metadata: { topic: "system-detection" },
  },
  {
    text: "Configuration: all settings in server/config/settings.json (models, port, telemetry, rate limits, health checks, clustering, cors, logging). Secrets only in .env.local (API keys, admin key). Config loader priority: env vars > settings.json > defaults. Agent can read and edit settings.json since it's inside server/.",
    metadata: { topic: "configuration" },
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
    text: "npm package: published as wolverine-node and wolverine-ai on npmjs.com. Install with: npm i wolverine-node or npm i wolverine-ai. Both are the same package. v1.0.0, 79 files, 125KB compressed. Includes src/, bin/, server/, examples/. GitHub: https://github.com/bobbyswhip/Wolverine",
    metadata: { topic: "npm-package" },
  },
  {
    text: "Dashboard has 9 panels: Overview (stats cards + recent events), Events (live SSE stream), Performance (endpoint metrics), Analytics (memory/CPU charts, route health, response times), Command (admin chat with 3-route classifier), Backups (server/ snapshots with status badges), Brain (vector store stats + function map), Repairs (error/resolution audit trail with tokens and cost), Tools (agent tool harness listing), Usage (token analytics by model/category/tool with USD costs).",
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
    text: "Token tracking: every AI call tracked with input/output tokens + USD cost. Categories: heal, develop, chat, security, classify, research, brain. Tracked by model, by category, by tool. Persisted to .wolverine/usage.json (aggregates) and .wolverine/usage-history.jsonl (full timeline). Auto-saves on every call. Dashboard shows charts + cost breakdowns. Pricing from src/logger/pricing.js, customizable via .wolverine/pricing.json.",
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
    text: "MCP integration: connect external tools via Model Context Protocol. Configure in .wolverine/mcp.json with per-server tool allowlists. Security: arg sanitization (secrets redacted before sending to MCP servers), result injection scanning, rate limiting per server, audit logging. Tools appear as mcp__server__tool in the agent. Supports stdio and HTTP transports.",
    metadata: { topic: "mcp" },
  },
  {
    text: "Demos: 7 demo servers in examples/demos/. Demo runner (examples/run-demo.js) copies demo into server/, runs wolverine, restores on exit. npm run demo:list shows all demos. Each demo is a proper Fastify server with routes/ that mirrors the real server/ structure. Tests: basic typo, multi-file, syntax error, secret leak, expired key, JSON config, null crash.",
    metadata: { topic: "demos" },
  },
  {
    text: "10 configurable models: REASONING_MODEL (multi-file agent), CODING_MODEL (code repair, Responses API for codex), CHAT_MODEL (simple text), TOOL_MODEL (function calling), CLASSIFIER_MODEL (routing), AUDIT_MODEL (injection detection), COMPACTING_MODEL (brain text compression), RESEARCH_MODEL (deep research), TEXT_EMBEDDING_MODEL (vectors). All in server/config/settings.json. Reasoning models auto-get 4x token limits for chain-of-thought.",
    metadata: { topic: "model-slots" },
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

    // 1. Seed wolverine docs on first run
    if (isFirstRun) {
      console.log(chalk.gray("  🧠 First run — seeding wolverine documentation..."));
      await this._seedDocs();
    }

    // 2. Scan project for live function map
    console.log(chalk.gray("  🧠 Scanning project for function map..."));
    this.functionMap = scanProject(this.projectRoot);
    console.log(chalk.gray(`  🧠 Found: ${this.functionMap.routes.length} routes, ${this.functionMap.functions.length} functions, ${this.functionMap.classes.length} classes`));

    // 3. Embed function map (replace old "functions" entries)
    await this._embedFunctionMap();

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

    // Two-tier recall: keyword first, semantic fallback
    if (errorMessage) {
      const memories = await this.recall(errorMessage, { topK: 5, minScore: 0.3 });
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
