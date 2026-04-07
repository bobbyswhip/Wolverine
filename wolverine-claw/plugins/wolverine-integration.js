/**
 * Wolverine Integration Plugin for OpenClaw
 *
 * Two integration layers:
 *
 * 1. TOOLS — 7 wolverine tools injected into the agent toolkit
 *    (backup, rollback, brain search/learn, health, self-heal)
 *
 * 2. HOOKS — taps into OpenClaw's 28-hook plugin system for deep
 *    error observability and self-healing triggers:
 *    - after_tool_call: catch skill/tool failures
 *    - agent_end: catch agent crashes and timeouts
 *    - before_tool_call: detect and report tool loops
 *    - message_sent: catch channel send failures
 *    - llm_output: catch provider errors, failovers, billing blocks
 *    - subagent_ended: catch subagent failures
 *    - gateway_start/gateway_stop: lifecycle tracking
 *    - session_end: session error tracking
 */

const path = require("path");
const fs = require("fs");

const PLUGIN_NAME = "wolverine-integration";

// ── Error tracking state ────────────────────────────────────────

const _errorCounts = {
  tool: 0,
  agent: 0,
  channel: 0,
  llm: 0,
  subagent: 0,
  total: 0,
};

const _recentErrors = []; // last 50 errors for context
const MAX_RECENT = 50;

function _trackError(category, summary, detail) {
  _errorCounts[category] = (_errorCounts[category] || 0) + 1;
  _errorCounts.total++;

  const entry = {
    category,
    summary: summary?.slice(0, 200),
    timestamp: Date.now(),
    detail: detail?.slice?.(0, 500),
  };
  _recentErrors.push(entry);
  if (_recentErrors.length > MAX_RECENT) _recentErrors.shift();

  return entry;
}

// ── Main registration ───────────────────────────────────────────

/**
 * Register the wolverine integration with the OpenClaw gateway.
 * Supports both Plugin SDK (api.registerPluginHook) and basic EventEmitter.
 */
async function register(gateway, config) {
  const projectRoot = path.resolve(__dirname, "../..");

  // Register wolverine tools
  const tools = buildWolverineTools(projectRoot, config);
  _registerTools(gateway, tools);

  // Register into OpenClaw Plugin SDK hooks (preferred)
  const api = _getPluginApi(gateway);
  if (api) {
    _registerPluginHooks(api, projectRoot, config);
    console.log("[CLAW] Wolverine plugin hooks registered (Plugin SDK)");
  }
  // Also register EventEmitter hooks (fallback / additional coverage)
  _registerEventHooks(gateway, projectRoot);

  // Periodic health reporting with error stats
  const healthInterval = setInterval(() => {
    reportToWolverine("claw_heartbeat", {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      errorCounts: { ..._errorCounts },
      timestamp: Date.now(),
    });
  }, 30000);

  if (gateway.on) {
    gateway.on("shutdown", () => clearInterval(healthInterval));
  }
}

// ── Plugin SDK Hooks ────────────────────────────────────────────

/**
 * Get the Plugin SDK API from the gateway (if available).
 */
function _getPluginApi(gateway) {
  // OpenClaw exposes plugin registration via multiple paths
  if (gateway.pluginApi) return gateway.pluginApi;
  if (gateway.api) return gateway.api;
  if (gateway.plugins?.api) return gateway.plugins.api;
  if (typeof gateway.registerPluginHook === "function") return gateway;
  return null;
}

/**
 * Register all wolverine hooks into the OpenClaw Plugin SDK.
 */
