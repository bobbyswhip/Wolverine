/**
 * Model Pricing — accurate per-million-token costs for all supported models.
 *
 * Includes: input, output, cache_write (1.25x input), cache_read (0.1x input)
 * for Anthropic models that support prompt caching.
 *
 * Users can override in .wolverine/pricing.json.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_PRICING = {
  // ── OpenAI GPT-5.x Family ──
  "gpt-5.4":              { input: 2.50,  output: 15.00 },
  "gpt-5.4-mini":         { input: 0.75,  output: 4.50 },
  "gpt-5.4-nano":         { input: 0.20,  output: 1.25 },
  "gpt-5-nano":           { input: 0.15,  output: 1.00 },

  // ── OpenAI GPT-4o Family ──
  "gpt-4o":               { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":          { input: 0.15,  output: 0.60 },

  // ── OpenAI O-series Reasoning ──
  "o1":                   { input: 15.00, output: 60.00 },
  "o1-mini":              { input: 3.00,  output: 12.00 },
  "o3":                   { input: 20.00, output: 80.00 },
  "o3-mini":              { input: 4.00,  output: 16.00 },
  "o4-mini":              { input: 1.10,  output: 4.40 },
  "o4-mini-deep-research": { input: 2.00, output: 8.00 },

  // ── OpenAI Codex ──
  "gpt-5.3-codex":        { input: 2.50,  output: 10.00 },
  "gpt-5.1-codex-mini":   { input: 1.50,  output: 6.00 },
  "codex-mini-latest":    { input: 1.50,  output: 6.00 },

  // ── OpenAI Embeddings ──
  "text-embedding-3-small": { input: 0.02,  output: 0.00 },
  "text-embedding-3-large": { input: 0.13,  output: 0.00 },

  // ── Anthropic Claude 4 Family (with cache pricing) ──
  // cache_write = 1.25x input, cache_read = 0.1x input
  "claude-opus-4":        { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  "claude-sonnet-4":      { input: 3.00,  output: 15.00, cache_write: 3.75,  cache_read: 0.30 },
  "claude-haiku-4":       { input: 0.80,  output: 4.00,  cache_write: 1.00,  cache_read: 0.08 },

  // ── Anthropic Claude 3.5 Family ──
  "claude-3-5-sonnet":    { input: 3.00,  output: 15.00, cache_write: 3.75,  cache_read: 0.30 },
  "claude-3-5-haiku":     { input: 0.80,  output: 4.00,  cache_write: 1.00,  cache_read: 0.08 },

  // ── Anthropic Claude 3 Family ──
  "claude-3-opus":        { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  "claude-3-sonnet":      { input: 3.00,  output: 15.00, cache_write: 3.75,  cache_read: 0.30 },
  "claude-3-haiku":       { input: 0.25,  output: 1.25,  cache_write: 0.3125, cache_read: 0.025 },

  // ── Fallback ──
  "_default":             { input: 1.00,  output: 4.00 },
};

let _customPricing = null;

/**
 * Get pricing for a model. Checks custom overrides, then exact match, then prefix match.
 * Returns { input, output, cache_write?, cache_read? } in USD per million tokens.
 */
function getModelPricing(modelName) {
  if (_customPricing && _customPricing[modelName]) return _customPricing[modelName];
  if (DEFAULT_PRICING[modelName]) return DEFAULT_PRICING[modelName];

  // Prefix matching: "claude-sonnet-4-6" → "claude-sonnet-4"
  for (const [key, val] of Object.entries(DEFAULT_PRICING)) {
    if (key !== "_default" && modelName.startsWith(key)) return val;
  }
  return DEFAULT_PRICING._default;
}

/**
 * Calculate cost in USD including cache tokens.
 *
 * @param {string} modelName
 * @param {number} inputTokens — regular input tokens
 * @param {number} outputTokens — output tokens
 * @param {number} cacheCreationTokens — tokens written to cache (1.25x input price)
 * @param {number} cacheReadTokens — tokens read from cache (0.1x input price)
 */
function calculateCost(modelName, inputTokens, outputTokens, cacheCreationTokens = 0, cacheReadTokens = 0) {
  const pricing = getModelPricing(modelName);
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheWriteCost = pricing.cache_write
    ? (cacheCreationTokens / 1_000_000) * pricing.cache_write
    : (cacheCreationTokens / 1_000_000) * pricing.input * 1.25;
  const cacheReadCost = pricing.cache_read
    ? (cacheReadTokens / 1_000_000) * pricing.cache_read
    : (cacheReadTokens / 1_000_000) * pricing.input * 0.1;

  return {
    input: inputCost,
    output: outputCost,
    cacheWrite: cacheWriteCost,
    cacheRead: cacheReadCost,
    total: inputCost + outputCost + cacheWriteCost + cacheReadCost,
    cacheSavings: cacheReadTokens > 0 ? ((cacheReadTokens / 1_000_000) * (pricing.input - (pricing.cache_read || pricing.input * 0.1))) : 0,
  };
}

function loadCustomPricing(projectRoot) {
  const pricingPath = path.join(projectRoot, ".wolverine", "pricing.json");
  if (fs.existsSync(pricingPath)) {
    try { _customPricing = JSON.parse(fs.readFileSync(pricingPath, "utf-8")); } catch {}
  }
}

module.exports = { getModelPricing, calculateCost, loadCustomPricing, DEFAULT_PRICING };
