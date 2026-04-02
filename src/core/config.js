const fs = require("fs");
const path = require("path");

/**
 * Config Loader — reads wolverine.config.js, falls back to env vars.
 *
 * Priority:
 * 1. Environment variables (highest — for CI/Docker overrides)
 * 2. wolverine.config.js (project settings)
 * 3. Hardcoded defaults (lowest)
 */

let _config = null;

function loadConfig() {
  if (_config) return _config;

  // Load from server/config/settings.json
  const configPath = path.join(process.cwd(), "server", "config", "settings.json");
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (err) {
      console.log(`  ⚠️  Failed to load server/config/settings.json: ${err.message}`);
    }
  }

  _config = {
    models: {
      reasoning:  process.env.REASONING_MODEL    || fileConfig.models?.reasoning  || "gpt-4o",
      coding:     process.env.CODING_MODEL       || fileConfig.models?.coding     || "gpt-4o",
      chat:       process.env.CHAT_MODEL         || fileConfig.models?.chat       || "gpt-4o-mini",
      tool:       process.env.TOOL_MODEL         || fileConfig.models?.tool       || "gpt-4o-mini",
      classifier: process.env.CLASSIFIER_MODEL   || fileConfig.models?.classifier || "gpt-4o-mini",
      audit:      process.env.AUDIT_MODEL        || fileConfig.models?.audit      || "gpt-4o-mini",
      compacting: process.env.COMPACTING_MODEL   || fileConfig.models?.compacting || "gpt-4o-mini",
      research:   process.env.RESEARCH_MODEL     || fileConfig.models?.research   || "gpt-4o",
      embedding:  process.env.TEXT_EMBEDDING_MODEL || fileConfig.models?.embedding || "text-embedding-3-small",
    },

    server: {
      port:        parseInt(process.env.PORT, 10)                    || fileConfig.server?.port        || 3000,
      maxRetries:  parseInt(process.env.WOLVERINE_MAX_RETRIES, 10)   || fileConfig.server?.maxRetries  || 3,
      maxMemoryMB: parseInt(process.env.WOLVERINE_MAX_MEMORY_MB, 10) || fileConfig.server?.maxMemoryMB || 512,
    },

    telemetry: {
      enabled:            process.env.WOLVERINE_TELEMETRY !== "false" && (fileConfig.telemetry?.enabled !== false),
      heartbeatIntervalMs: parseInt(process.env.WOLVERINE_HEARTBEAT_INTERVAL_MS, 10) || fileConfig.telemetry?.heartbeatIntervalMs || 60000,
      platformUrl:        process.env.WOLVERINE_PLATFORM_URL || fileConfig.telemetry?.platformUrl || "https://api.wolverinenode.xyz",
    },

    rateLimiting: {
      maxCallsPerWindow: parseInt(process.env.WOLVERINE_RATE_MAX_CALLS, 10)       || fileConfig.rateLimiting?.maxCallsPerWindow || 10,
      windowMs:          parseInt(process.env.WOLVERINE_RATE_WINDOW_MS, 10)        || fileConfig.rateLimiting?.windowMs          || 600000,
      minGapMs:          parseInt(process.env.WOLVERINE_RATE_MIN_GAP_MS, 10)       || fileConfig.rateLimiting?.minGapMs          || 5000,
      maxTokensPerHour:  parseInt(process.env.WOLVERINE_RATE_MAX_TOKENS_HOUR, 10)  || fileConfig.rateLimiting?.maxTokensPerHour  || 100000,
    },

    healthCheck: {
      intervalMs:   parseInt(process.env.WOLVERINE_HEALTH_INTERVAL_MS, 10)      || fileConfig.healthCheck?.intervalMs   || 15000,
      timeoutMs:    parseInt(process.env.WOLVERINE_HEALTH_TIMEOUT_MS, 10)       || fileConfig.healthCheck?.timeoutMs    || 5000,
      failThreshold: parseInt(process.env.WOLVERINE_HEALTH_FAIL_THRESHOLD, 10)  || fileConfig.healthCheck?.failThreshold || 3,
      startDelayMs: parseInt(process.env.WOLVERINE_HEALTH_START_DELAY_MS, 10)   || fileConfig.healthCheck?.startDelayMs || 10000,
    },

    dashboard: {
      port: parseInt(process.env.WOLVERINE_DASHBOARD_PORT, 10) || fileConfig.dashboard?.port || null,
    },
  };

  return _config;
}

/**
 * Get a config value by dot path: getConfig("models.reasoning")
 */
function getConfig(dotPath) {
  const config = loadConfig();
  return dotPath.split(".").reduce((obj, key) => obj?.[key], config);
}

/**
 * Reset config cache (for testing).
 */
function resetConfig() { _config = null; }

module.exports = { loadConfig, getConfig, resetConfig };
