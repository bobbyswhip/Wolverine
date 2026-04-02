const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

/**
 * Secret Redactor — prevents secrets from leaking to AI, brain, logs, or dashboard.
 *
 * On init, reads .env.local / .env to build a map of secret values → env key names.
 * Then every string that passes through redact() gets values replaced with
 * `process.env.KEY_NAME` so the AI knows which secret is referenced without
 * seeing the actual value.
 *
 * Also detects common secret patterns (API keys, tokens, connection strings)
 * that might not be in .env files.
 *
 * This runs as a gate on EVERY outbound path:
 * - Before AI calls (error messages, source code, stack traces)
 * - Before brain memory storage
 * - Before event logger persistence
 * - Before dashboard SSE broadcast
 * - Before agent tool results
 */

// Patterns that look like secrets even if we don't know them from .env
const SECRET_PATTERNS = [
  // API keys
  { pattern: /sk-[a-zA-Z0-9_-]{20,}/g, label: "[REDACTED_API_KEY]" },
  { pattern: /sk-proj-[a-zA-Z0-9_-]{20,}/g, label: "[REDACTED_OPENAI_KEY]" },
  { pattern: /ghp_[a-zA-Z0-9]{36,}/g, label: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /gho_[a-zA-Z0-9]{36,}/g, label: "[REDACTED_GITHUB_OAUTH]" },
  { pattern: /xoxb-[a-zA-Z0-9-]+/g, label: "[REDACTED_SLACK_TOKEN]" },
  { pattern: /xoxp-[a-zA-Z0-9-]+/g, label: "[REDACTED_SLACK_TOKEN]" },
  // AWS
  { pattern: /AKIA[0-9A-Z]{16}/g, label: "[REDACTED_AWS_KEY]" },
  // Connection strings
  { pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s"'`]+/gi, label: "[REDACTED_CONNECTION_STRING]" },
  // Bearer tokens
  { pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g, label: "Bearer [REDACTED_TOKEN]" },
  // Generic long hex/base64 secrets (32+ chars of hex or base64)
  { pattern: /(?:password|secret|token|key|credential|auth)['"`]?\s*[:=]\s*['"`]([a-zA-Z0-9+/=_-]{32,})['"`]/gi, label: null }, // handled specially
  // JWT tokens
  { pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, label: "[REDACTED_JWT]" },
];

class SecretRedactor {
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    // Map: secret value → env key name (sorted longest first for greedy matching)
    this._secretMap = [];
    // Set of raw secret values for fast detection
    this._secretValues = new Set();

    this._loadEnvSecrets();
  }

  /**
   * Redact all secrets from a string.
   * Replaces actual secret values with `process.env.KEY_NAME`.
   * Also catches pattern-based secrets not in .env.
   *
   * @param {string} text - Any string that might contain secrets
   * @returns {string} - Redacted string
   */
  redact(text) {
    if (!text || typeof text !== "string") return text;

    let result = text;

    // 1. Replace known env secret values with their key names (longest first)
    for (const { value, key } of this._secretMap) {
      if (result.includes(value)) {
        result = result.split(value).join(`process.env.${key}`);
      }
    }

    // 2. Apply pattern-based redaction for secrets we don't know about
    for (const { pattern, label } of SECRET_PATTERNS) {
      if (label) {
        result = result.replace(pattern, label);
      } else {
        // Special handling for key=value patterns — replace just the value part
        result = result.replace(pattern, (match, capturedValue) => {
          if (capturedValue && capturedValue.length >= 32) {
            return match.replace(capturedValue, "[REDACTED_SECRET]");
          }
          return match;
        });
      }
    }

    return result;
  }

  /**
   * Redact secrets from a structured object (deep).
   * Walks all string values in objects/arrays.
   */
  redactObject(obj) {
    if (typeof obj === "string") return this.redact(obj);
    if (Array.isArray(obj)) return obj.map(item => this.redactObject(item));
    if (obj && typeof obj === "object") {
      const result = {};
      for (const [key, val] of Object.entries(obj)) {
        result[key] = this.redactObject(val);
      }
      return result;
    }
    return obj;
  }

  /**
   * Check if a string contains any known secrets. Fast check.
   */
  containsSecrets(text) {
    if (!text) return false;
    for (const { value } of this._secretMap) {
      if (text.includes(value)) return true;
    }
    return false;
  }

  /**
   * Reload secrets (call if .env files change).
   */
  reload() {
    this._secretMap = [];
    this._secretValues.clear();
    this._loadEnvSecrets();
  }

  /**
   * Get stats for logging.
   */
  getStats() {
    return {
      trackedSecrets: this._secretMap.length,
      envFiles: this._envFilesLoaded || 0,
    };
  }

  // -- Private --

  _loadEnvSecrets() {
    const envFiles = [".env.local", ".env", ".env.production", ".env.development"];
    let filesLoaded = 0;

    for (const envFile of envFiles) {
      const filePath = path.join(this.projectRoot, envFile);
      if (!fs.existsSync(filePath)) continue;

      filesLoaded++;
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (const line of lines) {
        // Skip comments and empty lines
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;

        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim()
          // Remove surrounding quotes
          .replace(/^['"]|['"]$/g, "");

        // Only track values that look like secrets (long enough, not just a port number)
        if (value.length >= 8 && !this._isNonSecret(key, value)) {
          this._secretMap.push({ key, value });
          this._secretValues.add(value);
        }
      }
    }

    // Also add current process.env values for known secret keys
    const knownSecretKeys = [
      "OPENAI_API_KEY", "DATABASE_URL", "REDIS_URL", "JWT_SECRET",
      "SESSION_SECRET", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN",
      "SLACK_TOKEN", "STRIPE_SECRET_KEY", "SENDGRID_API_KEY",
    ];

    for (const key of knownSecretKeys) {
      const value = process.env[key];
      if (value && value.length >= 8 && !this._secretValues.has(value)) {
        this._secretMap.push({ key, value });
        this._secretValues.add(value);
      }
    }

    // Sort longest values first for greedy replacement
    this._secretMap.sort((a, b) => b.value.length - a.value.length);
    this._envFilesLoaded = filesLoaded;
  }

  /**
   * Heuristic: is this key/value pair NOT a secret?
   * Avoids redacting things like PORT=6969 or NODE_ENV=production.
   */
  _isNonSecret(key, value) {
    const nonSecretKeys = /^(PORT|HOST|NODE_ENV|DEBUG|LOG_LEVEL|TZ|LANG|PATH|HOME|USER|SHELL|TERM|HOSTNAME)$/i;
    if (nonSecretKeys.test(key)) return true;

    // Model names aren't secrets
    if (key.endsWith("_MODEL")) return true;

    // Pure numbers aren't secrets
    if (/^\d+$/.test(value)) return true;

    // Short common values
    if (["true", "false", "development", "production", "staging", "test", "localhost"].includes(value.toLowerCase())) return true;

    return false;
  }
}

// ── Singleton ──
// One instance, initialized once, used everywhere.
// Import { redact, redactObj } from anywhere — no need to pass the redactor around.

let _instance = null;

/**
 * Initialize the singleton. Call once on startup from runner.
 */
function initRedactor(projectRoot) {
  _instance = new SecretRedactor(projectRoot);
  return _instance;
}

/**
 * Get the singleton instance.
 */
function getRedactor() {
  return _instance;
}

/**
 * Redact a string. Safe to call even if not initialized (returns input unchanged).
 * This is the universal function — use it everywhere instead of this.redactor?.redact().
 */
function redact(text) {
  if (!_instance || !text || typeof text !== "string") return text;
  return _instance.redact(text);
}

/**
 * Redact all string values in an object (deep). Safe to call if not initialized.
 */
function redactObj(obj) {
  if (!_instance) return obj;
  return _instance.redactObject(obj);
}

/**
 * Check if a string contains secrets.
 */
function hasSecrets(text) {
  if (!_instance || !text) return false;
  return _instance.containsSecrets(text);
}

module.exports = { SecretRedactor, initRedactor, getRedactor, redact, redactObj, hasSecrets };
