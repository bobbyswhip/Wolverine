const chalk = require("chalk");

/**
 * MCP Security Layer — enforces wolverine's security standards on all MCP interactions.
 *
 * Every MCP tool call passes through this gate:
 * 1. Tool allowlist — only explicitly approved tools can execute
 * 2. Argument sanitization — redacts secrets from args before sending to MCP server
 * 3. Result sanitization — redacts secrets from MCP server responses
 * 4. Injection scanning — checks MCP results for prompt injection
 * 5. Rate limiting — prevents MCP servers from being spammed
 * 6. Audit logging — every MCP call logged to event system
 *
 * MCP servers are UNTRUSTED by default. They run in a separate process
 * and could be malicious. Treat all MCP data as external input.
 */

class McpSecurity {
  constructor(options = {}) {
    this.redactor = options.redactor;
    this.logger = options.logger;

    // Per-server tool allowlists. If a server isn't listed, ALL its tools are blocked.
    // Configured in .wolverine/mcp.json under "allowedTools"
    this._allowedTools = new Map(); // serverName → Set<toolName> | "*"

    // Rate limiting per server
    this._callCounts = new Map(); // serverName → { count, windowStart }
    this._maxCallsPerMinute = options.maxCallsPerMinute || 30;

    // Blocked tool name patterns (never allow these regardless of config)
    this._blockedPatterns = [
      /^(rm|delete|drop|truncate|format)/i,
      /exec.*shell/i,
      /admin.*override/i,
    ];
  }

  /**
   * Set allowed tools for a server.
   * @param {string} serverName
   * @param {string[]|"*"} tools — array of tool names, or "*" for all
   */
  setAllowedTools(serverName, tools) {
    if (tools === "*") {
      this._allowedTools.set(serverName, "*");
    } else {
      this._allowedTools.set(serverName, new Set(tools));
    }
  }

  /**
   * Check if a tool call is allowed. Returns { allowed, reason }.
   */
  checkTool(serverName, toolName) {
    // Check blocked patterns
    for (const pattern of this._blockedPatterns) {
      if (pattern.test(toolName)) {
        return { allowed: false, reason: `Tool "${toolName}" matches blocked pattern` };
      }
    }

    // Check allowlist
    const allowed = this._allowedTools.get(serverName);
    if (!allowed) {
      return { allowed: false, reason: `Server "${serverName}" has no allowlisted tools. Configure in .wolverine/mcp.json` };
    }
    if (allowed !== "*" && !allowed.has(toolName)) {
      return { allowed: false, reason: `Tool "${toolName}" not in allowlist for server "${serverName}"` };
    }

    // Rate limit
    if (!this._checkRate(serverName)) {
      return { allowed: false, reason: `Rate limit exceeded for server "${serverName}" (max ${this._maxCallsPerMinute}/min)` };
    }

    return { allowed: true };
  }

  /**
   * Sanitize arguments before sending to MCP server.
   * Redacts secrets so they never leave wolverine.
   */
  sanitizeArgs(args) {
    if (!this.redactor || !args) return args;
    return this.redactor.redactObject(args);
  }

  /**
   * Sanitize results coming back from MCP server.
   * Checks for injection and redacts any secrets that leaked.
   */
  sanitizeResult(serverName, toolName, result) {
    if (!result) return result;

    // Convert to string for scanning
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);

    // Redact any secrets in the result
    let safe = this.redactor ? this.redactor.redact(resultStr) : resultStr;

    // Check for obvious injection attempts in MCP results
    const injectionPatterns = [
      /ignore\s+previous\s+instructions/i,
      /you\s+are\s+now/i,
      /system\s*:\s*/i,
      /new\s+instructions?\s*:/i,
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(safe)) {
        console.log(chalk.red(`  🚨 MCP ${serverName}/${toolName}: injection attempt detected in result`));
        if (this.logger) {
          this.logger.critical("security.mcp_injection", `Injection in MCP result from ${serverName}/${toolName}`, {
            server: serverName, tool: toolName,
          });
        }
        return "[BLOCKED: MCP server returned suspicious content]";
      }
    }

    return safe;
  }

  /**
   * Log an MCP tool call for audit trail.
   */
  auditLog(serverName, toolName, args, result, duration) {
    if (!this.logger) return;
    this.logger.info("mcp.tool_call", `MCP ${serverName}/${toolName}`, {
      server: serverName,
      tool: toolName,
      duration,
      resultSize: typeof result === "string" ? result.length : JSON.stringify(result || "").length,
    });
  }

  // -- Private --

  _checkRate(serverName) {
    const now = Date.now();
    let entry = this._callCounts.get(serverName);
    if (!entry || now - entry.windowStart > 60000) {
      entry = { count: 0, windowStart: now };
      this._callCounts.set(serverName, entry);
    }
    entry.count++;
    return entry.count <= this._maxCallsPerMinute;
  }
}

module.exports = { McpSecurity };
