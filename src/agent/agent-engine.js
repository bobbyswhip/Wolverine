const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const http = require("http");
const https = require("https");
const chalk = require("chalk");
const { getModel } = require("../core/models");
const { aiCallWithHistory } = require("../core/ai-client");

/**
 * Agent Engine — multi-turn AI agent with full claw-code tool harness.
 *
 * Ported tools from claw-code's tool registry:
 *
 * FILE OPERATIONS (claw-code: FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool)
 *   read_file    — Read file contents with optional line range
 *   write_file   — Write complete file content
 *   edit_file    — Find-and-replace edit (surgical, not full rewrite)
 *   glob_files   — Pattern-based file discovery (e.g. ** /*.js)
 *   grep_code    — Regex search across codebase with context lines
 *
 * SHELL & COMMANDS (claw-code: BashTool, gitSafety, gitOperationTracking)
 *   bash_exec    — Sandboxed shell command execution
 *   git_log      — View recent git commits
 *   git_diff     — View current changes
 *
 * WEB & RESEARCH (claw-code: WebFetchTool, WebSearchTool)
 *   web_fetch    — Fetch a URL and return content
 *
 * TASK MANAGEMENT (claw-code: TaskCreateTool pattern)
 *   done         — Signal completion with summary
 */

const TOOL_DEFINITIONS = [
  // ── FILE OPERATIONS ──
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents. Supports optional line offset/limit for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from project root" },
          offset: { type: "number", description: "Start line (0-based, optional)" },
          limit: { type: "number", description: "Max lines to read (optional, default: all)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write complete content to a file. Creates parent dirs if needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from project root" },
          content: { type: "string", description: "Complete file content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Surgical find-and-replace edit. Replaces exact text in a file without rewriting the whole thing. Use this for small targeted fixes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from project root" },
          old_text: { type: "string", description: "Exact text to find (must match verbatim)" },
          new_text: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob_files",
      description: "Find files matching a glob pattern. Returns paths relative to project root. Use to discover project structure and find files by extension or name pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. '**/*.js', 'src/**/*.json', '*.config.*')" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_code",
      description: "Search for a regex pattern across project files. Returns matching lines with file paths, line numbers, and optional context. More powerful than search_files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          file_glob: { type: "string", description: "File filter glob (e.g. '*.js', '*.json')" },
          context: { type: "number", description: "Lines of context around each match (default: 0)" },
          max_results: { type: "number", description: "Max matches to return (default: 30)" },
        },
        required: ["pattern"],
      },
    },
  },
  // ── SHELL & GIT ──
  {
    type: "function",
    function: {
      name: "bash_exec",
      description: "Execute a shell command in the project directory. Use for running tests, checking package versions, inspecting node_modules, or any system command. Commands are sandboxed to the project directory.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: { type: "number", description: "Timeout in ms (default: 10000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "View recent git commits. Useful for understanding what changed recently.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of commits (default: 10)" },
          file: { type: "string", description: "Filter to a specific file path" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "View current uncommitted changes or diff between refs.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Git ref to diff against (default: HEAD)" },
          file: { type: "string", description: "Filter to a specific file" },
        },
        required: [],
      },
    },
  },
  // ── WEB ──
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch content from a URL. Use this to look up documentation, npm package info, or error solutions. Returns the text content.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
  // ── DIAGNOSTICS (investigate non-code problems) ──
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List directory contents with file sizes. Use to check if files exist, find misplaced files, or verify directory structure.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path (default: project root)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description: "Move or rename a file. Use to fix misplaced files, reorganize structure, or rename incorrectly named files.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Source relative path" },
          to: { type: "string", description: "Destination relative path" },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_port",
      description: "Check if a port is in use and what process is using it. Use for EADDRINUSE errors.",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port number to check" },
        },
        required: ["port"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_env",
      description: "Check environment variables. Lists all env vars (values redacted) or checks if a specific var is set. Use to diagnose missing config.",
      parameters: {
        type: "object",
        properties: {
          variable: { type: "string", description: "Specific env var to check (optional — omit to list all)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_db",
      description: "Inspect a SQLite database: list tables, describe schema, or run a read-only query. Use for database errors, invalid entries, schema mismatches.",
      parameters: {
        type: "object",
        properties: {
          db_path: { type: "string", description: "Relative path to .db or .sqlite file" },
          action: { type: "string", description: "Action: 'tables' (list tables), 'schema' (show CREATE statements), 'query' (run read-only SQL)" },
          sql: { type: "string", description: "SQL query (required if action is 'query', must be SELECT/PRAGMA only)" },
        },
        required: ["db_path", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_db_fix",
      description: "Run a write query on a SQLite database to fix data issues. IMPORTANT: Always use inspect_db FIRST to see the current state before writing. This tool auto-snapshots affected rows before and after the write. Creates a backup. Returns before/after state so you can verify the fix is correct.",
      parameters: {
        type: "object",
        properties: {
          db_path: { type: "string", description: "Relative path to .db or .sqlite file" },
          sql: { type: "string", description: "SQL statement (UPDATE, DELETE, INSERT, ALTER, CREATE)" },
        },
        required: ["db_path", "sql"],
      },
    },
  },
  // ── DEPENDENCY MANAGEMENT ──
  {
    type: "function",
    function: {
      name: "audit_deps",
      description: "Run a full dependency health check: npm audit (vulnerabilities), outdated packages, peer dep conflicts, unused packages, lock file status. Returns a health score and actionable fixes. Use BEFORE editing code when the error might be a dependency issue.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_migration",
      description: "Check if a package has a known migration/upgrade path. Use when a deprecated API or old package is causing errors. Returns the recommended replacement and code transformation patterns.",
      parameters: {
        type: "object",
        properties: {
          package: { type: "string", description: "Package name to check (e.g. 'express', 'moment', 'request')" },
        },
        required: ["package"],
      },
    },
  },
  // ── COMPLETION ──
  {
    type: "function",
    function: {
      name: "check_memory",
      description: "Check system and process memory usage. Returns RSS, heap, free system memory, and whether memory pressure is detected.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_processes",
      description: "List running Node.js processes. Useful for finding zombie/orphan processes or port conflicts.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_logs",
      description: "Read recent log output. Returns the last N lines from the server's log source.",
      parameters: {
        type: "object",
        properties: {
          lines: { type: "number", description: "Number of lines to return (default: 50)" },
          filter: { type: "string", description: "Optional grep filter pattern" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "restart_service",
      description: "Trigger a graceful server restart. Use after applying fixes that require a process restart to take effect.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_network",
      description: "Check network connectivity: DNS resolution, port availability, and external service reachability.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "Hostname to check DNS for (optional)" },
          port: { type: "number", description: "Port to check availability (optional)" },
          url: { type: "string", description: "URL to check reachability (optional)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_env",
      description: "List environment variable names (NOT values) that are set. Checks if required vars exist without exposing secrets.",
      parameters: {
        type: "object",
        properties: {
          check: { type: "array", items: { type: "string" }, description: "Specific var names to check if set (optional)" },
        },
        required: [],
      },
    },
  },
  // ── ADVANCED DIAGNOSTICS ──
  {
    type: "function",
    function: {
      name: "verify_node_modules",
      description: "Verify node_modules integrity against package-lock.json. Detects corruption, missing packages, broken bin links.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_certificate",
      description: "Inspect SSL/TLS certificate for a host or local file. Shows expiry, subject, SAN list, chain validity.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "Hostname to check (e.g. api.example.com)" },
          port: { type: "number", description: "Port (default: 443)" },
        },
        required: ["host"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_cache",
      description: "Check Redis/cache server health: connectivity, auth, memory usage, connected clients.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "Redis host (default: 127.0.0.1)" },
          port: { type: "number", description: "Redis port (default: 6379)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "disk_cleanup",
      description: "Find and optionally clean safe-to-delete files (old backups, caches, logs) to free disk space. Dry run by default.",
      parameters: {
        type: "object",
        properties: {
          dry_run: { type: "boolean", description: "If true (default), only report what would be cleaned" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_file_descriptors",
      description: "Check open file descriptor count, limits, and identify potential FD leaks (EMFILE prevention).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_event_loop",
      description: "Scan server code for event loop blocking patterns (readFileSync, execSync, large JSON.parse) and check active handles.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_websocket",
      description: "Test a WebSocket endpoint by performing a real handshake. Reports connection success, upgrade status, latency.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "WebSocket URL (ws:// or wss://)" },
          timeout_ms: { type: "number", description: "Connection timeout (default: 5000)" },
        },
        required: ["url"],
      },
    },
  },
  // ── TASK MANAGEMENT ──
  {
    type: "function",
    function: {
      name: "done",
      description: "Call this when you have finished analyzing and fixing the issue.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Summary of changes made" },
          files_modified: {
            type: "array",
            items: { type: "string" },
            description: "List of files that were modified",
          },
        },
        required: ["summary", "files_modified"],
      },
    },
  },
];

// Commands that are NEVER allowed in bash_exec (claw-code: destructiveCommandWarning)
const BLOCKED_COMMANDS = [
  /\brm\s+-rf\s+[/\\]/i,       // rm -rf /
  /\brmdir\s+[/\\]/i,
  /\bformat\s+/i,
  /\bmkfs\s+/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bgit\s+push\s+--force/i,   // force push (claw-code: gitSafety)
  /\bgit\s+reset\s+--hard/i,
  /\bnpm\s+publish\b/i,         // no accidental publishes
  /\bcurl\b.*\|\s*bash/i,       // pipe to bash
  /\beval\s*\(/i,
];

class AgentEngine {
  constructor(options = {}) {
    this.sandbox = options.sandbox;
    this.logger = options.logger;
    this.cwd = options.cwd || process.cwd();
    this.mcp = options.mcp || null; // McpRegistry for external tools
    this.category = options.category || "tool"; // Agent uses tools = tool category by default

    // Budget constraints (claw-code: QueryEngineConfig)
    this.maxTurns = options.maxTurns || 15;
    this.maxTokens = options.maxTokens || 50000;

    // State
    this.messages = [];
    this.turnCount = 0;
    this.totalTokens = 0;
    this.filesRead = new Set();
    this.filesModified = [];
    this.toolCalls = [];  // audit trail (claw-code: transcript store pattern)
  }

  /**
   * Run the agent to fix an error.
   */
  async run({ errorMessage, stackTrace, primaryFile, sourceCode, brainContext }) {
    const model = getModel("reasoning");

    // Dynamic system prompt: compact for simple errors (~400 tokens), full for complex (~1200 tokens)
    const isSimple = /TypeError|ReferenceError|SyntaxError|Cannot find module|Cannot read prop/.test(errorMessage || "");
    const systemPrompt = isSimple ? _simplePrompt(this.cwd, primaryFile) : _fullPrompt(this.cwd, primaryFile);

    // Build user message — handle cases with and without a specific file
    let userContent = `The server has an error:\n\n**Error:** ${errorMessage}\n\n**Stack Trace:**\n\`\`\`\n${stackTrace}\n\`\`\``;
    if (primaryFile && sourceCode) {
      userContent += `\n\n**Primary file (${primaryFile}):**\n\`\`\`\n${sourceCode}\n\`\`\``;
    } else if (!primaryFile) {
      userContent += `\n\n**No specific file identified.** Use your investigation tools (glob_files, grep_code, list_dir, inspect_db, check_env, check_port) to find the root cause.`;
    }
    if (brainContext) userContent += `\n\n**Context from Wolverine Brain:**\n${brainContext}`;
    userContent += `\n\nDiagnose the root cause, investigate with your tools, and fix the issue.`;

    this.messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];

    if (primaryFile) this.filesRead.add(primaryFile);

    // Merge MCP tools with built-in tools
    const allTools = [...TOOL_DEFINITIONS];
    if (this.mcp) {
      const mcpTools = this.mcp.getToolDefinitions();
      if (mcpTools.length > 0) {
        allTools.push(...mcpTools);
        console.log(chalk.gray(`  🔌 Agent has ${mcpTools.length} MCP tools available`));
      }
    }

    while (this.turnCount < this.maxTurns) {
      this.turnCount++;

      if (this.logger) {
        this.logger.debug("agent.turn", `Agent turn ${this.turnCount}/${this.maxTurns}`, {
          turnCount: this.turnCount, filesRead: Array.from(this.filesRead), tokensUsed: this.totalTokens,
        });
      }

      console.log(chalk.gray(`  🤖 Agent turn ${this.turnCount}/${this.maxTurns} (${this.totalTokens} tokens used)`));

      // Zero-cost structural compaction (claw-code pattern)
      // Extracts signals from message history WITHOUT an LLM call.
      // Preserves last 4 messages verbatim, summarizes older ones structurally.
      // Triggers when estimated tokens > 10K (text.length / 4 approximation).
      const estimatedTokens = this.messages.reduce((s, m) => s + _estimateTokens(m), 0);
      if (this.messages.length > 6 && estimatedTokens > 10000) {
        const preserveCount = 4; // keep system + last 3 exchanges
        const toCompact = this.messages.slice(1, -preserveCount);
        if (toCompact.length > 2) {
          const summary = _structuralSummary(toCompact, this.filesRead, this.filesModified, this.toolCalls);
          this.messages = [
            this.messages[0], // system prompt
            { role: "assistant", content: summary },
            { role: "user", content: "Continue from where you left off." },
            ...this.messages.slice(-preserveCount),
          ];
          console.log(chalk.gray(`  📦 Compacted ${toCompact.length} messages (${estimatedTokens} → ~${_estimateTokens({ content: summary })} tokens) — $0.00`));
        }
      }

      let response;
      const AI_CALL_TIMEOUT_MS = parseInt(process.env.WOLVERINE_AI_CALL_TIMEOUT_MS, 10) || 90000; // 90s per API call — self-hosted GPU needs more time
      try {
        response = await Promise.race([
          aiCallWithHistory({
            model,
            messages: this.messages,
            tools: allTools,
            maxTokens: 4096,
            category: this.category,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`AI call timed out after ${AI_CALL_TIMEOUT_MS / 1000}s`)), AI_CALL_TIMEOUT_MS)),
        ]);
      } catch (err) {
        console.log(chalk.red(`  Agent API error: ${err.message}`));
        // On timeout, return what we have so far rather than failing completely
        if (err.message.includes("timed out") && this.filesModified.length > 0) {
          return { success: true, summary: `Partial fix applied (API timeout on turn ${this.turnCount})`, filesModified: this.filesModified, turnCount: this.turnCount, totalTokens: this.totalTokens };
        }
        return { success: false, summary: err.message, filesModified: [], turnCount: this.turnCount, totalTokens: this.totalTokens };
      }

      if (response.usage) {
        this.totalTokens += (response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0)
          + (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0);
      }

      if (this.totalTokens > this.maxTokens) {
        console.log(chalk.yellow(`  ⚠️  Token budget exhausted (${this.totalTokens}/${this.maxTokens})`));
        return { success: false, summary: "Token budget exhausted", filesModified: this.filesModified, turnCount: this.turnCount, totalTokens: this.totalTokens };
      }

      if (!response.choices || !response.choices[0]) {
        console.log(chalk.red(`  ⚠️  AI returned no choices: ${JSON.stringify(response).slice(0, 200)}`));
        return { success: false, summary: "AI returned empty response", filesModified: this.filesModified, turnCount: this.turnCount, totalTokens: this.totalTokens };
      }
      const choice = response.choices[0];
      const assistantMessage = choice.message || choice;
      this.messages.push(assistantMessage);

      // Parse Gemma-style text tool calls: "call:tool_name{json_args}" → structured tool_calls
      if ((!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) && assistantMessage.content) {
        const parsed = _parseTextToolCalls(assistantMessage.content);
        if (parsed.length > 0) {
          assistantMessage.tool_calls = parsed;
          console.log(chalk.gray(`  🔧 Parsed ${parsed.length} tool call(s) from text output`));
        }
      }

      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        if (assistantMessage.content) {
          console.log(chalk.gray(`  💬 ${(assistantMessage.content || "").slice(0, 200)}`));
        }
        return {
          success: this.filesModified.length > 0,
          summary: assistantMessage.content || "Agent completed without tool calls",
          filesModified: this.filesModified,
          turnCount: this.turnCount,
          totalTokens: this.totalTokens,
        };
      }

      // Execute ALL tool calls (supports parallel — Claude can request multiple at once)
      // Group all results into tool messages for proper Anthropic parallel tool support.
      const MAX_TOOL_RESULT = 4000;
      let doneResult = null;

      for (const toolCall of assistantMessage.tool_calls) {
        let result;
        let isError = false;
        try {
          const hookResult = _runPreHook(toolCall.function?.name, toolCall.function?.arguments, this.cwd);
          if (hookResult.denied) {
            result = { content: `Blocked by hook: ${hookResult.message}` };
            isError = true;
          } else {
            result = await this._executeTool(toolCall);
          }
        } catch (err) {
          result = { content: `Tool error: ${err.message?.slice(0, 200)}` };
          isError = true;
          console.log(chalk.yellow(`    ⚠️ Tool error (${toolCall.function?.name}): ${err.message?.slice(0, 80)}`));
        }

        _runPostHook(toolCall.function?.name, toolCall.function?.arguments, result.content, isError, this.cwd);

        // Truncate large results
        let toolContent = isError ? `[ERROR] ${result.content}` : result.content;
        if (toolContent && toolContent.length > MAX_TOOL_RESULT) {
          toolContent = toolContent.slice(0, MAX_TOOL_RESULT) + `\n... (truncated. Use offset/limit for large results.)`;
        }

        // Push each tool result as its own message (OpenAI format — ai-client.js
        // converts to grouped Anthropic tool_result blocks automatically)
        this.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolContent,
        });

        if (result.done) doneResult = result;
      }

      if (doneResult) {
        return {
          success: true,
          summary: doneResult.summary,
          filesModified: doneResult.filesModified || this.filesModified,
          turnCount: this.turnCount,
          totalTokens: this.totalTokens,
          toolCalls: this.toolCalls,
        };
      }
    }

    console.log(chalk.yellow(`  ⚠️  Max turns (${this.maxTurns}) reached.`));
    return {
      success: this.filesModified.length > 0,
      summary: `Agent used all ${this.maxTurns} turns`,
      filesModified: this.filesModified,
      turnCount: this.turnCount,
      totalTokens: this.totalTokens,
    };
  }

  async _executeTool(toolCall) {
    const name = toolCall.function.name;
    let args;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return { content: "Error: Invalid JSON in tool arguments" };
    }

    // Audit trail
    this.toolCalls.push({ name, args, timestamp: Date.now() });

    switch (name) {
      case "read_file":     return this._readFile(args);
      case "write_file":    return this._writeFile(args);
      case "edit_file":     return this._editFile(args);
      case "glob_files":    return this._globFiles(args);
      case "grep_code":     return this._grepCode(args);
      case "bash_exec":     return this._bashExec(args);
      case "git_log":       return this._gitLog(args);
      case "git_diff":      return this._gitDiff(args);
      case "web_fetch":     return this._webFetch(args);
      case "list_dir":      return this._listDir(args);
      case "move_file":     return this._moveFile(args);
      case "check_port":    return this._checkPort(args);
      case "check_env":     return this._checkEnv(args);
      case "inspect_db":    return this._inspectDb(args);
      case "run_db_fix":    return this._runDbFix(args);
      case "audit_deps":    return this._auditDeps(args);
      case "check_migration": return this._checkMigration(args);
      case "check_memory":  return this._checkMemory(args);
      case "list_processes": return this._listProcesses(args);
      case "check_logs":    return this._checkLogs(args);
      case "restart_service": return this._restartService(args);
      case "check_network": return this._checkNetwork(args);
      case "inspect_env":   return this._inspectEnv(args);
      case "verify_node_modules": return this._verifyNodeModules(args);
      case "inspect_certificate": return this._inspectCertificate(args);
      case "inspect_cache": return this._inspectCache(args);
      case "disk_cleanup":  return this._diskCleanup(args);
      case "check_file_descriptors": return this._checkFileDescriptors(args);
      case "check_event_loop": return this._checkEventLoop(args);
      case "check_websocket": return this._checkWebsocket(args);
      case "done":          return this._done(args);
      // Legacy aliases
      case "list_files":    return this._globFiles({ pattern: (args.dir || ".") + "/*" + (args.pattern || "") });
      case "search_files":  return this._grepCode({ pattern: args.query, file_glob: args.file_pattern });
      default:
        // Check MCP tools
        if (this.mcp && this.mcp.isMcpTool(name)) {
          const result = await this.mcp.callTool(name, args);
          return { content: result.error || result.content || "No result" };
        }
        return { content: `Unknown tool: ${name}` };
    }
  }

  // ── FILE TOOLS ──

  _readFile(args) {
    const filePath = path.resolve(this.cwd, args.path);
    try {
      const content = this.sandbox.readFile(filePath);
      this.filesRead.add(args.path);
      let result = content;

      if (args.offset || args.limit) {
        const lines = content.split("\n");
        const start = args.offset || 0;
        const end = args.limit ? start + args.limit : lines.length;
        result = lines.slice(start, end).map((l, i) => `${start + i + 1} | ${l}`).join("\n");
      }

      console.log(chalk.gray(`    📖 Read: ${args.path} (${content.length} chars)`));
      if (this.logger) this.logger.debug("agent.file_read", `Read ${args.path}`, { path: args.path, size: content.length });
      return { content: result };
    } catch (err) {
      return { content: `Error reading ${args.path}: ${err.message}` };
    }
  }

  _writeFile(args) {
    // Guard: block writes to wolverine internals
    if (this._isProtectedPath(args.path)) {
      return { content: `BLOCKED: Cannot modify wolverine internal file "${args.path}". Only user project files can be modified.` };
    }
    const filePath = path.resolve(this.cwd, args.path);
    try {
      const dir = path.dirname(filePath);
      this.sandbox.resolve(dir);
      fs.mkdirSync(dir, { recursive: true });
      this.sandbox.writeFile(filePath, args.content);
      this.filesModified.push(args.path);
      console.log(chalk.green(`    ✏️  Wrote: ${args.path}`));
      if (this.logger) this.logger.info("agent.file_write", `Modified ${args.path}`, { path: args.path });
      return { content: `Successfully wrote ${args.path}` };
    } catch (err) {
      return { content: `Error writing ${args.path}: ${err.message}` };
    }
  }

  _editFile(args) {
    if (this._isProtectedPath(args.path)) {
      return { content: `BLOCKED: Cannot modify wolverine internal file "${args.path}". Only user project files can be modified.` };
    }
    const filePath = path.resolve(this.cwd, args.path);
    try {
      const content = this.sandbox.readFile(filePath);
      const normalized = content.replace(/\r\n/g, "\n");
      const normalizedOld = args.old_text.replace(/\r\n/g, "\n");

      if (!normalized.includes(normalizedOld)) {
        return { content: `Error: Could not find the exact text to replace in ${args.path}. Make sure old_text matches verbatim.` };
      }

      const patched = normalized.replace(normalizedOld, args.new_text.replace(/\r\n/g, "\n"));
      this.sandbox.writeFile(filePath, patched);
      if (!this.filesModified.includes(args.path)) this.filesModified.push(args.path);
      console.log(chalk.green(`    ✏️  Edited: ${args.path}`));
      if (this.logger) this.logger.info("agent.file_write", `Edited ${args.path}`, { path: args.path });
      return { content: `Successfully edited ${args.path}` };
    } catch (err) {
      return { content: `Error editing ${args.path}: ${err.message}` };
    }
  }

  _globFiles(args) {
    const results = [];
    const pattern = args.pattern || "**/*";
    const parts = pattern.split("/");
    const ext = parts[parts.length - 1].includes("*") ? parts[parts.length - 1].replace("*", "") : null;

    const walk = (dir, depth) => {
      if (depth > 10 || results.length > 200) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (["node_modules", ".wolverine", ".git", "dist", "build"].includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(this.cwd, fullPath).replace(/\\/g, "/");

        if (entry.isDirectory()) {
          if (pattern.includes("**")) walk(fullPath, depth + 1);
        } else {
          if (!ext || entry.name.endsWith(ext)) {
            results.push(relPath);
          }
        }
      }
    };

    try {
      this.sandbox.resolve(this.cwd);
      walk(this.cwd, 0);
      console.log(chalk.gray(`    🔍 Glob "${pattern}": ${results.length} files`));
      return { content: results.length > 0 ? results.join("\n") : `No files matching "${pattern}"` };
    } catch (err) {
      return { content: `Error: ${err.message}` };
    }
  }

  _grepCode(args) {
    const results = [];
    const maxResults = args.max_results || 30;
    const contextLines = args.context || 0;
    let regex;
    try {
      regex = new RegExp(args.pattern, "gi");
    } catch {
      regex = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    }

    const walk = (dir) => {
      if (results.length >= maxResults) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (["node_modules", ".wolverine", ".git", "dist", "build"].includes(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(fullPath); continue; }

        if (args.file_glob) {
          const ext = args.file_glob.replace("*", "");
          if (!entry.name.endsWith(ext)) continue;
        }

        try {
          this.sandbox.resolve(fullPath);
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          const relPath = path.relative(this.cwd, fullPath).replace(/\\/g, "/");

          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              if (contextLines > 0) {
                const start = Math.max(0, i - contextLines);
                const end = Math.min(lines.length, i + contextLines + 1);
                const ctx = lines.slice(start, end).map((l, j) => {
                  const lineNum = start + j + 1;
                  const marker = (start + j === i) ? ">" : " ";
                  return `${marker} ${lineNum} | ${l}`;
                }).join("\n");
                results.push(`${relPath}:${i + 1}:\n${ctx}`);
              } else {
                results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
              }
            }
          }
        } catch { /* skip binary */ }
      }
    };

    walk(this.cwd);
    console.log(chalk.gray(`    🔍 Grep "${args.pattern}": ${results.length} matches`));
    return { content: results.length > 0 ? results.join("\n\n") : `No matches for "${args.pattern}"` };
  }

  // ── SHELL TOOLS ──

  _bashExec(args) {
    // Security: check for blocked commands (claw-code: destructiveCommandWarning, bashSecurity)
    for (const blocked of BLOCKED_COMMANDS) {
      if (blocked.test(args.command)) {
        console.log(chalk.red(`    🛡️ Blocked dangerous command: ${args.command}`));
        return { content: `BLOCKED: Command "${args.command}" is not allowed for safety reasons.` };
      }
    }

    const timeout = Math.min(args.timeout || 30000, 60000);
    try {
      const output = execSync(args.command, {
        cwd: this.cwd,
        encoding: "utf-8",
        timeout,
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
      console.log(chalk.gray(`    ⚡ Bash: ${args.command.slice(0, 60)}`));
      return { content: output.slice(0, 5000) || "(no output)" };
    } catch (err) {
      const stderr = err.stderr ? err.stderr.slice(0, 3000) : "";
      const stdout = err.stdout ? err.stdout.slice(0, 1000) : "";
      return { content: `Exit code: ${err.status}\nstdout: ${stdout}\nstderr: ${stderr}` };
    }
  }

  _gitLog(args) {
    const count = args.count || 10;
    const fileFilter = args.file ? ` -- ${args.file}` : "";
    try {
      const output = execSync(
        `git log --oneline --no-decorate -n ${count}${fileFilter}`,
        { cwd: this.cwd, encoding: "utf-8", timeout: 5000 }
      );
      console.log(chalk.gray(`    📜 Git log: ${count} commits`));
      return { content: output || "(no git history)" };
    } catch (err) {
      return { content: `Git log failed: ${err.message}` };
    }
  }

  _gitDiff(args) {
    const ref = args.ref || "";
    const fileFilter = args.file ? ` -- ${args.file}` : "";
    try {
      const output = execSync(
        `git diff ${ref}${fileFilter}`,
        { cwd: this.cwd, encoding: "utf-8", timeout: 5000 }
      );
      console.log(chalk.gray(`    📜 Git diff`));
      return { content: output.slice(0, 5000) || "(no changes)" };
    } catch (err) {
      return { content: `Git diff failed: ${err.message}` };
    }
  }

  // ── WEB TOOLS ──

  _webFetch(args) {
    return new Promise((resolve) => {
      const url = args.url;
      if (!url || !url.startsWith("http")) {
        resolve({ content: "Error: URL must start with http:// or https://" });
        return;
      }

      const client = url.startsWith("https") ? https : http;
      const req = client.get(url, { timeout: 10000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          // Strip HTML tags for readability
          const text = data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 5000);
          console.log(chalk.gray(`    🌐 Fetched: ${url.slice(0, 60)}`));
          if (this.logger) this.logger.debug("agent.research", `Fetched ${url}`, { url });
          resolve({ content: text || "(empty response)" });
        });
      });

      req.on("error", (err) => {
        resolve({ content: `Fetch error: ${err.message}` });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({ content: "Fetch timed out after 10s" });
      });
    });
  }

  // ── COMPLETION ──

  // ── DIAGNOSTIC TOOLS ──

  _listDir(args) {
    const dirPath = path.resolve(this.cwd, args.path || ".");
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const lines = entries.map(e => {
        try {
          const stat = fs.statSync(path.join(dirPath, e.name));
          const size = e.isDirectory() ? "DIR" : `${Math.round(stat.size / 1024)}KB`;
          return `${e.isDirectory() ? "📁" : "📄"} ${e.name} (${size})`;
        } catch { return `${e.name} (?)` ; }
      });
      console.log(chalk.gray(`    📁 Listed ${lines.length} entries in ${args.path || "."}`));
      return { content: lines.join("\n") || "(empty directory)" };
    } catch (e) { return { content: `Error: ${e.message}` }; }
  }

  _moveFile(args) {
    if (this._isProtectedPath(args.from) || this._isProtectedPath(args.to)) {
      return { content: "BLOCKED: Cannot move protected files" };
    }
    const from = path.resolve(this.cwd, args.from);
    const to = path.resolve(this.cwd, args.to);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      this.filesModified.push(args.to);
      console.log(chalk.green(`    📦 Moved: ${args.from} → ${args.to}`));
      return { content: `Moved ${args.from} → ${args.to}` };
    } catch (e) { return { content: `Error moving: ${e.message}` }; }
  }

  _checkPort(args) {
    const port = args.port;
    try {
      const platform = process.platform;
      let cmd;
      if (platform === "win32") {
        cmd = `netstat -ano | findstr :${port}`;
      } else {
        cmd = `lsof -i :${port} 2>/dev/null || ss -tlnp 2>/dev/null | grep :${port}`;
      }
      const result = execSync(cmd, { timeout: 5000, stdio: "pipe" }).toString().trim();
      console.log(chalk.gray(`    🔌 Port ${port}: ${result ? "IN USE" : "free"}`));
      return { content: result || `Port ${port} is free` };
    } catch { return { content: `Port ${port} appears free (no listeners found)` }; }
  }

  _checkEnv(args) {
    const { redact } = require("../security/secret-redactor");
    if (args.variable) {
      const val = process.env[args.variable];
      const display = val ? redact(val) : "(not set)";
      return { content: `${args.variable}=${display}` };
    }
    // List all env vars with redacted values
    const keys = Object.keys(process.env).sort();
    const lines = keys.map(k => {
      const val = process.env[k];
      return `${k}=${val && val.length > 50 ? "(set, " + val.length + " chars)" : redact(val || "")}`;
    });
    return { content: lines.join("\n") };
  }

  _inspectDb(args) {
    const dbPath = path.resolve(this.cwd, args.db_path);
    try {
      let Database;
      try { Database = require("better-sqlite3"); } catch {
        return { content: "better-sqlite3 not installed. Run: npm install better-sqlite3" };
      }
      const db = new Database(dbPath, { readonly: true });
      let result;
      if (args.action === "tables") {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
        result = tables.map(t => t.name).join("\n") || "(no tables)";
      } else if (args.action === "schema") {
        const schemas = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all();
        result = schemas.map(s => s.sql).join("\n\n") || "(no tables)";
      } else if (args.action === "query") {
        if (!args.sql) return { content: "Error: sql required for query action" };
        const upper = args.sql.trim().toUpperCase();
        if (!upper.startsWith("SELECT") && !upper.startsWith("PRAGMA")) {
          return { content: "BLOCKED: inspect_db only allows SELECT/PRAGMA. Use run_db_fix for writes." };
        }
        const rows = db.prepare(args.sql).all();
        result = JSON.stringify(rows.slice(0, 50), null, 2);
        if (rows.length > 50) result += `\n... (${rows.length} total rows, showing first 50)`;
      } else {
        result = "Unknown action. Use: tables, schema, or query";
      }
      db.close();
      const { redact } = require("../security/secret-redactor");
      console.log(chalk.gray(`    🗃️ DB ${args.action}: ${args.db_path}`));
      return { content: redact(result) };
    } catch (e) { return { content: `DB error: ${e.message}` }; }
  }

  _runDbFix(args) {
    const dbPath = path.resolve(this.cwd, args.db_path);
    try {
      let Database;
      try { Database = require("better-sqlite3"); } catch {
        return { content: "better-sqlite3 not installed. Run: npm install better-sqlite3" };
      }
      // Block dangerous operations
      const upper = args.sql.trim().toUpperCase();
      if (upper.startsWith("DROP DATABASE") || upper.includes("DROP TABLE sqlite_")) {
        return { content: "BLOCKED: Cannot drop system tables" };
      }

      // Backup the DB file first
      const backupPath = dbPath + ".wolverine-backup";
      fs.copyFileSync(dbPath, backupPath);

      const db = new Database(dbPath);

      // SAFETY: Snapshot affected rows BEFORE the write
      // Extract table name and WHERE clause to SELECT the rows that will change
      let beforeSnapshot = "";
      try {
        const tableMatch = upper.match(/(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+(\w+)/i);
        const whereMatch = args.sql.match(/WHERE\s+(.+?)(?:;|$)/i);
        if (tableMatch) {
          const table = tableMatch[1];
          const whereClause = whereMatch ? `WHERE ${whereMatch[1]}` : "";
          const selectSql = `SELECT * FROM ${table} ${whereClause} LIMIT 20`;
          try {
            const before = db.prepare(selectSql).all();
            if (before.length > 0) {
              beforeSnapshot = `\n\nBEFORE STATE (${before.length} rows affected):\n${JSON.stringify(before, null, 2).slice(0, 2000)}`;
              console.log(chalk.gray(`    🗃️ Snapshot: ${before.length} rows from ${table} ${whereClause ? whereClause.slice(0, 40) : "(all)"}`));
            }
          } catch { /* SELECT failed, might be INSERT into new table — that's fine */ }
        }
      } catch { /* snapshot failed, proceed with caution */ }

      // Execute the fix
      const result = db.prepare(args.sql).run();

      // SAFETY: Snapshot AFTER to show what changed
      let afterSnapshot = "";
      try {
        const tableMatch = upper.match(/(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+(\w+)/i);
        const whereMatch = args.sql.match(/WHERE\s+(.+?)(?:;|$)/i);
        if (tableMatch) {
          const table = tableMatch[1];
          const whereClause = whereMatch ? `WHERE ${whereMatch[1]}` : "";
          const selectSql = `SELECT * FROM ${table} ${whereClause} LIMIT 20`;
          try {
            const after = db.prepare(selectSql).all();
            afterSnapshot = `\n\nAFTER STATE (${after.length} rows):\n${JSON.stringify(after, null, 2).slice(0, 2000)}`;
          } catch {}
        }
      } catch {}

      db.close();
      this.filesModified.push(args.db_path);

      const summary = `SQL executed. Changes: ${result.changes}. Backup at: ${backupPath}${beforeSnapshot}${afterSnapshot}`;
      console.log(chalk.green(`    🗃️ DB fix applied: ${args.sql.slice(0, 60)} (changes: ${result.changes})`));
      if (beforeSnapshot) console.log(chalk.gray(`    🗃️ Before/after snapshot captured for audit`));

      return { content: summary };
    } catch (e) { return { content: `DB error: ${e.message}` }; }
  }

  _auditDeps() {
    try {
      const { healthReport } = require("../skills/deps");
      const report = healthReport(this.cwd);
      const { redact } = require("../security/secret-redactor");
      const lines = [
        `Dependency Health Score: ${report.score}/100 (${report.summary})`,
        "",
        `Vulnerabilities: ${report.audit.vulnerabilities} (${report.audit.critical} critical, ${report.audit.high} high, ${report.audit.moderate} moderate)`,
        report.audit.fixes.length > 0 ? `Fix: ${report.audit.fixes.join(", ")}` : "",
        "",
        `Outdated: ${report.outdated.length} packages`,
        ...report.outdated.slice(0, 10).map(p => `  ${p.name}: ${p.current} → ${p.latest}`),
        report.outdated.length > 10 ? `  ... and ${report.outdated.length - 10} more` : "",
        "",
        `Peer Dependency Issues: ${report.peerDeps.length}`,
        ...report.peerDeps.slice(0, 5).map(p => `  ${p.package}: ${p.requires}`),
        "",
        `Unused Packages: ${report.unused.length}`,
        report.unused.length > 0 ? `  ${report.unused.join(", ")}` : "",
        "",
        `Lock File: ${report.lockFile.healthy ? "OK" : report.lockFile.issue}`,
        report.lockFile.fix ? `  Fix: ${report.lockFile.fix}` : "",
      ].filter(l => l !== undefined);
      console.log(chalk.gray(`    📦 Deps audit: score ${report.score}/100, ${report.audit.vulnerabilities} vulns, ${report.outdated.length} outdated`));
      return { content: redact(lines.join("\n")) };
    } catch (e) { return { content: `Deps audit error: ${e.message}` }; }
  }

  _checkMigration(args) {
    try {
      const { getMigration } = require("../skills/deps");
      const migration = getMigration(args.package);
      if (!migration) return { content: `No known migration path for '${args.package}'.` };
      const lines = [
        `Migration: ${args.package} → ${migration.to}`,
        `Reason: ${migration.reason}`,
        "",
        "Code patterns:",
        ...migration.patterns.map(p => `  ${p.from}\n  → ${p.to}`),
      ];
      console.log(chalk.gray(`    📦 Migration: ${args.package} → ${migration.to}`));
      return { content: lines.join("\n") };
    } catch (e) { return { content: `Migration check error: ${e.message}` }; }
  }

  // ── SERVER DIAGNOSTICS ──

  _checkMemory() {
    const os = require("os");
    const mem = process.memoryUsage();
    const totalMB = Math.round(os.totalmem() / 1048576);
    const freeMB = Math.round(os.freemem() / 1048576);
    const usedPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);
    const lines = [
      `Process RSS: ${Math.round(mem.rss / 1048576)}MB`,
      `Process Heap: ${Math.round(mem.heapUsed / 1048576)}MB / ${Math.round(mem.heapTotal / 1048576)}MB`,
      `Process External: ${Math.round(mem.external / 1048576)}MB`,
      `System: ${freeMB}MB free / ${totalMB}MB total (${usedPct}% used)`,
      usedPct > 90 ? "⚠️ MEMORY PRESSURE DETECTED — system above 90% usage" : "✅ Memory OK",
    ];
    return { content: lines.join("\n") };
  }

  _listProcesses() {
    try {
      const cmd = process.platform === "win32"
        ? 'tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH'
        : "ps aux | grep -E 'node|PID' | grep -v grep";
      const output = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
      return { content: output || "(no node processes found)" };
    } catch (e) { return { content: `Error listing processes: ${e.message}` }; }
  }

  _checkLogs(args) {
    const lines = args.lines || 50;
    const filter = args.filter || "";
    try {
      let cmd;
      if (process.platform === "win32") {
        cmd = `powershell -c "Get-Content -Tail ${lines} .wolverine\\events.log"`;
      } else {
        // Try journalctl first (systemd), fall back to log file
        cmd = `journalctl -u wolverine --no-pager -n ${lines} 2>/dev/null || tail -n ${lines} .wolverine/events.log 2>/dev/null || echo 'No logs found'`;
      }
      if (filter) cmd += ` | grep -i '${filter.replace(/'/g, "'\\''")}'`;
      const output = execSync(cmd, { encoding: "utf-8", timeout: 10000, cwd: this.cwd }).trim();
      return { content: output.slice(0, 4000) || "(empty)" };
    } catch (e) { return { content: `Error reading logs: ${e.message}` }; }
  }

  _restartService() {
    // Signal the parent wolverine process to restart the child server
    // We can't directly restart — but we can signal via a file that the runner checks
    try {
      const restartFlag = path.join(this.cwd, ".wolverine", "restart-requested");
      fs.writeFileSync(restartFlag, Date.now().toString(), "utf-8");
      return { content: "Restart requested. The server will restart after this heal completes." };
    } catch (e) { return { content: `Error requesting restart: ${e.message}` }; }
  }

  _checkNetwork(args) {
    const results = [];
    try {
      // DNS check
      if (args.host) {
        try {
          const dns = require("dns");
          const addresses = execSync(`node -e "require('dns').resolve('${args.host.replace(/'/g, "")}', (e,a) => console.log(e ? 'FAIL:'+e.code : a.join(',')))"`, { encoding: "utf-8", timeout: 5000 }).trim();
          results.push(`DNS ${args.host}: ${addresses}`);
        } catch (e) { results.push(`DNS ${args.host}: FAILED — ${e.message}`); }
      }
      // Port check
      if (args.port) {
        try {
          const portCmd = process.platform === "win32"
            ? `netstat -ano | findstr ":${args.port}"`
            : `ss -tlnp | grep ":${args.port}" || echo "port ${args.port} is free"`;
          const portResult = execSync(portCmd, { encoding: "utf-8", timeout: 3000 }).trim();
          results.push(`Port ${args.port}: ${portResult || "free"}`);
        } catch { results.push(`Port ${args.port}: free (nothing listening)`); }
      }
      // URL reachability
      if (args.url) {
        try {
          const urlResult = execSync(`node -e "require('${args.url.startsWith('https') ? 'https' : 'http'}').get('${args.url.replace(/'/g, "")}', r => { console.log(r.statusCode); r.resume(); }).on('error', e => console.log('FAIL:'+e.code))"`, { encoding: "utf-8", timeout: 10000 }).trim();
          results.push(`URL ${args.url}: ${urlResult}`);
        } catch (e) { results.push(`URL ${args.url}: FAILED — ${e.message}`); }
      }
      if (results.length === 0) results.push("Provide host, port, or url to check.");
      return { content: results.join("\n") };
    } catch (e) { return { content: `Network check error: ${e.message}` }; }
  }

  _inspectEnv(args) {
    if (args.check && Array.isArray(args.check)) {
      const results = args.check.map(v => `${v}: ${process.env[v] ? "SET (" + process.env[v].length + " chars)" : "NOT SET"}`);
      return { content: results.join("\n") };
    }
    // List all env var names (not values) grouped by category
    const keys = Object.keys(process.env).sort();
    const wolverine = keys.filter(k => /^WOLVERINE|^PORT$|^NODE_ENV$/i.test(k));
    const apiKeys = keys.filter(k => /KEY|SECRET|TOKEN|PASSWORD|AUTH/i.test(k));
    const other = keys.filter(k => !wolverine.includes(k) && !apiKeys.includes(k));
    const lines = [
      `Wolverine vars (${wolverine.length}): ${wolverine.join(", ") || "none"}`,
      `Secret vars (${apiKeys.length}): ${apiKeys.map(k => k + "=" + (process.env[k] ? "SET" : "MISSING")).join(", ") || "none"}`,
      `Total env vars: ${keys.length}`,
    ];
    return { content: lines.join("\n") };
  }

  // ── ADVANCED DIAGNOSTICS ──

  _verifyNodeModules() {
    try {
      const lockPath = path.join(this.cwd, "package-lock.json");
      const pkgPath = path.join(this.cwd, "package.json");
      if (!fs.existsSync(lockPath)) return { content: "No package-lock.json found. Run: npm install" };
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const missing = [];
      const broken = [];
      for (const [name] of Object.entries(deps)) {
        const modPath = path.join(this.cwd, "node_modules", name);
        if (!fs.existsSync(modPath)) { missing.push(name); continue; }
        const modPkg = path.join(modPath, "package.json");
        if (!fs.existsSync(modPkg)) { broken.push(name + " (no package.json)"); continue; }
      }
      // Check .bin links
      const binDir = path.join(this.cwd, "node_modules", ".bin");
      let brokenBins = 0;
      if (fs.existsSync(binDir)) {
        for (const bin of fs.readdirSync(binDir)) {
          const target = path.join(binDir, bin);
          try { fs.readlinkSync(target); } catch { brokenBins++; }
        }
      }
      const rec = missing.length > 5 || broken.length > 3 ? "rm -rf node_modules && npm install" : missing.length > 0 ? "npm install" : "ok";
      const lines = [
        `Dependencies: ${Object.keys(deps).length}`,
        `Missing from disk: ${missing.length > 0 ? missing.join(", ") : "none"}`,
        `Broken packages: ${broken.length > 0 ? broken.join(", ") : "none"}`,
        `Broken .bin links: ${brokenBins}`,
        `Recommendation: ${rec}`,
      ];
      return { content: lines.join("\n") };
    } catch (e) { return { content: `Error: ${e.message}` }; }
  }

  _inspectCertificate(args) {
    try {
      const tls = require("tls");
      const host = args.host;
      const port = args.port || 443;
      return new Promise((resolve) => {
        const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 5000 }, () => {
          const cert = socket.getPeerCertificate();
          const validTo = new Date(cert.valid_to);
          const daysLeft = Math.round((validTo - Date.now()) / 86400000);
          const lines = [
            `Subject: ${cert.subject?.CN || "unknown"}`,
            `Issuer: ${cert.issuer?.O || cert.issuer?.CN || "unknown"}`,
            `Valid: ${cert.valid_from} → ${cert.valid_to}`,
            `Days until expiry: ${daysLeft}${daysLeft < 30 ? " ⚠️ EXPIRING SOON" : daysLeft < 0 ? " ❌ EXPIRED" : ""}`,
            `SAN: ${(cert.subjectaltname || "").replace(/DNS:/g, "").split(",").map(s => s.trim()).join(", ") || "none"}`,
            `Self-signed: ${cert.issuer?.CN === cert.subject?.CN ? "yes" : "no"}`,
            `Authorized: ${socket.authorized}`,
            socket.authorizationError ? `TLS error: ${socket.authorizationError}` : "",
          ].filter(Boolean);
          socket.destroy();
          resolve({ content: lines.join("\n") });
        });
        socket.on("error", (e) => { resolve({ content: `TLS error for ${host}:${port}: ${e.message}` }); });
        socket.setTimeout(5000, () => { socket.destroy(); resolve({ content: `Timeout connecting to ${host}:${port}` }); });
      });
    } catch (e) { return { content: `Error: ${e.message}` }; }
  }

  _inspectCache(args) {
    try {
      const host = args.host || "127.0.0.1";
      const port = args.port || 6379;
      const net = require("net");
      return new Promise((resolve) => {
        const client = net.createConnection({ host, port, timeout: 3000 }, () => {
          let buf = "";
          client.on("data", (d) => { buf += d.toString(); });
          client.write("PING\r\nINFO memory\r\nINFO clients\r\nINFO keyspace\r\n");
          setTimeout(() => {
            client.destroy();
            const pong = buf.includes("+PONG");
            const memMatch = buf.match(/used_memory_human:(\S+)/);
            const clientMatch = buf.match(/connected_clients:(\d+)/);
            const lines = [
              `Reachable: ${pong ? "yes" : "no"}`,
              `Auth required: ${buf.includes("NOAUTH") ? "yes (failed)" : "no"}`,
              `Memory: ${memMatch ? memMatch[1] : "unknown"}`,
              `Connected clients: ${clientMatch ? clientMatch[1] : "unknown"}`,
            ];
            resolve({ content: lines.join("\n") });
          }, 1500);
        });
        client.on("error", (e) => { resolve({ content: `Redis ${host}:${port} error: ${e.message}` }); });
        client.setTimeout(3000, () => { client.destroy(); resolve({ content: `Redis ${host}:${port} timeout` }); });
      });
    } catch (e) { return { content: `Error: ${e.message}` }; }
  }

  _diskCleanup(args) {
    try {
      const dryRun = args.dry_run !== false;
      const os = require("os");
      const targets = [];
      let reclaimable = 0;
      // Old wolverine backups
      const backupDir = path.join(os.homedir(), ".wolverine-safe-backups", "snapshots");
      if (fs.existsSync(backupDir)) {
        const now = Date.now();
        for (const dir of fs.readdirSync(backupDir)) {
          const full = path.join(backupDir, dir);
          try {
            const stat = fs.statSync(full);
            const ageDays = (now - stat.mtimeMs) / 86400000;
            if (ageDays > 7 && stat.isDirectory()) {
              let size = 0;
              const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else size += s.size; } };
              walk(full);
              const mb = Math.round(size / 1048576);
              targets.push({ path: `~/.wolverine-safe-backups/snapshots/${dir}`, size_mb: mb, reason: `${Math.round(ageDays)}d old backup` });
              reclaimable += mb;
            }
          } catch {}
        }
      }
      // npm cache
      const cacheDir = path.join(this.cwd, "node_modules", ".cache");
      if (fs.existsSync(cacheDir)) {
        try {
          let size = 0;
          const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); try { const s = fs.statSync(p); if (s.isDirectory()) walk(p); else size += s.size; } catch {} } };
          walk(cacheDir);
          const mb = Math.round(size / 1048576);
          if (mb > 1) { targets.push({ path: "node_modules/.cache/", size_mb: mb, reason: "build cache" }); reclaimable += mb; }
        } catch {}
      }
      // Clean if not dry run
      if (!dryRun && targets.length > 0) {
        for (const t of targets) {
          try { execSync(`rm -rf "${t.path.replace("~", os.homedir())}"`, { timeout: 10000 }); } catch {}
        }
      }
      const diskFree = Math.round(parseInt(execSync("df -m . | tail -1 | awk '{print $4}'", { encoding: "utf-8", cwd: this.cwd, timeout: 3000 }).trim() || "0", 10));
      const lines = [
        `Disk free: ${diskFree}MB`,
        `Reclaimable: ${reclaimable}MB (${targets.length} targets)`,
        dryRun ? "Mode: DRY RUN (pass dry_run=false to clean)" : `Cleaned ${targets.length} targets`,
        ...targets.map(t => `  ${t.path} (${t.size_mb}MB) — ${t.reason}`),
      ];
      return { content: lines.join("\n") };
    } catch (e) { return { content: `Error: ${e.message}` }; }
  }

  _checkFileDescriptors() {
    try {
      if (process.platform === "win32") return { content: "FD check not available on Windows" };
      const pid = process.pid;
      const fdDir = `/proc/${pid}/fd`;
      let count = 0;
      try { count = fs.readdirSync(fdDir).length; } catch {}
      let limits = "";
      try { limits = execSync(`cat /proc/${pid}/limits | grep 'open files'`, { encoding: "utf-8", timeout: 3000 }).trim(); } catch {}
      const softMatch = limits.match(/(\d+)\s+(\d+)/);
      const soft = softMatch ? parseInt(softMatch[1]) : 0;
      const hard = softMatch ? parseInt(softMatch[2]) : 0;
      const pct = soft > 0 ? Math.round(count / soft * 100) : 0;
      const lines = [
        `Open FDs: ${count}`,
        `Soft limit: ${soft}`,
        `Hard limit: ${hard}`,
        `Usage: ${pct}%${pct > 80 ? " ⚠️ HIGH — risk of EMFILE" : pct > 50 ? " — moderate" : " — ok"}`,
      ];
      // Find top consumers
      try {
        const top = execSync(`ls -la /proc/${pid}/fd 2>/dev/null | tail -20 | awk '{print $NF}' | sort | uniq -c | sort -rn | head -10`, { encoding: "utf-8", timeout: 3000 }).trim();
        if (top) lines.push("Top FD targets:", top);
      } catch {}
      return { content: lines.join("\n") };
    } catch (e) { return { content: `Error: ${e.message}` }; }
  }

  _checkEventLoop() {
    try {
      // Static analysis: find blocking patterns in server code
      const patterns = [
        { regex: /readFileSync\s*\(/g, name: "fs.readFileSync" },
        { regex: /writeFileSync\s*\(/g, name: "fs.writeFileSync" },
        { regex: /execSync\s*\(/g, name: "child_process.execSync" },
        { regex: /pbkdf2Sync\s*\(/g, name: "crypto.pbkdf2Sync" },
        { regex: /JSON\.parse\s*\(\s*fs\./g, name: "JSON.parse(fs.read...)" },
        { regex: /\.forEach\s*\(\s*(async\s*)?\(/g, name: "forEach (blocks with async)" },
      ];
      const serverDir = path.join(this.cwd, "server");
      const findings = [];
      const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const f of fs.readdirSync(dir)) {
          if (f === "node_modules" || f.startsWith(".")) continue;
          const full = path.join(dir, f);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) { walk(full); continue; }
          if (!f.endsWith(".js")) continue;
          const code = fs.readFileSync(full, "utf-8");
          for (const p of patterns) {
            const matches = code.match(p.regex);
            if (matches) {
              findings.push(`${path.relative(this.cwd, full)}: ${matches.length}x ${p.name}`);
            }
          }
        }
      };
      walk(serverDir);
      const handles = process._getActiveHandles?.()?.length || "unknown";
      const requests = process._getActiveRequests?.()?.length || "unknown";
      const lines = [
        `Active handles: ${handles}`,
        `Active requests: ${requests}`,
        findings.length > 0 ? `\nBlocking patterns found (${findings.length}):` : "No blocking patterns found in server/",
        ...findings.slice(0, 20),
      ];
      return { content: lines.join("\n") };
    } catch (e) { return { content: `Error: ${e.message}` }; }
  }

  _checkWebsocket(args) {
    try {
      const url = args.url;
      const timeout = args.timeout_ms || 5000;
      const urlObj = new (require("url").URL)(url);
      const isSecure = urlObj.protocol === "wss:";
      const client = isSecure ? require("https") : require("http");
      return new Promise((resolve) => {
        const req = client.request({
          hostname: urlObj.hostname,
          port: urlObj.port || (isSecure ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: "GET",
          headers: {
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "Sec-WebSocket-Key": require("crypto").randomBytes(16).toString("base64"),
            "Sec-WebSocket-Version": "13",
          },
          timeout,
        }, (res) => {
          resolve({ content: `HTTP ${res.statusCode} (expected 101 for WS upgrade)\nHeaders: ${JSON.stringify(res.headers, null, 2).slice(0, 500)}` });
          res.resume();
        });
        req.on("upgrade", (res, socket) => {
          const lines = [
            `WebSocket upgrade: SUCCESS (101)`,
            `Protocol: ${res.headers["sec-websocket-protocol"] || "none"}`,
            `Latency: connected`,
          ];
          socket.destroy();
          resolve({ content: lines.join("\n") });
        });
        req.on("error", (e) => { resolve({ content: `WebSocket error for ${url}: ${e.message}` }); });
        req.on("timeout", () => { req.destroy(); resolve({ content: `WebSocket timeout for ${url} (${timeout}ms)` }); });
        req.end();
      });
    } catch (e) { return { content: `Error: ${e.message}` }; }
  }

  _done(args) {
    console.log(chalk.green(`    ✅ Agent done: ${args.summary}`));
    if (this.logger) {
      this.logger.info("agent.complete", args.summary, {
        filesModified: args.files_modified,
        turnCount: this.turnCount,
        totalTokens: this.totalTokens,
        toolCallCount: this.toolCalls.length,
      });
    }
    return {
      content: "Done",
      done: true,
      summary: args.summary,
      filesModified: args.files_modified,
    };
  }

  // ── Protected path guard ──
  // Wolverine's own source code is off-limits to the agent.
  // The agent should build/fix the USER's project, not modify itself.
  _isProtectedPath(filePath) {
    let normalized = filePath.replace(/\\/g, "/");

    const cwdNorm = this.cwd.replace(/\\/g, "/");
    if (normalized.startsWith(cwdNorm)) {
      normalized = normalized.slice(cwdNorm.length).replace(/^\//, "");
    }

    // WHITELIST: server/ is always editable — that's the user's project
    if (normalized.startsWith("server/")) return false;

    const protectedPrefixes = [
      "src/",          // wolverine core
      "bin/",          // wolverine CLI
      "tests/",        // wolverine tests
      "node_modules/", // dependencies
      ".wolverine/",   // internal state
      "examples/",     // test examples (not the live server)
    ];
    const protectedExact = [
      ".env", ".env.local", ".env.production", ".env.development",
      "package.json", "package-lock.json",
    ];

    return protectedPrefixes.some(p => normalized.startsWith(p))
      || protectedExact.some(p => normalized === p);
  }
}

// ── Dynamic System Prompts ──

/** Compact prompt for simple code errors (~400 tokens vs ~1200). Saves 50% on 70% of heals. */
function _simplePrompt(cwd, primaryFile) {
  return `You are Wolverine, a Node.js server repair agent. Fix the error using minimal changes.

TOOLS: read_file, write_file, edit_file, glob_files, grep_code, bash_exec, done
RULES: Read the file before editing. Use edit_file for targeted fixes. Call done when finished. Use multiple tools at once when independent.
${primaryFile ? `File: ${primaryFile}` : ""}
Project: ${cwd}`;
}

/** Full prompt for complex/unknown errors — all 18 tools + strategy table. */
function _fullPrompt(cwd, primaryFile) {
  return `You are Wolverine, an autonomous Node.js server repair agent. Diagnose and fix the error.

You are a full server doctor. Errors can be code bugs, missing deps, database problems, config issues, port conflicts, permissions, or corrupted state.

CRITICAL: Act fast. You have limited turns. Fix immediately when the solution is obvious from the error. Only investigate when the cause is unclear.

For maximum efficiency, invoke multiple independent tools simultaneously rather than sequentially.

TOOLS: read_file, write_file, edit_file, glob_files, grep_code, list_dir, move_file, bash_exec, git_log, git_diff, inspect_db, run_db_fix, check_port, check_env, audit_deps, check_migration, web_fetch, done

FAST FIXES (act immediately, don't investigate):
- Cannot find module 'X' → bash_exec: npm install X → done
- Cannot find module './X' → grep for correct path → edit_file → done
- ENOENT missing config/json file → read the code that loads it to see what fields it expects → write_file with required fields → done
- EADDRINUSE → check_port → bash_exec: kill PID → done
- TypeError/ReferenceError → read_file → edit_file → done
- Missing env var → check_env → report it → done

INVESTIGATION (only when cause is unclear):
- Database error → inspect_db FIRST to see current state → understand what went wrong → run_db_fix with targeted fix
- Unknown errors → grep_code, list_dir to find root cause

DATABASE SAFETY:
- ALWAYS inspect_db before run_db_fix — never write blind
- run_db_fix auto-snapshots affected rows before/after — check the response to verify your fix
- For bad data: understand WHY the data is wrong before changing it
- For NaN/null errors: check if the data was corrupted or if the code should handle it
- Prefer fixing code to handle edge cases over modifying production data
- A database backup is created automatically before every write

RULES:
1. Fix on turn 1-2 when possible. Investigation is a last resort.
2. For ENOENT config files: read the code that requires the file, then create it with the expected structure.
3. bash_exec for operational fixes, edit_file for code, write_file for missing files, run_db_fix for data
4. For database errors: inspect first, fix data only when code can't reasonably handle the edge case
5. Always call done with summary when finished — never end without calling done.
${primaryFile ? `\nFile: ${primaryFile}` : ""}
Project: ${cwd}`;
}

// ── Zero-Cost Compaction Helpers (claw-code pattern) ──

/**
 * Estimate tokens without a tokenizer. Fast approximation: text.length / 4 + 1.
 * Good enough for budget decisions — off by ~10% which is fine.
 */
function _estimateTokens(message) {
  if (!message) return 0;
  const content = message.content || "";
  const toolArgs = message.tool_calls?.reduce((s, tc) => s + (tc.function?.arguments?.length || 0), 0) || 0;
  return Math.ceil((content.length + toolArgs) / 4) + 1;
}

/**
 * Extract structural signals from message history WITHOUT an LLM call.
 * Returns a concise summary preserving: tools used, files touched, errors found,
 * what was tried, and pending work. Costs $0.00.
 */
function _structuralSummary(messages, filesRead, filesModified, toolCalls) {
  const toolsUsed = new Set();
  const filesReferenced = new Set();
  const errors = [];
  const userRequests = [];
  const actions = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = (msg.content || "").slice(0, 160);
      if (text) userRequests.push(text);
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolsUsed.add(tc.function?.name);
        // Extract file paths from tool args
        try {
          const args = JSON.parse(tc.function?.arguments || "{}");
          if (args.path) filesReferenced.add(args.path);
          if (args.pattern) filesReferenced.add(args.pattern);
        } catch {}
      }
    }
    if (msg.role === "tool") {
      const content = msg.content || "";
      if (content.startsWith("[ERROR]") || content.includes("Error:")) {
        errors.push(content.slice(0, 100));
      }
      // Extract file paths from tool results
      const pathMatches = content.match(/(?:server|src)\/[^\s"']+/g);
      if (pathMatches) pathMatches.forEach(p => filesReferenced.add(p));
    }
    if (msg.role === "assistant" && msg.content) {
      const text = msg.content.slice(0, 100);
      if (text && !text.startsWith("[")) actions.push(text);
    }
  }

  const lines = [
    "[Compacted conversation summary — $0.00, no LLM call]",
    `Messages compacted: ${messages.length}`,
    `Tools used: ${[...toolsUsed].join(", ") || "none"}`,
    `Files read: ${[...filesRead].slice(0, 10).join(", ") || "none"}`,
    `Files modified: ${[...filesModified].join(", ") || "none"}`,
    `Files referenced: ${[...filesReferenced].slice(0, 10).join(", ") || "none"}`,
    errors.length > 0 ? `Errors encountered: ${errors.slice(0, 3).join("; ")}` : null,
    userRequests.length > 0 ? `User requests: ${userRequests.slice(-2).join(" | ")}` : null,
    actions.length > 0 ? `Actions taken: ${actions.slice(-3).join(" | ")}` : null,
  ].filter(Boolean);

  return lines.join("\n");
}

// ── Pre/Post Tool Hooks (claw-code pattern) ──

/**
 * Pre-tool hook: check if tool execution should be blocked.
 * Reads hooks from .wolverine/hooks.json if it exists.
 * Exit code 0 = allow, 2 = deny.
 */
function _runPreHook(toolName, toolInput, cwd) {
  try {
    const hooksPath = path.join(cwd, ".wolverine", "hooks.json");
    if (!fs.existsSync(hooksPath)) return { denied: false };
    const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
    if (!hooks.pre_tool_use || hooks.pre_tool_use.length === 0) return { denied: false };

    for (const cmd of hooks.pre_tool_use) {
      try {
        const { execSync } = require("child_process");
        execSync(cmd, {
          input: JSON.stringify({ event: "PreToolUse", tool_name: toolName, tool_input: toolInput }),
          env: { ...process.env, HOOK_TOOL_NAME: toolName || "", HOOK_TOOL_INPUT: (toolInput || "").slice(0, 1000) },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        });
      } catch (e) {
        if (e.status === 2) return { denied: true, message: (e.stdout?.toString() || "Hook denied").trim() };
      }
    }
  } catch {}
  return { denied: false };
}

/**
 * Post-tool hook: audit/log tool execution.
 */
function _runPostHook(toolName, toolInput, toolOutput, isError, cwd) {
  try {
    const hooksPath = path.join(cwd, ".wolverine", "hooks.json");
    if (!fs.existsSync(hooksPath)) return;
    const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
    if (!hooks.post_tool_use || hooks.post_tool_use.length === 0) return;

    for (const cmd of hooks.post_tool_use) {
      try {
        const { execSync } = require("child_process");
        execSync(cmd, {
          input: JSON.stringify({ event: "PostToolUse", tool_name: toolName, tool_input: toolInput, tool_output: (toolOutput || "").slice(0, 500), is_error: isError }),
          env: { ...process.env, HOOK_TOOL_NAME: toolName || "", HOOK_TOOL_IS_ERROR: isError ? "1" : "0" },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        });
      } catch {}
    }
  } catch {}
}

/**
 * Parse Gemma-style text tool calls into OpenAI tool_calls format.
 * Gemma outputs: "call:tool_name{json_args}" or "<|tool_call>call:tool_name{args}<tool_call|>"
 * We convert to: [{ id, type: "function", function: { name, arguments } }]
 */
function _parseTextToolCalls(content) {
  if (!content) return [];
  const calls = [];
  // Match patterns: call:name{args} or call:name{"key":"val"}
  const patterns = [
    /call:(\w+)\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g,  // call:name{args with nested braces}
    /call:(\w+)\(([^)]*)\)/g,                        // call:name(args)
  ];
  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      let argsStr = match[2];
      // Try to parse as JSON, otherwise build from key:value pairs
      let args;
      try {
        // Clean up Gemma's quoting: path:"value" → "path":"value"
        const cleaned = argsStr.replace(/(\w+)\s*:\s*/g, '"$1":').replace(/<\|"\|>/g, '"');
        args = JSON.parse("{" + cleaned + "}");
      } catch {
        try { args = JSON.parse(argsStr); } catch {
          // Last resort: treat as single string argument for the most common param
          const paramGuess = argsStr.replace(/['"<|>]/g, "").trim();
          if (name === "read_file" || name === "glob_files") args = { path: paramGuess };
          else if (name === "grep_code") args = { pattern: paramGuess };
          else if (name === "bash_exec") args = { command: paramGuess };
          else if (name === "write_file") args = { path: paramGuess, content: "" };
          else args = { input: paramGuess };
        }
      }
      calls.push({
        id: "call_" + Date.now().toString(36) + "_" + calls.length,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
    }
    if (calls.length > 0) break; // use first matching pattern
  }
  return calls;
}

module.exports = { AgentEngine, TOOL_DEFINITIONS, BLOCKED_COMMANDS };
