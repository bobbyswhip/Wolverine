/**
 * Model Configuration — centralized model selection for every AI task.
 *
 * Users configure models in .env.local to optimize spend:
 *
 *   REASONING_MODEL   — Deep analysis, complex debugging (most expensive, most capable)
 *   CODING_MODEL      — Code repair generation (important, needs strong coding ability)
 *   CHAT_MODEL        — Explanations, summaries (good but cheaper)
 *   AUDIT_MODEL       — Security scans, injection detection (runs on every error)
 *   UTILITY_MODEL     — JSON formatting, regex validation, simple classification (cheapest)
 *
 * Defaults use gpt-4o tiers. Users can swap in any OpenAI-compatible model.
 */

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
  return process.env[config.envKey] || config.default;
}

/**
 * Get all model assignments for logging.
 */
function getModelConfig() {
  const config = {};
  for (const [role, def] of Object.entries(MODEL_ROLES)) {
    config[role] = {
      model: process.env[def.envKey] || def.default,
      source: process.env[def.envKey] ? "env" : "default",
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

module.exports = { getModel, getModelConfig, logModelConfig, MODEL_ROLES };
