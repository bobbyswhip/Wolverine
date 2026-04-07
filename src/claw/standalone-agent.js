/**
 * Wolverine Claw Standalone Agent
 *
 * When OpenClaw isn't installed (or Node < 22), this provides a built-in
 * agentic terminal REPL using wolverine's own AI client. Users get an
 * interactive coding agent that can read/write/edit files, run commands,
 * search code, and self-heal — all powered by the same AI pipeline as
 * wolverine's server healing.
 *
 * This makes wolverine-claw work immediately without any external deps,
 * and openclaw becomes an optional enhancement for multi-channel support.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const chalk = require("chalk");
const { execSync } = require("child_process");

// ── Tool Definitions ────────────────────────────────────────────

function buildTools(cwd, workspacePath, config) {
  const sandbox = config.security?.sandbox !== false;

  function resolveSafe(filePath) {
    const resolved = path.resolve(cwd, filePath);
    if (sandbox) {
      // In sandbox mode, allow cwd and workspace
      if (!resolved.startsWith(cwd)) return null;
      // Block protected paths
      const rel = path.relative(cwd, resolved);
      if (rel.startsWith("node_modules") || rel.startsWith(".env") || rel.startsWith("src/")) {
        return null;
      }
    }
    return resolved;
  }

  return [
    {
      name: "read_file",
      description: "Read a file's contents. Use offset and limit for large files.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to project root" },
          offset: { type: "number", description: "Start line (0-indexed)" },
          limit: { type: "number", description: "Max lines to read" },
        },
        required: ["path"],
      },
      execute: ({ path: p, offset, limit }) => {
        const resolved = resolveSafe(p);
        if (!resolved) return `[ERROR] Access denied: ${p}`;
        try {
          let content = fs.readFileSync(resolved, "utf-8");
          if (offset || limit) {
            const lines = content.split("\n");
            const start = offset || 0;
            const end = limit ? start + limit : lines.length;
            content = lines.slice(start, end).join("\n");
          }
          if (content.length > 8000) content = content.slice(0, 8000) + "\n... (truncated)";
          return content;
        } catch (e) { return `[ERROR] ${e.message}`; }
      },
    },
    {
      name: "write_file",
      description: "Write content to a file. Creates directories if needed.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to project root" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
      execute: ({ path: p, content }) => {
        const resolved = resolveSafe(p);
        if (!resolved) return `[ERROR] Access denied: ${p}`;
        try {
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.writeFileSync(resolved, content);
          return `Written: ${p} (${content.length} bytes)`;
        } catch (e) { return `[ERROR] ${e.message}`; }
      },
    },
    {
      name: "edit_file",
      description: "Find and replace text in a file. Surgical single-match edit.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to project root" },
          find: { type: "string", description: "Exact text to find" },
          replace: { type: "string", description: "Replacement text" },
        },
        required: ["path", "find", "replace"],
      },
      execute: ({ path: p, find, replace }) => {
        const resolved = resolveSafe(p);
        if (!resolved) return `[ERROR] Access denied: ${p}`;
        try {
          const content = fs.readFileSync(resolved, "utf-8");
          if (!content.includes(find)) return `[ERROR] Text not found in ${p}`;
          const count = content.split(find).length - 1;
          if (count > 1) return `[ERROR] ${count} matches found — provide more context for a unique match`;
          fs.writeFileSync(resolved, content.replace(find, replace));
          return `Edited: ${p}`;
        } catch (e) { return `[ERROR] ${e.message}`; }
      },
    },
    {
      name: "list_dir",
      description: "List files and directories in a path.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to project root" },
        },
        required: ["path"],
      },
      execute: ({ path: p }) => {
        const resolved = resolveSafe(p || ".");
        if (!resolved) return `[ERROR] Access denied: ${p}`;
        try {
          const entries = fs.readdirSync(resolved, { withFileTypes: true });
          return entries.map(e => {
            const prefix = e.isDirectory() ? "[DIR]  " : "       ";
            let size = "";
            if (!e.isDirectory()) {
              try { size = ` (${fs.statSync(path.join(resolved, e.name)).size}b)`; } catch {}
            }
            return `${prefix}${e.name}${size}`;
          }).join("\n");
        } catch (e) { return `[ERROR] ${e.message}`; }
      },
    },
    {
      name: "glob_files",
      description: "Find files matching a glob pattern (e.g., **/*.js).",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
        },
        required: ["pattern"],
      },
      execute: ({ pattern }) => {
        try {
          // Use Node's fs.globSync if available (Node 22+), else fallback to find
          if (fs.globSync) {
            const matches = fs.globSync(pattern, { cwd });
            return matches.slice(0, 50).join("\n") || "No matches";
          }
          // Fallback: simple recursive walk with pattern matching
          const simplePattern = pattern.replace(/\*\*/g, "").replace(/\*/g, "");
          const ext = path.extname(simplePattern) || "";
          const results = [];
          function walk(dir, depth) {
            if (depth > 5 || results.length > 50) return;
            try {
              for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name.startsWith(".") || e.name === "node_modules") continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full, depth + 1);
                else if (!ext || e.name.endsWith(ext)) results.push(path.relative(cwd, full));
              }
            } catch {}
          }
          walk(cwd, 0);
          return results.join("\n") || "No matches";
        } catch (e) { return `[ERROR] ${e.message}`; }
      },
    },
    {
      name: "grep_code",
      description: "Search file contents for a regex pattern.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "File or directory to search in (default: .)" },
        },
        required: ["pattern"],
      },
      execute: ({ pattern, path: searchPath }) => {
        const resolved = resolveSafe(searchPath || ".");
        if (!resolved) return `[ERROR] Access denied`;
        try {
          const result = execSync(
            `grep -rn --include="*.js" --include="*.json" --include="*.ts" --include="*.md" "${pattern.replace(/"/g, '\\"')}" "${resolved}" 2>/dev/null | head -30`,
            { encoding: "utf-8", timeout: 10000, cwd }
          );
          return result.trim() || "No matches";
        } catch {
          // grep returns exit 1 on no match
          return "No matches";
        }
      },
    },
    {
      name: "bash_exec",
      description: "Execute a shell command. 30s timeout. Dangerous commands blocked.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
        },
        required: ["command"],
      },
      execute: ({ command }) => {
        // Block dangerous commands
        const blocked = ["rm -rf /", "rm -rf /*", "mkfs", "dd if=", "shutdown", "reboot",
          "format c:", "git push --force", "npm publish", "> /dev/sda"];
        for (const b of blocked) {
          if (command.includes(b)) return `[ERROR] Blocked dangerous command: ${b}`;
        }
        try {
          const result = execSync(command, {
            encoding: "utf-8",
            timeout: 30000,
            cwd,
            maxBuffer: 1024 * 1024,
          });
          const trimmed = result.trim();
          if (trimmed.length > 4000) return trimmed.slice(0, 4000) + "\n... (truncated)";
          return trimmed || "(no output)";
        } catch (e) {
          return `[ERROR] ${e.message?.split("\n")[0] || "Command failed"}`;
        }
      },
    },
    {
      name: "done",
      description: "Signal that you have completed the user's request. Include a summary.",
      input_schema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Summary of what was done" },
        },
        required: ["summary"],
      },
      execute: ({ summary }) => summary,
    },
  ];
}

