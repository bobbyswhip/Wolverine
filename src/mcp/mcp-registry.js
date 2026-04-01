const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const { McpStdioClient, McpHttpClient } = require("./mcp-client");
const { McpSecurity } = require("./mcp-security");

/**
 * MCP Registry — manages configured MCP servers and their tools.
 *
 * Configuration: .wolverine/mcp.json
 * {
 *   "servers": {
 *     "my-server": {
 *       "type": "stdio",              // "stdio" or "http"
 *       "command": "node",            // for stdio
 *       "args": ["my-mcp-server.js"], // for stdio
 *       "url": "http://...",          // for http
 *       "allowedTools": ["tool1", "tool2"] | "*",
 *       "env": {},                    // extra env vars (values redacted in logs)
 *       "enabled": true               // default true
 *     }
 *   }
 * }
 *
 * Tool naming: mcp__[server]__[tool] (claw-code convention)
 */

const CONFIG_PATH = ".wolverine/mcp.json";

class McpRegistry {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.redactor = options.redactor;
    this.logger = options.logger;

    this.security = new McpSecurity({ redactor: this.redactor, logger: this.logger });
    this._clients = new Map(); // serverName → client
    this._toolMap = new Map(); // "mcp__server__tool" → { client, serverName, toolDef }
    this._config = null;
  }

  /**
   * Initialize — load config, connect to servers, discover tools.
   */
  async init() {
    this._config = this._loadConfig();
    if (!this._config || !this._config.servers) {
      console.log(chalk.gray("  🔌 MCP: no servers configured (.wolverine/mcp.json)"));
      return;
    }

    const servers = Object.entries(this._config.servers);
    console.log(chalk.gray(`  🔌 MCP: ${servers.length} server(s) configured`));

    for (const [name, config] of servers) {
      if (config.enabled === false) {
        console.log(chalk.gray(`  🔌 MCP: ${name} (disabled)`));
        continue;
      }

      try {
        await this._connectServer(name, config);
      } catch (err) {
        console.log(chalk.yellow(`  🔌 MCP: ${name} failed to connect — ${err.message}`));
        if (this.logger) {
          this.logger.warn("mcp.connect_failed", `MCP ${name}: ${err.message}`, { server: name });
        }
      }
    }

    console.log(chalk.gray(`  🔌 MCP: ${this._toolMap.size} tools available from ${this._clients.size} server(s)`));
  }

  /**
   * Get all MCP tools as agent-compatible tool definitions.
   * Returns array in OpenAI function-calling format.
   */
  getToolDefinitions() {
    const defs = [];
    for (const [fullName, entry] of this._toolMap) {
      const td = entry.toolDef;
      defs.push({
        type: "function",
        function: {
          name: fullName,
          description: `[MCP:${entry.serverName}] ${td.description || td.name}`,
          parameters: td.inputSchema || { type: "object", properties: {} },
        },
      });
    }
    return defs;
  }

  /**
   * Get tool names for display.
   */
  getToolList() {
    return Array.from(this._toolMap.entries()).map(([name, entry]) => ({
      name,
      server: entry.serverName,
      description: entry.toolDef.description || "",
    }));
  }

  /**
   * Call an MCP tool. Security checks applied automatically.
   */
  async callTool(fullName, args) {
    const entry = this._toolMap.get(fullName);
    if (!entry) return { error: `Unknown MCP tool: ${fullName}` };

    const { client, serverName, toolDef } = entry;
    const toolName = toolDef.name;

    // Security gate
    const check = this.security.checkTool(serverName, toolName);
    if (!check.allowed) {
      console.log(chalk.red(`  🛡️ MCP blocked: ${check.reason}`));
      if (this.logger) {
        this.logger.warn("mcp.blocked", `MCP blocked: ${check.reason}`, { server: serverName, tool: toolName });
      }
      return { error: `BLOCKED: ${check.reason}` };
    }

    // Sanitize args (redact secrets before sending to external server)
    const safeArgs = this.security.sanitizeArgs(args);

    const startTime = Date.now();
    try {
      const result = await client.callTool(toolName, safeArgs);
      const duration = Date.now() - startTime;

      // Sanitize result (redact secrets, check for injection)
      let content = "";
      if (result.content) {
        for (const item of result.content) {
          if (item.type === "text") content += item.text;
        }
      }

      const safeContent = this.security.sanitizeResult(serverName, toolName, content);

      // Audit log
      this.security.auditLog(serverName, toolName, safeArgs, safeContent, duration);

      console.log(chalk.gray(`  🔌 MCP: ${serverName}/${toolName} (${duration}ms)`));
      return { content: safeContent };
    } catch (err) {
      const duration = Date.now() - startTime;
      this.security.auditLog(serverName, toolName, safeArgs, `ERROR: ${err.message}`, duration);
      return { error: `MCP ${serverName}/${toolName}: ${err.message}` };
    }
  }

  /**
   * Check if a tool name is an MCP tool.
   */
  isMcpTool(name) {
    return name.startsWith("mcp__") && this._toolMap.has(name);
  }

  /**
   * Disconnect all servers.
   */
  shutdown() {
    for (const [name, client] of this._clients) {
      try { client.disconnect(); } catch {}
    }
    this._clients.clear();
    this._toolMap.clear();
  }

  /**
   * Get stats for dashboard.
   */
  getStats() {
    return {
      servers: this._clients.size,
      tools: this._toolMap.size,
      serverList: Array.from(this._clients.keys()),
    };
  }

  // -- Private --

  async _connectServer(name, config) {
    let client;
    if (config.type === "http") {
      client = new McpHttpClient(name, config);
    } else {
      client = new McpStdioClient(name, config);
    }

    await client.connect();
    this._clients.set(name, client);

    // Set security allowlist
    this.security.setAllowedTools(name, config.allowedTools || []);

    // Discover tools
    const tools = await client.listTools();
    for (const tool of tools) {
      const fullName = `mcp__${name}__${tool.name}`;
      this._toolMap.set(fullName, { client, serverName: name, toolDef: tool });
    }

    console.log(chalk.green(`  🔌 MCP: ${name} connected (${tools.length} tools)`));
    if (this.logger) {
      this.logger.info("mcp.connected", `MCP ${name}: ${tools.length} tools`, {
        server: name, tools: tools.map(t => t.name),
      });
    }
  }

  _loadConfig() {
    const configPath = path.join(this.projectRoot, CONFIG_PATH);
    if (!fs.existsSync(configPath)) return null;

    try {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (err) {
      console.log(chalk.yellow(`  🔌 MCP: config parse error — ${err.message}`));
      return null;
    }
  }
}

module.exports = { McpRegistry };
