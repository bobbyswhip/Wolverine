/**
 * Wolverine Configuration — all non-secret settings.
 *
 * Secrets (API keys, admin keys) stay in .env.local
 * Everything else goes here — models, limits, features, telemetry.
 */

module.exports = {
  // ── Models ──────────────────────────────────────────────────────
  // 10 model slots — customize each for cost vs quality.
  // See .env.example for what each model does.
  models: {
    reasoning: "gpt-5.4-mini",        // Multi-file agent, complex repairs
    coding: "gpt-5.1-codex-mini",     // Code generation, fast path repair
    chat: "gpt-5-nano",               // Simple text responses (no tools)
    tool: "gpt-5.4-mini",             // Chat with function calling
    classifier: "gpt-4o-mini",        // Route: SIMPLE/TOOLS/AGENT
    audit: "gpt-4o-mini",             // Injection detection (every error)
    compacting: "gpt-4o-mini",        // Text compression for brain
    research: "o4-mini-deep-research", // Deep research on failures
    embedding: "text-embedding-3-small", // Brain vector embeddings
  },

  // ── Server ──────────────────────────────────────────────────────
  server: {
    port: 6969,
    maxRetries: 3,                    // Max repair attempts per crash
    maxMemoryMB: 512,                 // Auto-restart if RSS exceeds this
  },

  // ── Telemetry ───────────────────────────────────────────────────
  telemetry: {
    enabled: true,                     // Set false to disable
    heartbeatIntervalMs: 60000,        // Heartbeat every 60s
    // Override platform URL for self-hosted (default: https://api.wolverinenode.xyz)
    // platformUrl: "https://your-platform.com",
  },

  // ── Rate Limiting ───────────────────────────────────────────────
  rateLimiting: {
    maxCallsPerWindow: 32,
    windowMs: 100000,
    minGapMs: 5000,
    maxTokensPerHour: 1000000,
  },

  // ── Health Checks ───────────────────────────────────────────────
  healthCheck: {
    intervalMs: 15000,
    timeoutMs: 5000,
    failThreshold: 3,
    startDelayMs: 10000,
  },

  // ── Dashboard ───────────────────────────────────────────────────
  dashboard: {
    // Port (default: server.port + 1)
    // port: 6970,
  },
};
