const chalk = require("chalk");
const { aiCall } = require("../core/ai-client");
const { getModel } = require("../core/models");

/**
 * Notification System — alerts for issues the AI cannot fix.
 *
 * Some errors require human intervention:
 * - API keys expired/rotated/revoked
 * - Billing/quota exceeded
 * - External service down (database, third-party API)
 * - Permission denied (file system, network)
 * - Certificate errors
 * - Environment misconfiguration
 *
 * The notifier:
 * 1. Classifies errors as AI-fixable vs human-required
 * 2. Summarizes human-required issues into short, clear sentences
 * 3. Sanitizes through the redactor (no secrets in notifications)
 * 4. Delivers via console, dashboard events, and optional webhook
 */

// Patterns that indicate human-required intervention
const HUMAN_REQUIRED_PATTERNS = [
  // API/Auth failures
  { pattern: /401\s*unauthorized/i, category: "auth", hint: "API key or credentials may be invalid or expired" },
  { pattern: /403\s*forbidden/i, category: "auth", hint: "Access denied — check permissions or API key scope" },
  { pattern: /invalid.*(api|auth|token|key|credential)/i, category: "auth", hint: "Authentication credential is invalid" },
  { pattern: /(api|auth|token|key|credential).*(expired|revoked|rotated|invalid)/i, category: "auth", hint: "Credential has expired or been revoked" },
  { pattern: /authentication\s+failed/i, category: "auth", hint: "Authentication failed — check credentials" },

  // Billing/Quota — covers OpenAI, Anthropic, Wolverine, and generic patterns
  { pattern: /429\s*(too many|rate limit)/i, category: "billing", hint: "Rate limit hit — may need to upgrade plan or wait" },
  { pattern: /(quota|limit|credits?)\s*(exceeded|exhausted|depleted)/i, category: "billing", hint: "Usage quota or credits exhausted" },
  { pattern: /billing.*(?:issue|error|failed|inactive)/i, category: "billing", hint: "Billing issue on the account" },
  { pattern: /insufficient.*(funds|credits|quota)/i, category: "billing", hint: "Insufficient credits or funds" },
  { pattern: /billing_hard_limit_reached/i, category: "billing", hint: "OpenAI billing hard limit reached — add payment method or raise limit" },
  { pattern: /insufficient_quota/i, category: "billing", hint: "API quota exhausted — check billing dashboard" },
  { pattern: /rate_limit_exceeded/i, category: "billing", hint: "API rate limit exceeded — wait or upgrade plan" },
  { pattern: /402\s*(payment|required)/i, category: "billing", hint: "Payment required — check billing status" },
  { pattern: /exceeded.*(?:budget|spending|token)/i, category: "billing", hint: "Spending or token budget exceeded" },
  { pattern: /overloaded_error/i, category: "billing", hint: "Anthropic API overloaded — retry later" },

  // External service failures
  { pattern: /ECONNREFUSED/i, category: "service", hint: "External service connection refused — is it running?" },
  { pattern: /ENOTFOUND/i, category: "service", hint: "DNS lookup failed — check hostname or network" },
  { pattern: /ETIMEDOUT/i, category: "service", hint: "Connection timed out — service may be down" },
  { pattern: /ECONNRESET/i, category: "service", hint: "Connection reset by remote server" },
  { pattern: /503\s*service\s*unavailable/i, category: "service", hint: "External service is temporarily unavailable" },
  { pattern: /502\s*bad\s*gateway/i, category: "service", hint: "Bad gateway — upstream service may be down" },

  // Certificates
  { pattern: /CERT_|certificate|SSL|TLS/i, category: "cert", hint: "SSL/TLS certificate issue — may need renewal" },
  { pattern: /self.signed/i, category: "cert", hint: "Self-signed certificate rejected" },

  // Permissions
  { pattern: /EACCES/i, category: "permission", hint: "Permission denied on file system" },
  { pattern: /EPERM/i, category: "permission", hint: "Operation not permitted — check file/process permissions" },

  // Environment — only match system-level env issues, not app config files the agent can create
  { pattern: /not\s+set|undefined.*env|missing.*env/i, category: "env", hint: "Environment variable not configured" },
  { pattern: /missing.*(\.env|environment|env\s*var)/i, category: "env", hint: "Environment variable or .env file missing" },

  // Disk
  { pattern: /ENOSPC/i, category: "disk", hint: "Disk space full" },
  { pattern: /ENOMEM/i, category: "disk", hint: "Out of memory" },
];

const CATEGORY_ICONS = {
  auth: "🔑",
  billing: "💳",
  service: "🌐",
  cert: "📜",
  permission: "🔒",
  env: "⚙️",
  disk: "💾",
};

