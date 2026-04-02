/**
 * Model Pricing — maps model names to per-million-token costs.
 *
 * Users can override in .wolverine/pricing.json. Defaults based on
 * OpenAI published pricing as of April 2026.
 *
 * All values are USD per 1 million tokens.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_PRICING = {
  // GPT-5.4 family
  "gpt-5.4":        { input: 2.50,  output: 15.00 },
  "gpt-5.4-mini":   { input: 0.75,  output: 4.50 },
  "gpt-5.4-nano":   { input: 0.20,  output: 1.25 },

  // GPT-5 family (estimated from 5.4 pricing)
  "gpt-5-nano":     { input: 0.15,  output: 1.00 },

  // GPT-4o family
  "gpt-4o":         { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":    { input: 0.15,  output: 0.60 },

  // O-series reasoning
  "o4-mini":                { input: 1.10,  output: 4.40 },
  "o4-mini-deep-research":  { input: 2.00,  output: 8.00 },

  // Codex
  "gpt-5.1-codex-mini":    { input: 1.50,  output: 6.00 },
  "codex-mini-latest":      { input: 1.50,  output: 6.00 },
  "gpt-5.3-codex":         { input: 2.50,  output: 10.00 },

  // Embeddings
  "text-embedding-3-small": { input: 0.02,  output: 0.00 },
  "text-embedding-3-large": { input: 0.13,  output: 0.00 },

  // Anthropic Claude family
  "claude-opus-4":          { input: 15.00, output: 75.00 },
  "claude-sonnet-4":        { input: 3.00,  output: 15.00 },
  "claude-haiku-4":         { input: 0.80,  output: 4.00 },
  "claude-3-5-sonnet":      { input: 3.00,  output: 15.00 },
  "claude-3-5-haiku":       { input: 0.80,  output: 4.00 },
  "claude-3-opus":          { input: 15.00, output: 75.00 },
  "claude-3-sonnet":        { input: 3.00,  output: 15.00 },
  "claude-3-haiku":         { input: 0.25,  output: 1.25 },

  // Fallback for unknown models
  "_default":               { input: 1.00,  output: 4.00 },
};

let _customPricing = null;

/**
 * Get pricing for a model. Checks custom overrides first, then defaults.
 * Returns { input, output } in USD per million tokens.
 */
function getModelPricing(modelName) {
  // Check custom pricing
  if (_customPricing && _customPricing[modelName]) {
    return _customPricing[modelName];
  }

  // Check defaults — try exact match, then prefix match
  if (DEFAULT_PRICING[modelName]) {
    return DEFAULT_PRICING[modelName];
  }

  // Prefix matching: "gpt-5.4-mini-2026-03" → "gpt-5.4-mini"
  for (const [key, val] of Object.entries(DEFAULT_PRICING)) {
    if (key !== "_default" && modelName.startsWith(key)) {
      return val;
    }
  }

  return DEFAULT_PRICING._default;
}

/**
 * Calculate cost in USD for a given model and token counts.
 */
function calculateCost(modelName, inputTokens, outputTokens) {
  const pricing = getModelPricing(modelName);
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return {
    input: inputCost,
    output: outputCost,
    total: inputCost + outputCost,
  };
}

/**
 * Load custom pricing overrides from .wolverine/pricing.json.
 */
function loadCustomPricing(projectRoot) {
  const pricingPath = path.join(projectRoot, ".wolverine", "pricing.json");
  if (fs.existsSync(pricingPath)) {
    try {
      _customPricing = JSON.parse(fs.readFileSync(pricingPath, "utf-8"));
    } catch {}
  }
}

module.exports = { getModelPricing, calculateCost, loadCustomPricing, DEFAULT_PRICING };