function _registerPluginHooks(api, projectRoot, config) {
  const registerHook = api.registerPluginHook || api.register;
  if (typeof registerHook !== "function") return;

  const reg = (name, handler, priority) => {
    try {
      registerHook.call(api, name, { handler, priority: priority || 100 });
    } catch (e) {
      // Hook not supported in this OpenClaw version — skip silently
      try {
        registerHook.call(api, name, handler);
      } catch {}
    }
  };

  // ── after_tool_call: catch skill and tool failures ──────────
  reg("after_tool_call", (event, ctx) => {
    if (!event) return;
    const hasError = event.error || event.status === "error" || event.exitCode;

    if (hasError) {
      const toolName = event.toolName || event.name || "unknown";
      const errorMsg = event.error?.message || event.error || event.stderr || "Tool failed";
      const entry = _trackError("tool", `Tool ${toolName} failed: ${errorMsg}`);

      console.error(`[CLAW] Tool error: ${toolName} — ${errorMsg.slice(0, 100)}`);

      // Skill errors are wrapped as tool errors — detect them
      const isSkill = toolName.includes("skill") || event.source === "skill";

      reportToWolverine("route_error", {
        path: `claw://tool/${toolName}`,
        method: isSkill ? "SKILL" : "TOOL",
        statusCode: 500,
        message: `${isSkill ? "Skill" : "Tool"} ${toolName}: ${errorMsg}`.slice(0, 500),
        stack: event.error?.stack || event.stderr || null,
        file: event.file || null,
        line: null,
        timestamp: Date.now(),
      });
    }
  });

  // ── agent_end: catch agent failures and timeouts ────────────
  reg("agent_end", (event, ctx) => {
    if (!event) return;
    const hasError = event.error || event.status === "error" || event.lifecycle === "error";

    if (hasError) {
      const reason = event.reason || event.error?.message || "Agent failed";
      const isTimeout = reason.includes("timeout") || event.reason === "timeout";
      const entry = _trackError("agent", `Agent ${isTimeout ? "timeout" : "error"}: ${reason}`);

      console.error(`[CLAW] Agent ${isTimeout ? "timeout" : "error"}: ${reason.slice(0, 100)}`);

      reportToWolverine("route_error", {
        path: "claw://agent",
        method: isTimeout ? "TIMEOUT" : "AGENT",
        statusCode: isTimeout ? 408 : 500,
        message: reason.slice(0, 500),
        stack: event.error?.stack || null,
        file: null,
        line: null,
        timestamp: Date.now(),
      });
    }
  });

  // ── before_tool_call: detect tool loops ─────────────────────
  reg("before_tool_call", (event, ctx) => {
    if (!event) return;

    // OpenClaw's loop detection may have already flagged this
    if (event.block || event.loopDetected) {
      const toolName = event.toolName || event.name || "unknown";
      const reason = event.blockReason || event.reason || "Loop detected";
      _trackError("tool", `Tool loop blocked: ${toolName} — ${reason}`);

      console.warn(`[CLAW] Tool loop blocked: ${toolName} — ${reason}`);

      reportToWolverine("claw_warning", {
        category: "tool_loop",
        tool: toolName,
        reason,
        timestamp: Date.now(),
      });
    }
  });

  // ── message_sent: catch channel send failures ───────────────
  reg("message_sent", (event, ctx) => {
    if (!event) return;
    const failed = event.success === false || event.error;

    if (failed) {
      const channel = event.channelId || event.channel || "unknown";
      const errorMsg = event.error?.message || event.error || "Send failed";
      _trackError("channel", `Channel ${channel}: ${errorMsg}`);

      console.error(`[CLAW] Channel send failed: ${channel} — ${errorMsg.slice(0, 100)}`);

      reportToWolverine("claw_warning", {
        category: "channel_failure",
        channel,
        error: errorMsg.slice(0, 500),
        timestamp: Date.now(),
      });
    }
  });

  // ── llm_output: catch provider errors and failovers ─────────
  reg("llm_output", (event, ctx) => {
    if (!event) return;
    const hasError = event.error || event.failover;

    if (hasError) {
      const provider = event.provider || event.model || "unknown";
      const reason = event.failoverReason || event.error?.message || event.error || "LLM error";
      const status = event.httpCode || event.status;
      _trackError("llm", `LLM ${provider}: ${reason} (${status || "?"})`);

      // Billing errors (402) are critical — stop healing
      const isBilling = status === 402 || reason.includes("billing");
      // Rate limits (429) are transient
      const isRateLimit = status === 429 || reason.includes("rate_limit");

      if (isBilling) {
        console.error(`[CLAW] BILLING ERROR: ${provider} — ${reason}`);
        reportToWolverine("claw_critical", {
          category: "billing",
          provider,
          error: reason.slice(0, 500),
          timestamp: Date.now(),
        });
      } else if (!isRateLimit) {
        // Don't spam wolverine with rate limit warnings
        console.warn(`[CLAW] LLM error: ${provider} — ${reason.slice(0, 100)}`);
        reportToWolverine("claw_warning", {
          category: "llm_error",
          provider,
          status,
          error: reason.slice(0, 500),
          timestamp: Date.now(),
        });
      }
    }
  });

  // ── subagent_ended: catch subagent failures ─────────────────
  reg("subagent_ended", (event, ctx) => {
    if (!event) return;
    const failed = event.status === "error" || event.status === "timeout" || event.error;

    if (failed) {
      const agentId = event.subagentId || event.runId || "unknown";
      const errorMsg = event.error?.message || event.error || `Subagent ${event.status}`;
      _trackError("subagent", `Subagent ${agentId}: ${errorMsg}`);

      console.error(`[CLAW] Subagent failed: ${agentId} — ${errorMsg.slice(0, 100)}`);

      reportToWolverine("route_error", {
        path: `claw://subagent/${agentId}`,
        method: "SUBAGENT",
        statusCode: 500,
        message: errorMsg.slice(0, 500),
        stack: event.error?.stack || null,
        file: null,
        line: null,
        timestamp: Date.now(),
      });
    }
  });

  // ── gateway_start: lifecycle tracking ───────────────────────
  reg("gateway_start", (event, ctx) => {
    console.log("[CLAW] OpenClaw gateway started — wolverine watching");
    reportToWolverine("claw_health", {
      status: "running",
      detail: "gateway_start",
      timestamp: Date.now(),
    });
  });

  // ── gateway_stop: lifecycle tracking ────────────────────────
  reg("gateway_stop", (event, ctx) => {
    console.log("[CLAW] OpenClaw gateway stopping");
    reportToWolverine("claw_health", {
      status: "stopping",
      detail: "gateway_stop",
      errorCounts: { ..._errorCounts },
      timestamp: Date.now(),
    });
  });

  // ── session_end: track session errors ───────────────────────
  reg("session_end", (event, ctx) => {
    if (event?.error) {
      console.warn(`[CLAW] Session error: ${event.error?.message || event.error}`);
    }
  });
}

