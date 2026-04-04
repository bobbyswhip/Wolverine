/**
 * Model Configuration — hybrid-always architecture.
 *
 * No provider selection. Users pick the best model for each of the 8 task
 * roles directly in settings.json. Provider is auto-detected from model name.
 * Embedding is separate — always billed through wolverine credits.
 *
 * Mix and match: wolverine for audit, claude for reasoning, gpt for coding.
 */

function detectProvider(model) {
  if (!model) return "openai";
  if (/^wolverine/i.test(model) || /^gemma/i.test(model)) return "wolverine";
  if (/^claude/i.test(model) || /^anthropic/i.test(model)) return "anthropic";
  if (/^gemini/i.test(model) || /^google/i.test(model)) return "google";
  if (/^mistral/i.test(model) || /^codestral/i.test(model) || /^pixtral/i.test(model)) return "mistral";
  if (/^llama/i.test(model) || /^meta/i.test(model)) return "meta";
  if (/^deepseek/i.test(model)) return "deepseek";
  if (/^command/i.test(model) || /^cohere/i.test(model)) return "cohere";
  return "openai";
}

// 8 task-specific model roles (embedding is separate)
const MODEL_ROLES = {
  reasoning: {
    envKey: "REASONING_MODEL",
    default: "gpt-4o",
    description: "Deep analysis and complex multi-step debugging",
  },
  coding: {
    envKey: "CODING_MODEL",
    default: "gpt-4o",
    description: "Code repair and fix generation (no tools)",
  },
  chat: {
    envKey: "CHAT_MODEL",
    default: "gpt-4o-mini",
    description: "Summaries, explanations, and user-facing messages",
  },
  audit: {
    envKey: "AUDIT_MODEL",
    default: "gpt-4o-mini",
    description: "Security scanning and prompt injection detection",
  },
  compacting: {
    envKey: "COMPACTING_MODEL",
    default: "gpt-4o-mini",
    description: "Text compaction before brain embedding",
  },
  tool: {
    envKey: "TOOL_MODEL",
    default: "gpt-4o-mini",
    description: "Agent with tool calling (read_file, write_file, bash_exec)",
  },
  classifier: {
    envKey: "CLASSIFIER_MODEL",
    default: "gpt-4o-mini",
    description: "Error classification and command routing",
  },
  research: {
    envKey: "RESEARCH_MODEL",
    default: "gpt-4o",
    description: "Deep research for error solutions",
  },
};

/**
 * Get the configured model for a task role.
 */
function getModel(role) {
  // Legacy: "embedding" and "utility" still supported
  if (role === "embedding") return getEmbeddingModel();
  if (role === "utility") role = "compacting";

  const config = MODEL_ROLES[role];
  if (!config) {
    throw new Error(`Unknown model role: "${role}". Valid roles: ${Object.keys(MODEL_ROLES).join(", ")}`);
  }
  const { getConfig } = require("./config");
  return process.env[config.envKey] || getConfig(`models.${role}`) || config.default;
}

/**
 * Get the embedding model — separate from task roles.
 * Always billed through wolverine credits.
 */
function getEmbeddingModel() {
  const { getConfig } = require("./config");
  return process.env.TEXT_EMBEDDING_MODEL || getConfig("embedding") || "wolverine-embedding-1";
}

/**
 * Get all model assignments for logging.
 */
function getModelConfig() {
  const config = {};
  for (const [role, def] of Object.entries(MODEL_ROLES)) {
    const resolved = getModel(role);
    const fromEnv = !!process.env[def.envKey];
    const fromDefault = resolved === def.default;
    config[role] = {
      model: resolved,
      source: fromEnv ? "env" : fromDefault ? "default" : "settings",
    };
  }
  // Add embedding separately
  const embModel = getEmbeddingModel();
  config.embedding = {
    model: embModel,
    source: process.env.TEXT_EMBEDDING_MODEL ? "env" : embModel === "wolverine-embedding-1" ? "default" : "settings",
  };
  return config;
}

function logModelConfig(chalk) {
  const config = getModelConfig();
  for (const [role, info] of Object.entries(config)) {
    const provider = detectProvider(info.model);
    const provColors = { wolverine: "cyan", anthropic: "yellow", openai: "blue", google: "green" };
    const color = provColors[provider] || "gray";
    const label = `${role.padEnd(10)} → ${info.model}`;
    const source = info.source === "env" ? "(env)" : info.source === "default" ? "" : "(settings)";
    console.log(chalk[color](`    ${label} ${source}`));
  }
}

module.exports = { getModel, getEmbeddingModel, getModelConfig, logModelConfig, MODEL_ROLES, detectProvider };
