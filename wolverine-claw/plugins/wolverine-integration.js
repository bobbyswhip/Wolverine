/**
 * Wolverine Integration Plugin for OpenClaw
 *
 * Gives the claw agent access to wolverine's self-healing capabilities:
 * - Brain: semantic memory, project context, and learning
 * - Backup: workspace snapshots and rollback
 * - Healing: error diagnosis and auto-fix pipeline
 * - Health: process monitoring and status reporting
 *
 * This plugin registers as an OpenClaw skill/extension, adding wolverine-specific
 * tools to the agent's toolkit.
 */

const path = require("path");
const fs = require("fs");

const PLUGIN_NAME = "wolverine-integration";

/**
 * Register the wolverine integration with the OpenClaw gateway.
 */
async function register(gateway, config) {
  const projectRoot = path.resolve(__dirname, "../..");

  // Register wolverine tools as OpenClaw tools/skills
  const tools = buildWolverineTools(projectRoot, config);

  if (gateway.registerTools) {
    gateway.registerTools(PLUGIN_NAME, tools);
  } else if (gateway.addTools) {
    gateway.addTools(tools);
  } else if (gateway.skills?.register) {
    gateway.skills.register(PLUGIN_NAME, {
      description: "Wolverine self-healing integration — backup, brain, and health tools",
      tools,
    });
  }

  // Hook into gateway events for self-healing
  if (gateway.on) {
    gateway.on("error", (err) => handleGatewayError(err, projectRoot));
    gateway.on("agent:error", (err) => handleAgentError(err, projectRoot));
    gateway.on("skill:error", (err) => handleSkillError(err, projectRoot));
  }

  // Periodic health reporting
  const healthInterval = setInterval(() => {
    reportToWolverine("claw_heartbeat", {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: Date.now(),
    });
  }, 30000);

  // Cleanup on shutdown
  if (gateway.on) {
    gateway.on("shutdown", () => clearInterval(healthInterval));
  }
}

/**
 * Build wolverine-specific tools for the OpenClaw agent.
 */
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
      description: "Get wolverine system health status (process, memory, backups, heal history)",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const status = {
          uptime: `${Math.floor(process.uptime())}s`,
          memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
          pid: process.pid,
          nodeVersion: process.version,
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
        // Report to parent wolverine process for healing
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
  ];
}

/**
 * Handle gateway errors — report to wolverine for healing.
 */
function handleGatewayError(err, projectRoot) {
  console.error(`[CLAW] Gateway error: ${err.message}`);
  reportToWolverine("route_error", {
    path: "claw://gateway",
    method: "INTERNAL",
    statusCode: 500,
    message: err.message,
    stack: err.stack,
    file: null,
    line: null,
    timestamp: Date.now(),
  });
}

/**
 * Handle agent errors.
 */
function handleAgentError(err, projectRoot) {
  console.error(`[CLAW] Agent error: ${err.message}`);
  reportToWolverine("route_error", {
    path: "claw://agent",
    method: "INTERNAL",
    statusCode: 500,
    message: err.message,
    stack: err.stack,
    file: null,
    line: null,
    timestamp: Date.now(),
  });
}

/**
 * Handle skill errors.
 */
function handleSkillError(err, projectRoot) {
  console.warn(`[CLAW] Skill error (non-fatal): ${err.message}`);
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