// ── EventEmitter fallback hooks ─────────────────────────────────

/**
 * Register basic EventEmitter hooks (works with all versions).
 */
function _registerEventHooks(gateway, projectRoot) {
  if (!gateway.on) return;

  gateway.on("error", (err) => {
    const msg = err?.message || String(err);
    _trackError("agent", `Gateway error: ${msg}`);
    console.error(`[CLAW] Gateway error: ${msg}`);

    reportToWolverine("route_error", {
      path: "claw://gateway",
      method: "INTERNAL",
      statusCode: 500,
      message: msg.slice(0, 500),
      stack: err?.stack || null,
      file: null,
      line: null,
      timestamp: Date.now(),
    });
  });

  // These may or may not exist depending on OpenClaw version
  const optionalEvents = ["agent:error", "skill:error", "channel:error", "channel:disconnect"];
  for (const evt of optionalEvents) {
    try {
      gateway.on(evt, (err) => {
        const msg = err?.message || String(err);
        const category = evt.split(":")[0];
        _trackError(category === "skill" ? "tool" : "agent", `${evt}: ${msg}`);
        console.error(`[CLAW] ${evt}: ${msg.slice(0, 100)}`);
      });
    } catch {}
  }
}

// ── Tool registration ───────────────────────────────────────────

function _registerTools(gateway, tools) {
  if (gateway.registerTools) {
    gateway.registerTools(PLUGIN_NAME, tools);
  } else if (gateway.addTools) {
    gateway.addTools(tools);
  } else if (gateway.skills?.register) {
    gateway.skills.register(PLUGIN_NAME, {
      description: "Wolverine self-healing integration — backup, brain, health, and error pipeline",
      tools,
    });
  }
}

// ── Wolverine tools for the agent ───────────────────────────────

