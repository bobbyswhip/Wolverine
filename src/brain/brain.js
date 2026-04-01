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
    text: "Server structure: server/ folder is the live project. server/index.js is the entry point (app setup, middleware, route mounting). server/routes/ has one file per resource. server/middleware/ for auth, validation, logging. server/services/ for business logic. server/models/ for database schemas. server/config/ for configuration. Keep index.js under 50 lines — just wiring.",
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
    text: "Database best practices enforced by SQL skill: ALWAYS use parameterized queries with ? placeholders, NEVER concatenate user input into SQL strings, use connection pooling, handle connection errors gracefully, use WAL journal mode for SQLite, enable foreign keys, close connections on process exit. The SafeDB class throws an error if string concatenation is detected in a query.",
    metadata: { topic: "skill-sql-best-practices" },
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
   * Recall relevant memories by semantic similarity.
   *
   * @param {string} query - What to search for
   * @param {object} options - { topK, namespace, minScore }
   * @returns {Array<{ text, metadata, score }>}
   */
  async recall(query, options = {}) {
    const queryEmbedding = await embed(query);
    return this.store.search(queryEmbedding, { topK: 5, ...options });
  }

  /**
   * Build a full context string for the agent.
   * Includes: function map summary + relevant memories for the given error.
   */
  async getContext(errorMessage) {
    const parts = [];

    // Function map summary (always included — fast, no API call)
    if (this.functionMap) {
      parts.push("## Server Function Map\n" + this.functionMap.summary);
    }

    // Semantic recall for relevant context
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
