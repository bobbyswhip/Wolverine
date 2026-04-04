const fs = require("fs");
const path = require("path");

/**
 * Config Loader — simplified hybrid-always architecture.
 *
 * No more provider selection. Users pick the best model for each task
 * directly in settings.json. Provider is auto-detected from model name.
 * Embedding is always wolverine-embedding-1 (billed through credits).
 *
 * Priority:
 * 1. Environment variables (highest — for CI/Docker overrides)
 * 2. settings.json models section
 * 3. Hardcoded defaults (lowest)
 */

let _config = null;

function loadConfig() {
  if (_config) return _config;

  const configPath = path.join(process.cwd(), "server", "config", "settings.json");
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (err) {
      console.log(`  ⚠️  Failed to load server/config/settings.json: ${err.message}`);
    }
  }

  // Models: read from settings.json "models" section directly.
  // Legacy support: if old provider-based config exists, migrate it.
  let modelSource = fileConfig.models || {};
  if (!fileConfig.models && fileConfig.provider) {
    // Legacy: read from {provider}_settings for backward compatibility
    const settingsKey = `${fileConfig.provider}_settings`;
    modelSource = fileConfig[settingsKey] || fileConfig.hybrid_settings || fileConfig.openai_settings || {};
  }

  _config = {
    // 8 task-specific model slots — user picks any model for each task
    models: {
      reasoning:  process.env.REASONING_MODEL    || modelSource.reasoning  || "gpt-4o",
      coding:     process.env.CODING_MODEL       || modelSource.coding     || "gpt-4o",
      chat:       process.env.CHAT_MODEL         || modelSource.chat       || "gpt-4o-mini",
      tool:       process.env.TOOL_MODEL         || modelSource.tool       || "gpt-4o-mini",
      classifier: process.env.CLASSIFIER_MODEL   || modelSource.classifier || "gpt-4o-mini",
      audit:      process.env.AUDIT_MODEL        || modelSource.audit      || "gpt-4o-mini",
      compacting: process.env.COMPACTING_MODEL   || modelSource.compacting || "gpt-4o-mini",
      utility:    process.env.COMPACTING_MODEL   || modelSource.compacting || "gpt-4o-mini",
      research:   process.env.RESEARCH_MODEL     || modelSource.research   || "gpt-4o",
    },

    // Embedding: separate from task models — always billed through wolverine credits
    embedding: process.env.TEXT_EMBEDDING_MODEL || fileConfig.embedding || "wolverine-embedding-1",

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

    autoUpdate: {
      enabled: process.env.WOLVERINE_AUTO_UPDATE !== "false" && (fileConfig.autoUpdate?.enabled !== false),
      intervalMs: parseInt(process.env.WOLVERINE_UPDATE_INTERVAL_MS, 10) || fileConfig.autoUpdate?.intervalMs || 3600000,
    },

    errorMonitor: {
      threshold: parseInt(process.env.WOLVERINE_ERROR_THRESHOLD, 10) || fileConfig.errorMonitor?.defaultThreshold || 1,
      windowMs: parseInt(process.env.WOLVERINE_ERROR_WINDOW_MS, 10) || fileConfig.errorMonitor?.windowMs || 30000,
      cooldownMs: parseInt(process.env.WOLVERINE_ERROR_COOLDOWN_MS, 10) || fileConfig.errorMonitor?.cooldownMs || 60000,
    },
  };

  // Migrate old settings.json to new format + ensure defaults
  _migrateAndEnsureDefaults(fileConfig, configPath);

  return _config;
}

function getConfig(dotPath) {
  const config = loadConfig();
  return dotPath.split(".").reduce((obj, key) => obj?.[key], config);
}

function resetConfig() { _config = null; }

/**
 * Migrate old provider-based config to new flat models format.
 * Also ensure default sections exist.
 */
function _migrateAndEnsureDefaults(fileConfig, configPath) {
  let needsWrite = false;

  // Migrate: if old provider system exists, convert to flat models
  if (fileConfig.provider && !fileConfig.models) {
    const settingsKey = `${fileConfig.provider}_settings`;
    const source = fileConfig[settingsKey] || {};
    fileConfig.models = { ...source };
    delete fileConfig.models.embedding; // embedding is now separate
    fileConfig.embedding = source.embedding || "wolverine-embedding-1";
    needsWrite = true;
  }

  // Ensure default sections
  const DEFAULTS = {
    autoUpdate: { enabled: true, intervalMs: 3600000 },
    errorMonitor: { defaultThreshold: 1, windowMs: 30000, cooldownMs: 60000 },
    healthCheck: { intervalMs: 15000, timeoutMs: 5000, failThreshold: 3, startDelayMs: 10000 },
    rateLimiting: { maxCallsPerWindow: 32, windowMs: 100000, minGapMs: 5000, maxTokensPerHour: 1000000 },
    telemetry: { enabled: true, heartbeatIntervalMs: 60000 },
    cluster: { enabled: false, workers: 0 },
  };

  for (const [key, defaults] of Object.entries(DEFAULTS)) {
    if (!fileConfig[key]) {
      fileConfig[key] = defaults;
      needsWrite = true;
    }
  }

  if (needsWrite && configPath) {
    try {
      const tmpPath = configPath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(fileConfig, null, 2), "utf-8");
      fs.renameSync(tmpPath, configPath);
    } catch {}
  }
}

module.exports = { loadConfig, getConfig, resetConfig };