function buildWolverineTools(projectRoot, config) {
  return [
    {
      name: "wolverine_backup",
      description: "Create a backup snapshot of the claw workspace",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Reason for backup" },
        },
        required: ["reason"],
      },
      execute: async ({ reason }) => {
        try {
          const { BackupManager } = require(path.join(projectRoot, "src/backup/backup-manager"));
          const manager = new BackupManager(projectRoot);
          const id = manager.createBackup(`claw: ${reason}`);
          return `Backup created: ${id}`;
        } catch (err) {
          return `[ERROR] Backup failed: ${err.message}`;
        }
      },
    },
    {
      name: "wolverine_rollback",
      description: "Rollback workspace to a previous backup",
      parameters: {
        type: "object",
        properties: {
          backupId: { type: "string", description: "Backup ID to rollback to (or 'latest')" },
        },
        required: ["backupId"],
      },
      execute: async ({ backupId }) => {
        try {
          const { BackupManager } = require(path.join(projectRoot, "src/backup/backup-manager"));
          const manager = new BackupManager(projectRoot);
          if (backupId === "latest") {
            const result = manager.rollbackLatest();
            return result.success ? `Rolled back to latest backup` : `Rollback failed: ${result.error}`;
          }
          const result = manager.rollback(backupId);
          return result.success ? `Rolled back to ${backupId}` : `Rollback failed: ${result.error}`;
        } catch (err) {
          return `[ERROR] Rollback failed: ${err.message}`;
        }
      },
    },
    {
      name: "wolverine_brain_search",
      description: "Search wolverine's semantic memory for relevant context (past fixes, patterns, learnings)",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
      execute: async ({ query, limit }) => {
        try {
          const { Brain } = require(path.join(projectRoot, "src/brain/brain"));
          const brain = new Brain(projectRoot);
          await brain.init();
          const results = await brain.search(query, { limit: limit || 5 });
          if (!results || results.length === 0) return "No relevant memories found.";
          return results.map((r, i) => `${i + 1}. [${r.score?.toFixed(2) || "?"}] ${r.content?.slice(0, 200) || r.text?.slice(0, 200)}`).join("\n");
        } catch (err) {
          return `[ERROR] Brain search failed: ${err.message}`;
        }
      },
    },
    {
      name: "wolverine_brain_learn",
      description: "Store a new learning in wolverine's brain memory",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "What was learned" },
          category: { type: "string", description: "Category: fix, pattern, warning, optimization" },
        },
        required: ["content"],
      },
      execute: async ({ content, category }) => {
        try {
          const { Brain } = require(path.join(projectRoot, "src/brain/brain"));
          const brain = new Brain(projectRoot);
          await brain.init();
          await brain.addDocument({
            content,
            namespace: category || "learnings",
            source: "wolverine-claw",
            timestamp: Date.now(),
          });
          return "Learning stored in brain.";
        } catch (err) {
          return `[ERROR] Brain learn failed: ${err.message}`;
        }
      },
    },
    {
      name: "wolverine_health",
      description: "Get wolverine system health status including error tracking from all OpenClaw subsystems",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const status = {
          uptime: `${Math.floor(process.uptime())}s`,
          memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
          pid: process.pid,
          nodeVersion: process.version,
          errors: { ..._errorCounts },
          recentErrors: _recentErrors.slice(-5).map(e => `[${e.category}] ${e.summary}`),
        };

        try {
          const { BackupManager } = require(path.join(projectRoot, "src/backup/backup-manager"));
          const manager = new BackupManager(projectRoot);
          const stats = manager.getStats();
          status.backups = `${stats.total} total (${stats.stable} stable)`;
        } catch {}

        return JSON.stringify(status, null, 2);
      },
    },
    {
      name: "wolverine_list_backups",
      description: "List all available workspace backups",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        try {
          const { BackupManager } = require(path.join(projectRoot, "src/backup/backup-manager"));
          const manager = new BackupManager(projectRoot);
          const backups = manager.list();
          if (!backups || backups.length === 0) return "No backups found.";
          return backups.map(b => `${b.id} — ${b.reason || "manual"} (${b.status || "unknown"}) ${b.timestamp || ""}`).join("\n");
        } catch (err) {
          return `[ERROR] List backups failed: ${err.message}`;
        }
      },
    },
    {
      name: "wolverine_self_heal",
      description: "Trigger wolverine's self-healing pipeline on a specific error",
      parameters: {
        type: "object",
        properties: {
          error: { type: "string", description: "Error message or stack trace" },
          file: { type: "string", description: "File where error occurred (optional)" },
        },
        required: ["error"],
      },
      execute: async ({ error, file }) => {
        reportToWolverine("route_error", {
          path: "claw://agent",
          method: "INTERNAL",
          statusCode: 500,
          message: error.slice(0, 500),
          stack: error,
          file: file || null,
          line: null,
          timestamp: Date.now(),
        });
        return "Error reported to wolverine healing pipeline.";
      },
    },
    {
      name: "wolverine_error_stats",
      description: "Get error statistics from all OpenClaw subsystems (tools, agent, channels, LLM, subagents)",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        return JSON.stringify({
          counts: { ..._errorCounts },
          recent: _recentErrors.slice(-10),
        }, null, 2);
      },
    },
  ];
}

/**
 * Report to wolverine parent process via IPC.
 */
function reportToWolverine(type, data) {
  if (typeof process.send === "function") {
    try {
      process.send({ type, ...data });
    } catch {}
  }
}

module.exports = { register, PLUGIN_NAME };
