/**
 * Model Configuration — centralized model selection for every AI task.
 *
 * Supports both OpenAI and Anthropic models. Provider is auto-detected from model name:
 *   claude-*  → Anthropic
 *   gpt-*, o1-*, o3-*, text-embedding-* → OpenAI
 *
 * Users configure models in .env.local or server/config/settings.json.
 * Mix and match providers per role (e.g., Anthropic for reasoning, OpenAI for coding).
 */

/**
 * Detect provider from model name.
 * @returns {"anthropic"|"openai"}
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
  // Default: OpenAI (gpt-*, o1-*, o3-*, o4-*, codex-*, text-embedding-*, dall-e-*, etc.)
  return "openai";
}

const MODEL_ROLES = {
  // Deep reasoning — used for multi-step debugging when a simple fix fails
  reasoning: {
    envKey: "REASONING_MODEL",
    default: "gpt-5.4",
    description: "Deep analysis and complex multi-step debugging",
    tier: "premium",
  },

  // Code generation — the main repair model
  coding: {
    envKey: "CODING_MODEL",
    default: "gpt-5.3-codex",
    description: "Code repair and fix generation",
    tier: "premium",
  },

  // Chat/explanation — used for generating human-readable explanations
  chat: {
    envKey: "CHAT_MODEL",
    default: "gpt-5.4-mini",
    description: "Explanations, summaries, and user-facing messages",
    tier: "standard",
  },

  // Security audit — injection detection, runs on every single error
  audit: {
    envKey: "AUDIT_MODEL",
    default: "gpt-5.4-nano",
    description: "Security scanning and prompt injection detection",
    tier: "economy",
  },

  // Compacting — compresses text before embedding into brain
  utility: {
    envKey: "COMPACTING_MODEL",
    default: "gpt-5.4-nano",
    description: "Text compaction before brain embedding",
    tier: "economy",
  },

  // Tool — chat responses that use function calling (call_endpoint, search_brain)
  tool: {
    envKey: "TOOL_MODEL",
    default: "gpt-4o-mini",
    description: "Chat with tool calling (must support function calling)",
    tier: "standard",
  },

  // Classifier — routes commands to CHAT vs AGENT, picks tiers
  classifier: {
    envKey: "CLASSIFIER_MODEL",
    default: "gpt-4o-mini",
    description: "Command routing and classification (CHAT/AGENT, SMALL/MEDIUM/LARGE)",
    tier: "economy",
  },

  // Research — deep research for solutions when fixes fail
  research: {
    envKey: "RESEARCH_MODEL",
    default: "gpt-4o",
    description: "Deep research for error solutions and documentation lookup",
    tier: "premium",
  },

  // Embedding — vector representations for semantic search
  embedding: {
    envKey: "TEXT_EMBEDDING_MODEL",
    default: "text-embedding-3-small",
    description: "Text embeddings for brain vector store",
    tier: "economy",
  },
};

/**
 * Get the configured model for a given role.
 */
function getModel(role) {
  const config = MODEL_ROLES[role];
  if (!config) {
    throw new Error(`Unknown model role: "${role}". Valid roles: ${Object.keys(MODEL_ROLES).join(", ")}`);
  }
  // Priority: env var → wolverine.config.js → hardcoded default
  const { getConfig } = require("./config");
  return process.env[config.envKey] || getConfig(`models.${role}`) || config.default;
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
      tier: def.tier,
    };
  }
  return config;
}

/**
 * Log the current model configuration.
 */
function logModelConfig(chalk) {
  const config = getModelConfig();
  const tierColors = { premium: "cyan", standard: "blue", economy: "gray" };

  for (const [role, info] of Object.entries(config)) {
    const color = tierColors[info.tier] || "white";
    const label = `${role.padEnd(10)} → ${info.model}`;
    const source = info.source === "env" ? "(custom)" : "(default)";
    console.log(chalk[color](`    ${label} ${source}`));
  }
}

module.exports = { getModel, getModelConfig, logModelConfig, MODEL_ROLES, detectProvider };
