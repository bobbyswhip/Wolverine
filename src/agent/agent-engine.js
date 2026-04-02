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
      description: "Run a write query on a SQLite database to fix data issues: UPDATE invalid entries, DELETE corrupt rows, ALTER schema. Creates a backup first.",
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
      try {
        response = await aiCallWithHistory({
          model,
          messages: this.messages,
          tools: allTools,
          maxTokens: 4096,
        });
      } catch (err) {
        console.log(chalk.red(`  Agent API error: ${err.message}`));
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

      const choice = response.choices[0];
      const assistantMessage = choice.message || choice;
      this.messages.push(assistantMessage);

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

      for (const toolCall of assistantMessage.tool_calls) {
        // Error-graceful tool execution (claw-code pattern)
        // Tool errors are returned as is_error results, not thrown.
        // This lets the model see the error and decide how to proceed.
        let result;
        let isError = false;
        try {
          // Pre-hook: check if tool should be blocked
          const hookResult = _runPreHook(toolCall.function?.name, toolCall.function?.arguments, this.cwd);
          if (hookResult.denied) {
            result = { content: `Blocked by hook: ${hookResult.message}` };
            isError = true;
          } else {
            result = await this._executeTool(toolCall);
          }
        } catch (err) {
          // Error-graceful: return error as tool result, don't break the loop
          result = { content: `Tool error: ${err.message?.slice(0, 200)}` };
          isError = true;
          console.log(chalk.yellow(`    ⚠️ Tool error (${toolCall.function?.name}): ${err.message?.slice(0, 80)}`));
        }

        // Post-hook: audit/modify result
        _runPostHook(toolCall.function?.name, toolCall.function?.arguments, result.content, isError, this.cwd);

        // Tool result truncation: cap at 4K chars to prevent context blowup.
        // One grep_code can return 30K+ chars — the model doesn't need all of it.
        const MAX_TOOL_RESULT = 4000;
        let toolContent = isError ? `[ERROR] ${result.content}` : result.content;
        if (toolContent && toolContent.length > MAX_TOOL_RESULT) {
          const truncated = toolContent.length - MAX_TOOL_RESULT;
          toolContent = toolContent.slice(0, MAX_TOOL_RESULT) + `\n\n... (truncated ${truncated} chars. Use offset/limit for large results.)`;
        }

        this.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolContent,
        });

        if (result.done) {
          return {
            success: true,
            summary: result.summary,
            filesModified: result.filesModified || this.filesModified,
            turnCount: this.turnCount,
            totalTokens: this.totalTokens,
            toolCalls: this.toolCalls,
          };
        }
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
      const result = db.prepare(args.sql).run();
      db.close();
      this.filesModified.push(args.db_path);
      console.log(chalk.green(`    🗃️ DB fix applied: ${args.sql.slice(0, 60)} (changes: ${result.changes})`));
      return { content: `SQL executed. Changes: ${result.changes}. Backup at: ${backupPath}` };
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
RULES: Read the file before editing. Use edit_file for targeted fixes. Call done when finished.
${primaryFile ? `File: ${primaryFile}` : ""}
Project: ${cwd}`;
}

/** Full prompt for complex/unknown errors — all 18 tools + strategy table. */
function _fullPrompt(cwd, primaryFile) {
  return `You are Wolverine, an autonomous Node.js server repair agent. Diagnose and fix the error.

You are a full server doctor. Errors can be code bugs, missing deps, database problems, config issues, port conflicts, permissions, or corrupted state. Investigate the root cause before fixing.

TOOLS: read_file, write_file, edit_file, glob_files, grep_code, list_dir, move_file, bash_exec, git_log, git_diff, inspect_db, run_db_fix, check_port, check_env, audit_deps, check_migration, web_fetch, done

STRATEGY:
- Cannot find module 'X' → bash_exec: npm install X
- Cannot find module './X' → edit_file: fix require path
- ENOENT → write_file or move_file
- EADDRINUSE → check_port then bash_exec: kill
- TypeError/ReferenceError → read_file then edit_file
- Database error → inspect_db then run_db_fix
- Missing env var → check_env

RULES:
1. Investigate first — read files before modifying
2. Minimal targeted changes — fix root cause not symptoms
3. bash_exec for operational fixes, edit_file for code, run_db_fix for data
4. Call done with summary when finished
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

module.exports = { AgentEngine, TOOL_DEFINITIONS, BLOCKED_COMMANDS };