// ── Agent Loop ──────────────────────────────────────────────────

/**
 * Run one agent turn: send messages to AI, execute tool calls, return.
 */
async function agentTurn(aiCall, model, systemPrompt, messages, tools, maxTokens) {
  // Convert tools to AI format
  const toolDefs = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  const result = await aiCall({
    model,
    messages,
    tools: toolDefs,
    maxTokens,
    category: "tool",
  });

  return result;
}

// ── REPL ────────────────────────────────────────────────────────

/**
 * Start the standalone agent REPL.
 */
async function startRepl(config, options = {}) {
  const cwd = options.cwd || process.cwd();
  const workspacePath = path.resolve(cwd, config.workspace?.path || "wolverine-claw/workspace");
  const model = config.agent?.model || config.models?.coding || "claude-sonnet-4-6";
  const maxTurns = config.agent?.maxTurns || 25;

  // Ensure workspace exists
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  // Load AI client
  let aiCallWithHistory;
  try {
    const aiClient = require("../core/ai-client");
    aiCallWithHistory = aiClient.aiCallWithHistory;
  } catch (e) {
    console.error(chalk.red(`  [CLAW] Failed to load AI client: ${e.message}`));
    process.exit(1);
  }

  const tools = buildTools(cwd, workspacePath, config);

  const systemPrompt = `You are Wolverine Claw, an agentic AI coding assistant running inside the Wolverine self-healing framework.

You have access to tools for reading, writing, editing files, searching code, and running shell commands. You operate in the project at: ${cwd}

Your workspace for creating new files is: ${workspacePath}

Guidelines:
- Read files before editing them. Understand existing code before making changes.
- Use edit_file for surgical changes, write_file for new files.
- Use grep_code and glob_files to explore the codebase before making assumptions.
- Use bash_exec for git, npm, and system commands.
- When done with a task, use the done tool with a summary.
- Be concise. Fix what's asked, don't add unnecessary changes.
- Protected paths (read-only): src/, node_modules/, .env files.`;

  console.log(chalk.blue.bold("\n  🐾 Wolverine Claw — Interactive Agent\n"));
  console.log(chalk.gray(`  Model:     ${model}`));
  console.log(chalk.gray(`  Workspace: ${workspacePath}`));
  console.log(chalk.gray(`  Tools:     ${tools.length} (read, write, edit, list, glob, grep, bash, done)`));
  console.log(chalk.gray(`  Max turns: ${maxTurns}`));
  console.log(chalk.gray(`  Type 'exit' or Ctrl+C to quit.\n`));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.blue("  🐾 > "),
  });

  // Conversation history
  let messages = [];

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === "exit" || input === "quit") {
      console.log(chalk.gray("\n  Goodbye.\n"));
      rl.close();
      process.exit(0);
    }

    // Special commands
    if (input === "/clear") {
      messages = [];
      console.log(chalk.gray("  Conversation cleared.\n"));
      rl.prompt();
      return;
    }
    if (input === "/status") {
      console.log(chalk.gray(`  Messages: ${messages.length}, Model: ${model}`));
      rl.prompt();
      return;
    }

    // Add user message
    messages.push({ role: "user", content: input });

    // Agent loop
    // aiCallWithHistory returns OpenAI-shaped responses:
    //   {choices: [{message: {role, content, tool_calls}}], usage}
    // Tool calls come as: {id, type:"function", function:{name, arguments:JSON_STRING}}
    // Tool defs must be: {type:"function", function:{name, description, parameters}}
    let turn = 0;
    let done = false;

    // Build OpenAI-format tool definitions once
    const toolDefs = tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    while (turn < maxTurns && !done) {
      turn++;
      try {
        const response = await aiCallWithHistory({
          model,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          tools: toolDefs,
          maxTokens: 4096,
          category: "tool",
        });

        // Extract from OpenAI-shaped response
        const msg = response.choices?.[0]?.message;
        if (!msg) {
          console.log(chalk.yellow("  (empty response)\n"));
          done = true;
          continue;
        }

        const textContent = msg.content || "";
        const toolCalls = msg.tool_calls || [];

        // Handle text content
        if (textContent) {
          console.log(chalk.white(`\n  ${textContent.replace(/\n/g, "\n  ")}\n`));
        }

        // Handle tool calls
        if (toolCalls.length > 0) {
          // Store assistant message with tool calls
          messages.push({
            role: "assistant",
            content: textContent || null,
            tool_calls: toolCalls,
          });

          for (const tc of toolCalls) {
            const toolName = tc.function?.name || tc.name;
            let toolInput = {};
            try {
              toolInput = typeof tc.function?.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : (tc.function?.arguments || tc.input || {});
            } catch { toolInput = {}; }

            const tool = tools.find(t => t.name === toolName);

            if (!tool) {
              console.log(chalk.yellow(`  [tool] Unknown: ${toolName}`));
              messages.push({ role: "tool", tool_call_id: tc.id, content: `[ERROR] Unknown tool: ${toolName}` });
              continue;
            }

            if (toolName === "done") {
              const summary = tool.execute(toolInput);
              console.log(chalk.green(`  ✅ ${summary}\n`));
              messages.push({ role: "tool", tool_call_id: tc.id, content: summary });
              done = true;
              break;
            }

            console.log(chalk.gray(`  [${toolName}] ${JSON.stringify(toolInput).slice(0, 100)}`));
            const toolResult = tool.execute(toolInput);
            const displayResult = toolResult.length > 200
              ? toolResult.slice(0, 200) + "..."
              : toolResult;
            console.log(chalk.gray(`  → ${displayResult.replace(/\n/g, "\n    ")}`));

            messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
          }
        } else if (textContent) {
          // Text-only response, no tool calls — done for this turn
          messages.push({ role: "assistant", content: textContent });
          done = true;
        } else {
          done = true;
        }
      } catch (err) {
        console.log(chalk.red(`  [error] ${err.message}`));
        messages.push({ role: "assistant", content: `Error: ${err.message}` });
        done = true;
      }
    }

    if (turn >= maxTurns) {
      console.log(chalk.yellow(`  ⚠️  Max turns (${maxTurns}) reached.\n`));
    }

    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });

  // Report health to wolverine parent
  if (typeof process.send === "function") {
    try {
      process.send({ type: "claw_health", status: "running", detail: "standalone-agent", timestamp: Date.now() });
    } catch {}

    // Heartbeat
    setInterval(() => {
      try {
        process.send({ type: "claw_heartbeat", uptime: process.uptime(), memory: process.memoryUsage(), timestamp: Date.now() });
      } catch {}
    }, 30000);
  }
}

module.exports = { startRepl, buildTools };
