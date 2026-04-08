/**
 * Wolverine API — unified entry point for any OpenClaw process.
 *
 * Exposes every wolverine subsystem through a single, lazy-loaded API.
 * Nothing is imported until first use, so requiring this module is free.
 *
 * Usage from any OpenClaw skill, plugin, or agent:
 *   const wolverine = require("wolverine-ai/src/claw/wolverine-api");
 *   const api = wolverine.init("/path/to/project");
 *
 *   // Security
 *   api.security.detectInjection("some user input");
 *   api.security.redact("text with sk-abc123 key");
 *   api.security.sandbox.resolve("server/index.js");
 *
 *   // Brain
 *   await api.brain.search("how to fix ECONNREFUSED");
 *   await api.brain.learn("Redis needs REDIS_URL env var", "fix");
 *
 *   // AI
 *   const result = await api.ai.call({ model: "claude-sonnet-4-6", ... });
 *
 *   // Errors
 *   api.errors.parse(stderrText);
 *   api.errors.classify(errorMessage);
 *   api.errors.routeTools("ECONNREFUSED");
 *
 *   // Backup
 *   api.backup.create("before risky change");
 *   api.backup.rollbackLatest();
 *
 *   // ... etc
 */

const path = require("path");

let _projectRoot = null;
let _initialized = false;

// Lazy singletons — created on first access
const _cache = {};

function _require(relativePath) {
  return require(path.join(_projectRoot, relativePath));
}