class Notifier {
  constructor(options = {}) {
    this.logger = options.logger;
    this.redactor = options.redactor;
    this.webhookUrl = options.webhookUrl || process.env.WOLVERINE_WEBHOOK_URL || null;

    // Dedup: don't spam the same notification repeatedly
    this._sentNotifications = new Map(); // key → timestamp
    this._dedupeWindowMs = 300000; // 5 minutes
  }

  /**
   * Classify an error: can AI fix it, or does it need human intervention?
   * Returns { humanRequired: boolean, category?, hint?, matches? }
   */
  classify(errorMessage, stackTrace) {
    const combined = `${errorMessage}\n${stackTrace || ""}`;
    const matches = [];

    for (const { pattern, category, hint } of HUMAN_REQUIRED_PATTERNS) {
      if (pattern.test(combined)) {
        matches.push({ category, hint });
      }
    }

    if (matches.length === 0) {
      return { humanRequired: false };
    }

    // Use the most specific match (first one)
    return {
      humanRequired: true,
      category: matches[0].category,
      hint: matches[0].hint,
      matches,
    };
  }

  /**
   * Process an error — classify it, and if human-required, generate and send a notification.
   * Returns the notification object if sent, null if AI-fixable.
   */
  async notify(errorMessage, stackTrace) {
    const classification = this.classify(errorMessage, stackTrace);
    if (!classification.humanRequired) return null;

    // Dedup check
    const dedupeKey = `${classification.category}:${classification.hint}`;
    const lastSent = this._sentNotifications.get(dedupeKey);
    if (lastSent && Date.now() - lastSent < this._dedupeWindowMs) {
      return null; // already notified recently
    }

    // Sanitize through redactor
    const safeError = this.redactor ? this.redactor.redact(errorMessage) : errorMessage;
    const safeStack = this.redactor ? this.redactor.redact(stackTrace || "") : (stackTrace || "");

    // Generate short summary using AI
    let summary;
    try {
      summary = await this._summarize(safeError, safeStack, classification);
    } catch {
      // If AI call fails (maybe THAT's the auth error), use the pattern hint
      summary = classification.hint;
    }

    const notification = {
      category: classification.category,
      icon: CATEGORY_ICONS[classification.category] || "⚠️",
      summary,
      hint: classification.hint,
      timestamp: Date.now(),
      iso: new Date().toISOString(),
    };

    // Mark as sent for dedup
    this._sentNotifications.set(dedupeKey, Date.now());

    // Deliver through all channels
    this._deliverConsole(notification);
    this._deliverLogger(notification);
    this._deliverWebhook(notification);

    return notification;
  }

  /**
   * Use CHAT_MODEL to summarize the issue in 1-2 short sentences.
   */
  async _summarize(safeError, safeStack, classification) {
    let model;
    try {
      model = getModel("chat");
    } catch {
      return classification.hint;
    }

    const result = await aiCall({
      model,
      systemPrompt: "You summarize server errors for developers. Write 1-2 short sentences. Be direct and actionable. Do not include any secrets, passwords, or API key values — only refer to them by name (e.g. 'the OPENAI_API_KEY').",
      userPrompt: `Summarize this error for a developer notification:\n\nCategory: ${classification.category}\nError: ${safeError}\n\nStack (first 300 chars): ${safeStack.slice(0, 300)}`,
      maxTokens: 100,
      category: "chat",
    });

    // Double-sanitize the AI response (in case the AI echoes something)
    const summary = this.redactor ? this.redactor.redact(result.content) : result.content;
    return summary || classification.hint;
  }

  _deliverConsole(notification) {
    console.log(chalk.red.bold(`\n  ${notification.icon} HUMAN ACTION REQUIRED`));
    console.log(chalk.red(`  Category: ${notification.category}`));
    console.log(chalk.yellow(`  ${notification.summary}`));
    console.log(chalk.gray(`  Hint: ${notification.hint}\n`));
  }

  _deliverLogger(notification) {
    if (!this.logger) return;
    this.logger.critical("notify.human_required", notification.summary, {
      category: notification.category,
      hint: notification.hint,
    });
  }

  async _deliverWebhook(notification) {
    if (!this.webhookUrl) return;

    try {
      const http = this.webhookUrl.startsWith("https") ? require("https") : require("http");
      const url = new URL(this.webhookUrl);
      const payload = JSON.stringify({
        text: `${notification.icon} **Wolverine Alert** [${notification.category}]: ${notification.summary}`,
        ...notification,
      });

      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: 5000,
      });

      req.on("error", () => {}); // swallow webhook errors
      req.write(payload);
      req.end();
    } catch {
      // Webhook delivery is best-effort
    }
  }
}

module.exports = { Notifier, HUMAN_REQUIRED_PATTERNS, CATEGORY_ICONS };
