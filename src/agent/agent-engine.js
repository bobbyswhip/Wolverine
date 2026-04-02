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

    const systemPrompt = `You are Wolverine, an autonomous Node.js server repair agent. A server crashed and you must fix it.

You have a full tool harness for investigating and fixing issues:

FILE TOOLS:
- read_file: Read any file (with optional offset/limit for large files)
- write_file: Write a complete file
- edit_file: Surgical find-and-replace (preferred for small fixes)
- glob_files: Find files by pattern (e.g. "**/*.js", "src/**/*.config.*")
- grep_code: Search code with regex across the project

SHELL TOOLS:
- bash_exec: Run any shell command (sandboxed to project dir)
- git_log: View recent commits
- git_diff: View uncommitted changes

RESEARCH:
- web_fetch: Fetch a URL (docs, npm packages, Stack Overflow)

Use these tools systematically:
1. Understand the error and its root cause
2. Explore related files (imports, configs, dependencies, schemas)
3. Check git history if relevant
4. Fix the issue across ALL affected files
5. You can edit ANY file type: .js, .json, .sql, .yaml, .env, .dockerfile, .sh, etc.
6. Prefer edit_file for small targeted fixes, write_file for major changes
7. Use grep_code to find all usages before renaming something
8. Use bash_exec to run tests, install packages, or check dependencies

CRITICAL — Not every crash is a code bug. Choose the right fix:

| Error Pattern | Root Cause | Correct Fix |
|---|---|---|
| Cannot find module 'X' | Missing npm package | bash_exec: npm install X |
| Cannot find module './X' | Wrong import path | edit_file: fix the require/import path |
| ENOENT: no such file | Missing config/data file | write_file: create the missing file |
| EACCES/EPERM | Permission denied | bash_exec: chmod or fix ownership |
| EADDRINUSE | Port conflict | bash_exec: kill process on port, or edit config |
| SyntaxError | Bad code | edit_file: fix the syntax |
| TypeError/ReferenceError | Logic bug | edit_file: fix the code |
| MODULE_NOT_FOUND + node_modules | Corrupted install | bash_exec: rm -rf node_modules && npm install |

ALWAYS check package.json before editing imports. If a module isn't a local file, use bash_exec to install it.

Rules:
- Read files before modifying them
- Make minimal, targeted changes
- Use bash_exec for operational fixes (npm install, chmod, config creation)
- When done, call the "done" tool with a summary

Project root: ${this.cwd}
Primary crash file: ${primaryFile}`;

    this.messages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `The server crashed with this error:\n\n**Error:** ${errorMessage}\n\n**Stack Trace:**\n\`\`\`\n${stackTrace}\n\`\`\`\n\n**Primary file (${primaryFile}):**\n\`\`\`\n${sourceCode}\n\`\`\`${brainContext ? `\n\n**Context from Wolverine Brain:**\n${brainContext}` : ""}\n\nAnalyze the error, explore any related files you need, and fix the issue. Use your tools.`,
      },
    ];

    this.filesRead.add(primaryFile);

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
        const result = await this._executeTool(toolCall);
        this.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result.content,
        });

        if (result.done) {
          return {
            success: true,
            summary: result.summary,
            filesModified: result.filesModified || this.filesModified,
            turnCount: this.turnCount,
            totalTokens: this.totalTokens,
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

    const timeout = Math.min(args.timeout || 10000, 30000);
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

module.exports = { AgentEngine, TOOL_DEFINITIONS, BLOCKED_COMMANDS };