function _lazy(key, factory) {
  if (!_cache[key]) _cache[key] = factory();
  return _cache[key];
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Initialize the Wolverine API for a project.
 * Call once — returns the API object. Subsequent calls return the same instance.
 */
function init(projectRoot) {
  if (_initialized && _projectRoot === path.resolve(projectRoot)) return api;
  _projectRoot = path.resolve(projectRoot);
  _initialized = true;

  // Clear cache if re-initializing with different root
  for (const key of Object.keys(_cache)) delete _cache[key];

  return api;
}

const api = {
  // ── Security ────────────────────────────────────────────────

  get security() {
    return _lazy("security", () => {
      const { detectInjection, localScan, INJECTION_PATTERNS } = _require("src/security/injection-detector");
      const { initRedactor, redact, redactObj, hasSecrets } = _require("src/security/secret-redactor");
      const { Sandbox } = _require("src/security/sandbox");
      const { RateLimiter } = _require("src/security/rate-limiter");

      // Initialize redactor for this project
      const redactor = initRedactor(_projectRoot);

      return {
        // Prompt injection detection (~50 patterns)
        detectInjection,
        localScan,
        INJECTION_PATTERNS,

        // Secret redaction
        redact,
        redactObj,
        hasSecrets,
        redactor,

        // File sandbox
        sandbox: new Sandbox(_projectRoot),
        Sandbox,

        // Rate limiting
        createRateLimiter: (opts) => new RateLimiter(opts),
        RateLimiter,
      };
    });
  },

  // ── Brain (semantic memory) ─────────────────────────────────

  get brain() {
    return _lazy("brain", () => {
      const { Brain } = _require("src/brain/brain");
      const { VectorStore } = _require("src/brain/vector-store");
      const { embed, embedBatch, compact, compactAndEmbed } = _require("src/brain/embedder");
      const { scanProject, mapToChunks } = _require("src/brain/function-map");
      const { route, getRoutePrompt, TOOL_ROUTES } = _require("src/brain/tool-router");

      const brain = new Brain(_projectRoot);
      let _initPromise = null;

      return {
        // High-level brain operations
        async search(query, opts) {
          if (!_initPromise) _initPromise = brain.init();
          await _initPromise;
          return brain.search ? brain.search(query, opts)
            : brain.recall ? brain.recall(query, opts)
            : [];
        },
        async learn(content, category) {
          if (!_initPromise) _initPromise = brain.init();
          await _initPromise;
          if (brain.addDocument) {
            return brain.addDocument({ content, namespace: category || "learnings", source: "wolverine-claw", timestamp: Date.now() });
          }
          if (brain.remember) return brain.remember(content, { namespace: category });
        },
        async getContext(query) {
          if (!_initPromise) _initPromise = brain.init();
          await _initPromise;
          return brain.getContext ? brain.getContext(query) : "";
        },
        async init() {
          if (!_initPromise) _initPromise = brain.init();
          return _initPromise;
        },

        // Low-level access
        instance: brain,
        VectorStore,
        embed,
        embedBatch,
        compact,
        compactAndEmbed,
        scanProject,
        mapToChunks,

        // Tool router — maps error types to tool chains
        routeTools: route,
        getRoutePrompt,
        TOOL_ROUTES,
      };
    });
  },

  // ── AI Client ───────────────────────────────────────────────

  get ai() {
    return _lazy("ai", () => {
      const client = _require("src/core/ai-client");
      const { getModel, getEmbeddingModel, getModelConfig, detectProvider, MODEL_ROLES } = _require("src/core/models");

      return {
        // Make AI calls (auto-detects provider from model name)
        call: client.aiCall,
        callWithHistory: client.aiCallWithHistory,

        // Embeddings
        embed: async (text) => {
          const { embed } = _require("src/brain/embedder");
          return embed(text);
        },

        // Model utilities
        getModel,
        getEmbeddingModel,
        getModelConfig,
        detectProvider,
        MODEL_ROLES,

        // Token tracking
        setTokenTracker: client.setTokenTracker,
        getTrackerSnapshot: client.getTrackerSnapshot,
      };
    });
  },

  // ── Error Handling ──────────────────────────────────────────

  get errors() {
    return _lazy("errors", () => {
      const { parseError, classifyError } = _require("src/core/error-parser");
      const { route, getRoutePrompt } = _require("src/brain/tool-router");
      const { Notifier, HUMAN_REQUIRED_PATTERNS } = _require("src/notifications/notifier");
      const { LoopGuard } = _require("src/skills/loop-guard");

      return {
        // Parse error text → structured {file, line, message, errorType}
        parse: parseError,
        // Classify error → type (missing_module, syntax, runtime, etc.)
        classify: classifyError,
        // Map error type → recommended tool chain
        routeTools: route,
        getRoutePrompt,

        // Detect if error needs human vs can be auto-fixed
        HUMAN_REQUIRED_PATTERNS,
        createNotifier: (opts) => new Notifier(opts),

        // Loop detection — prevent infinite fix attempts
        createLoopGuard: (opts) => new LoopGuard(_projectRoot, opts),
      };
    });
  },

  // ── Backup & Recovery ───────────────────────────────────────

  get backup() {
    return _lazy("backup", () => {
      const { BackupManager } = _require("src/backup/backup-manager");
      const manager = new BackupManager(_projectRoot);

      return {
        create: (reason) => manager.createBackup(reason),
        rollback: (id) => manager.rollbackTo(id),
        rollbackLatest: () => manager.rollbackLatest(),
        undoRollback: () => manager.undoRollback(),
        list: () => manager.list(),
        getStats: () => manager.getStats(),
        promote: (id) => manager.promote(id),
        prune: () => manager.prune(),
        instance: manager,
      };
    });
  },

  // ── Skills ──────────────────────────────────────────────────

  get skills() {
    return _lazy("skills", () => {
      const { SkillRegistry } = _require("src/skills/skill-registry");
      const registry = new SkillRegistry();
      registry.load();

      return {
        // Skill registry
        match: (query) => registry.match(query),
        list: () => registry.getAll(),
        registry,

        // SQL injection protection
        get sql() {
          const { scanForInjection, deepScan, sqlGuard } = _require("src/skills/sql");
          return { scanForInjection, deepScan, sqlGuard };
        },

        // Dependency analysis
        get deps() {
          const deps = _require("src/skills/deps");
          return {
            diagnose: deps.diagnose,
            healthReport: deps.healthReport,
            getMigration: deps.getMigration,
          };
        },

        // Backup (alias)
        get backup() {
          const b = _require("src/skills/backup");
          return { backup: b.backup, rollback: b.rollback, rollbackLatest: b.rollbackLatest, undoRollback: b.undoRollback, listBackups: b.listBackups };
        },
      };
    });
  },

  // ── Monitoring ──────────────────────────────────────────────

  get monitor() {
    return _lazy("monitor", () => {
      const { ErrorMonitor } = _require("src/monitor/error-monitor");
      const { PerfMonitor } = _require("src/monitor/perf-monitor");
      const { ProcessMonitor } = _require("src/monitor/process-monitor");
      const { AdaptiveLimiter } = _require("src/monitor/adaptive-limiter");

      return {
        ErrorMonitor,
        PerfMonitor,
        ProcessMonitor,
        AdaptiveLimiter,
      };
    });
  },

  // ── Logging & Metrics ───────────────────────────────────────

  get logger() {
    return _lazy("logger", () => {
      const { EventLogger, EVENT_TYPES, SEVERITY } = _require("src/logger/event-logger");
      const { TokenTracker } = _require("src/logger/token-tracker");
      const { RepairHistory } = _require("src/logger/repair-history");

      return {
        createEventLogger: () => new EventLogger(_projectRoot),
        createTokenTracker: () => new TokenTracker(_projectRoot),
        createRepairHistory: () => new RepairHistory(_projectRoot),
        EVENT_TYPES,
        SEVERITY,
      };
    });
  },

  // ── Config ──────────────────────────────────────────────────

  get config() {
    return _lazy("config", () => {
      const { loadConfig, getConfig } = _require("src/core/config");
      return { load: loadConfig, get: getConfig };
    });
  },

  // ── Agent Engine ────────────────────────────────────────────

  get agent() {
    return _lazy("agent", () => {
      const { AgentEngine, TOOL_DEFINITIONS, BLOCKED_COMMANDS } = _require("src/agent/agent-engine");
      const { Sandbox } = _require("src/security/sandbox");

      return {
        // Create a sandboxed agent engine
        create: (opts = {}) => new AgentEngine({
          cwd: opts.cwd || _projectRoot,
          sandbox: opts.sandbox || new Sandbox(opts.cwd || _projectRoot),
          maxTurns: opts.maxTurns || 25,
          maxTokens: opts.maxTokens || 100000,
          logger: opts.logger,
          mcp: opts.mcp,
        }),
        TOOL_DEFINITIONS,
        BLOCKED_COMMANDS,
        AgentEngine,
      };
    });
  },

  // ── Server Context ──────────────────────────────────────────

  get context() {
    return _lazy("context", () => {
      const { scan, load, getSummary } = _require("src/core/server-context");
      return {
        scan: () => scan(_projectRoot),
        load: () => load(_projectRoot),
        getSummary: () => getSummary(_projectRoot),
      };
    });
  },

  // ── Verification ────────────────────────────────────────────

  get verify() {
    return _lazy("verify", () => {
      const { verifyFix, syntaxCheck, bootProbe } = _require("src/core/verifier");
      return { verifyFix, syntaxCheck, bootProbe };
    });
  },

  // ── MCP (Model Context Protocol) ───────────────────────────

  get mcp() {
    return _lazy("mcp", () => {
      const { McpRegistry } = _require("src/mcp/mcp-registry");
      return {
        create: (opts = {}) => new McpRegistry({
          projectRoot: _projectRoot,
          ...opts,
        }),
        McpRegistry,
      };
    });
  },

  // ── Convenience: all-in-one scan ───────────────────────────

  /**
   * Run a fast security scan on text (regex injection + secrets). Sync, no AI call.
   * For deep AI-powered injection scan, use api.security.detectInjection() (async).
   * Returns { safe, injection, secrets, redacted }.
   */
  scanText(text) {
    const sec = this.security;
    const injectionResult = sec.localScan(text);
    const hasSecretContent = sec.hasSecrets(text);
    const redacted = sec.redact(text);

    return {
      safe: injectionResult.safe !== false && !hasSecretContent,
      injection: injectionResult,
      secrets: hasSecretContent,
      redacted,
    };
  },

  /**
   * Diagnose an error: parse, classify, route tools, check if human-needed.
   * Returns { parsed, type, tools, humanRequired }.
   */
  diagnoseError(errorText) {
    const err = this.errors;
    const parsed = err.parse(errorText);
    const toolRoute = err.routeTools(parsed.errorType || "unknown");

    // Check if human required
    let humanRequired = false;
    for (const pattern of err.HUMAN_REQUIRED_PATTERNS) {
      if (pattern.test ? pattern.test(errorText) : errorText.includes(pattern)) {
        humanRequired = true;
        break;
      }
    }

    return {
      parsed,
      type: parsed.errorType,
      tools: toolRoute,
      humanRequired,
    };
  },

  /** Get the project root. */
  get projectRoot() { return _projectRoot; },

  /** Check if initialized. */
  get initialized() { return _initialized; },
};

module.exports = { init, api };
