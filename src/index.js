// Wolverine Node.js — Public API

const { heal } = require("./core/wolverine");
const { WolverineRunner } = require("./core/runner");
const { requestRepair } = require("./core/ai-client");
const { parseError } = require("./core/error-parser");
const { getModel, getModelConfig, MODEL_ROLES } = require("./core/models");
const { applyPatch } = require("./core/patcher");
const { verifyFix } = require("./core/verifier");
const { HealthMonitor } = require("./core/health-monitor");
const { Sandbox, SandboxViolationError } = require("./security/sandbox");
const { RateLimiter } = require("./security/rate-limiter");
const { detectInjection } = require("./security/injection-detector");
const { SecretRedactor } = require("./security/secret-redactor");
const { AdminAuth } = require("./security/admin-auth");
const { BackupManager } = require("./backup/backup-manager");
const { EventLogger, EVENT_TYPES, SEVERITY } = require("./logger/event-logger");
const { TokenTracker } = require("./logger/token-tracker");
const { AgentEngine } = require("./agent/agent-engine");
const { ResearchAgent } = require("./agent/research-agent");
const { GoalLoop } = require("./agent/goal-loop");
const { McpRegistry } = require("./mcp/mcp-registry");
const { McpSecurity } = require("./mcp/mcp-security");
const { PerfMonitor } = require("./monitor/perf-monitor");
const { DashboardServer } = require("./dashboard/server");
const { Notifier } = require("./notifications/notifier");
const { Brain } = require("./brain/brain");
const { VectorStore } = require("./brain/vector-store");
const { embed, embedBatch, compact } = require("./brain/embedder");
const { scanProject } = require("./brain/function-map");
const { sqlGuard, SafeDB, scanForInjection } = require("./skills/sql");

module.exports = {
  // Core
  heal,
  WolverineRunner,
  requestRepair,
  parseError,
  applyPatch,
  verifyFix,
  HealthMonitor,
  // Models
  getModel,
  getModelConfig,
  MODEL_ROLES,
  // Security
  Sandbox,
  SandboxViolationError,
  RateLimiter,
  detectInjection,
  SecretRedactor,
  AdminAuth,
  // Backup
  BackupManager,
  // Logger
  EventLogger,
  EVENT_TYPES,
  SEVERITY,
  TokenTracker,
  // Agent
  AgentEngine,
  ResearchAgent,
  GoalLoop,
  McpRegistry,
  McpSecurity,
  // Monitor
  PerfMonitor,
  // Dashboard
  DashboardServer,
  // Notifications
  Notifier,
  // Brain
  Brain,
  VectorStore,
  embed,
  embedBatch,
  compact,
  scanProject,
  // Skills
  sqlGuard,
  SafeDB,
  scanForInjection,
};
