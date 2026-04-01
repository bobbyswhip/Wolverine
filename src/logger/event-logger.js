const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

/**
 * Event Logger — central event bus and persistence layer for all wolverine activity.
 *
 * Every action wolverine takes is logged as a structured event:
 * - Crashes, heals, rollbacks, verification results
 * - Performance metrics, health checks
 * - Agent actions (multi-file analysis, research, optimization)
 * - Security events (injection attempts, sandbox violations)
 *
 * Events are:
 * 1. Emitted live via EventEmitter (for dashboard SSE streaming)
 * 2. Persisted to .wolverine/events/ as daily JSON files
 * 3. Queryable by type, time range, severity
 */

const EVENT_TYPES = {
  // Process lifecycle
  PROCESS_START: "process.start",
  PROCESS_CRASH: "process.crash",
  PROCESS_HEALTHY: "process.healthy",
  PROCESS_STOP: "process.stop",

  // Healing pipeline
  HEAL_START: "heal.start",
  HEAL_PARSE: "heal.parse",
  HEAL_INJECTION_SCAN: "heal.injection_scan",
  HEAL_AI_REQUEST: "heal.ai_request",
  HEAL_AI_RESPONSE: "heal.ai_response",
  HEAL_PATCH_APPLIED: "heal.patch_applied",
  HEAL_PATCH_FAILED: "heal.patch_failed",
  HEAL_VERIFIED: "heal.verified",
  HEAL_VERIFICATION_FAILED: "heal.verification_failed",
  HEAL_ROLLBACK: "heal.rollback",
  HEAL_SUCCESS: "heal.success",
  HEAL_FAILED: "heal.failed",

  // Agent activity
  AGENT_TURN: "agent.turn",
  AGENT_FILE_READ: "agent.file_read",
  AGENT_FILE_WRITE: "agent.file_write",
  AGENT_RESEARCH: "agent.research",
  AGENT_COMPLETE: "agent.complete",

  // Security
  SECURITY_INJECTION_DETECTED: "security.injection_detected",
  SECURITY_SANDBOX_VIOLATION: "security.sandbox_violation",
  SECURITY_RATE_LIMITED: "security.rate_limited",

  // Backup
  BACKUP_CREATED: "backup.created",
  BACKUP_VERIFIED: "backup.verified",
  BACKUP_STABLE: "backup.stable",
  BACKUP_ROLLBACK: "backup.rollback",
  BACKUP_PRUNED: "backup.pruned",

  // Performance monitoring
  PERF_SLOW_ENDPOINT: "perf.slow_endpoint",
  PERF_SPIKE_DETECTED: "perf.spike_detected",
  PERF_ATTACK_DETECTED: "perf.attack_detected",
  PERF_OPTIMIZATION: "perf.optimization",

  // Notifications
  NOTIFY_HUMAN_REQUIRED: "notify.human_required",

  // Health checks
  HEALTH_PASS: "health.pass",
  HEALTH_FAIL: "health.fail",
  HEALTH_UNRESPONSIVE: "health.unresponsive",
};

const SEVERITY = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  CRITICAL: "critical",
};

class EventLogger extends EventEmitter {
  constructor(projectRoot) {
    super();
    this.projectRoot = path.resolve(projectRoot);
    this.eventsDir = path.join(this.projectRoot, ".wolverine", "events");
    this._ensureDir();

    // In-memory ring buffer for recent events (dashboard queries)
    this._recentEvents = [];
    this._maxRecent = 1000;

    // Secret redactor — if set, all events get redacted before persist/emit
    this.redactor = null;

    // Session tracking
    this.sessionId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    this.sessionStart = Date.now();
    this._eventCount = 0;
  }

  /**
   * Attach a SecretRedactor. All events will be redacted before storage/emit.
   */
  setRedactor(redactor) {
    this.redactor = redactor;
  }

  /**
   * Log an event. This is the primary API.
   *
   * @param {string} type - One of EVENT_TYPES
   * @param {string} severity - One of SEVERITY
   * @param {string} message - Human-readable description
   * @param {object} data - Structured metadata
   */
  log(type, severity, message, data = {}) {
    // Redact secrets before they hit storage or the wire
    const safeMessage = this.redactor ? this.redactor.redact(message) : message;
    const safeData = this.redactor ? this.redactor.redactObject(data) : data;

    const event = {
      id: `${this.sessionId}-${(++this._eventCount).toString(36)}`,
      type,
      severity,
      message: safeMessage,
      data: safeData,
      timestamp: Date.now(),
      iso: new Date().toISOString(),
      sessionId: this.sessionId,
    };

    // In-memory ring buffer
    this._recentEvents.push(event);
    if (this._recentEvents.length > this._maxRecent) {
      this._recentEvents.shift();
    }

    // Persist to daily file
    this._persist(event);

    // Emit for live streaming (dashboard SSE)
    this.emit("event", event);

    return event;
  }

  // Convenience methods
  info(type, message, data) { return this.log(type, SEVERITY.INFO, message, data); }
  warn(type, message, data) { return this.log(type, SEVERITY.WARN, message, data); }
  error(type, message, data) { return this.log(type, SEVERITY.ERROR, message, data); }
  critical(type, message, data) { return this.log(type, SEVERITY.CRITICAL, message, data); }
  debug(type, message, data) { return this.log(type, SEVERITY.DEBUG, message, data); }

  /**
   * Query recent events by type and/or severity.
   */
  query({ type, severity, limit = 100, since } = {}) {
    let results = this._recentEvents;

    if (type) {
      results = results.filter(e => e.type === type || e.type.startsWith(type + "."));
    }
    if (severity) {
      results = results.filter(e => e.severity === severity);
    }
    if (since) {
      results = results.filter(e => e.timestamp >= since);
    }

    return results.slice(-limit);
  }

  /**
   * Get summary stats for the current session.
   */
  getSessionStats() {
    const counts = {};
    for (const event of this._recentEvents) {
      const category = event.type.split(".")[0];
      counts[category] = (counts[category] || 0) + 1;
    }

    const errors = this._recentEvents.filter(e => e.severity === SEVERITY.ERROR || e.severity === SEVERITY.CRITICAL);
    const heals = this._recentEvents.filter(e => e.type === EVENT_TYPES.HEAL_SUCCESS);
    const rollbacks = this._recentEvents.filter(e => e.type === EVENT_TYPES.HEAL_ROLLBACK);

    return {
      sessionId: this.sessionId,
      uptime: Date.now() - this.sessionStart,
      totalEvents: this._eventCount,
      categories: counts,
      errors: errors.length,
      heals: heals.length,
      rollbacks: rollbacks.length,
    };
  }

  /**
   * Load events from a specific date's log file.
   */
  loadDay(dateStr) {
    const filePath = path.join(this.eventsDir, `${dateStr}.jsonl`);
    if (!fs.existsSync(filePath)) return [];

    const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
    return lines.filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  /**
   * Get all available log dates.
   */
  getAvailableDates() {
    if (!fs.existsSync(this.eventsDir)) return [];
    return fs.readdirSync(this.eventsDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => f.replace(".jsonl", ""))
      .sort();
  }

  // -- Private --

  _ensureDir() {
    fs.mkdirSync(this.eventsDir, { recursive: true });
  }

  _persist(event) {
    const dateStr = new Date(event.timestamp).toISOString().slice(0, 10);
    const filePath = path.join(this.eventsDir, `${dateStr}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(event) + "\n", "utf-8");
  }
}

module.exports = { EventLogger, EVENT_TYPES, SEVERITY };
