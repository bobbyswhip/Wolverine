/**
 * Wolverine Claw Standalone Agent
 *
 * When OpenClaw isn't installed (or Node < 22), this provides a built-in
 * agentic terminal REPL using wolverine's full agent engine — all 32 tools
 * (file ops, shell, git, diagnostics, database, network, deps, research,
 * advanced monitoring) powered by the same AI pipeline as server healing.
 *
 * This makes wolverine-claw work immediately without any external deps,
 * and openclaw becomes an optional enhancement for multi-channel support.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const chalk = require("chalk");

// ── REPL ────────────────────────────────────────────────────────

/**
 * Start the standalone agent REPL with all 32 wolverine tools.
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

  // Load the real AgentEngine + TOOL_DEFINITIONS from wolverine's agent
  let AgentEngine, TOOL_DEFINITIONS;
  try {
    const agentMod = require("../agent/agent-engine");
    AgentEngine = agentMod.AgentEngine;
    TOOL_DEFINITIONS = agentMod.TOOL_DEFINITIONS;
  } catch (e) {
    console.error(chalk.red(`  [CLAW] Failed to load agent engine: ${e.message}`));
    process.exit(1);
  }

  // Use the real Sandbox — same security as heal pipeline
  const { Sandbox } = require("../security/sandbox");
  const sandbox = new Sandbox(cwd);

  // Instantiate the agent engine for tool execution
  const engine = new AgentEngine({
    cwd,
    sandbox,
    maxTurns,
    maxTokens: 100000,
  });

  // Load browser tools (framework-level, optional — needs puppeteer)
  let browserTools = [];
  let browserExecutors = {};
  try {
    const browser = require("./browser");
    browserTools = browser.getToolDefinitions();
    browserExecutors = browser.getToolExecutors();
    TOOL_DEFINITIONS = [...TOOL_DEFINITIONS, ...browserTools];
  } catch (e) {
    // puppeteer not installed — skip silently
    if (!e.message.includes("puppeteer")) {
      console.warn(chalk.yellow(`  [CLAW] Browser tools: ${e.message}`));
    }
  }

  // Load custom skill tools from wolverine-claw/skills/
  let customTools = [];
  let customExecutors = {};
  const skillsDir = path.join(cwd, "wolverine-claw", "skills");
  if (fs.existsSync(skillsDir)) {
    try {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillModule = path.join(skillsDir, entry.name, `${entry.name}.js`);
        if (!fs.existsSync(skillModule)) continue;
        try {
          const skill = require(skillModule);
          if (skill.getToolDefinitions && skill.getToolExecutors) {
            const defs = skill.getToolDefinitions(cwd);
            const execs = skill.getToolExecutors(cwd);
            customTools.push(...defs);
            Object.assign(customExecutors, execs);
          }
        } catch (e) {
          console.warn(chalk.yellow(`  [CLAW] Skill ${entry.name}: ${e.message}`));
        }
      }
      if (customTools.length > 0) {
        TOOL_DEFINITIONS = [...TOOL_DEFINITIONS, ...customTools];
      }
    } catch {}
  }

  // Count tools by category
  const toolNames = TOOL_DEFINITIONS.map(t => t.function.name);
  const categories = {
    file: ["read_file", "write_file", "edit_file", "glob_files", "grep_code"],
    shell: ["bash_exec", "git_log", "git_diff"],
    diagnostics: ["list_dir", "move_file", "check_port", "check_env", "inspect_env", "check_memory", "list_processes", "check_logs", "check_network"],
    database: ["inspect_db", "run_db_fix"],
    deps: ["audit_deps", "check_migration"],
    research: ["web_fetch"],
    advanced: ["verify_node_modules", "inspect_certificate", "inspect_cache", "disk_cleanup", "check_file_descriptors", "check_event_loop", "check_websocket"],
    env: ["add_env_var"],
    server: ["restart_service"],
    control: ["done"],
  };

  if (browserTools.length > 0) {
    categories.browser = browserTools.map(t => t.function.name);
  }
  if (customTools.length > 0) {
    categories.skills = customTools.map(t => t.function.name);
  }

  const systemPrompt = `You are Wolverine Claw, an agentic AI coding assistant running inside the Wolverine self-healing framework.

You have access to ${TOOL_DEFINITIONS.length} tools across ${Object.keys(categories).length} categories:
- FILE: read_file, write_file, edit_file, glob_files, grep_code
- SHELL & GIT: bash_exec, git_log, git_diff
- DIAGNOSTICS: list_dir, move_file, check_port, check_env, inspect_env, check_memory, list_processes, check_logs, check_network
- DATABASE: inspect_db, run_db_fix (always inspect_db FIRST)
- DEPENDENCIES: audit_deps, check_migration
- RESEARCH: web_fetch
- ADVANCED: verify_node_modules, inspect_certificate, inspect_cache, disk_cleanup, check_file_descriptors, check_event_loop, check_websocket
- ENVIRONMENT: add_env_var
- SERVER: restart_service
- CONTROL: done${browserTools.length > 0 ? "\n- BROWSER: browser_navigate, browser_read_page, browser_screenshot, browser_click, browser_type, browser_scroll, browser_eval, browser_close" : ""}${customTools.length > 0 ? "\n- SKILLS: " + customTools.map(t => t.function.name).join(", ") : ""}

Project root: ${cwd}
Workspace for new files: ${workspacePath}

Guidelines:
- Read files before editing. Understand existing code first.
- Use edit_file (old_text/new_text) for surgical changes, write_file for new files.
- Use grep_code and glob_files to explore the codebase.
- Use bash_exec for git, npm, system commands.
- Use inspect_db before run_db_fix. Always check before modifying.
- Use audit_deps when dependency issues are suspected.
- Use check_port for EADDRINUSE, check_network for connectivity, inspect_certificate for TLS.
- When done with a task, call the done tool with a summary.
- Be concise. Fix what's asked.${browserTools.length > 0 ? `
- BROWSER: Lightweight headless browser (1 tab max). All page content is security-scanned for injection and secrets. Use browser_navigate to open pages, browser_read_page to get text, browser_screenshot for visuals, browser_click/browser_type to interact. Call browser_close when done. URLs must be http/https — internal IPs and file:// blocked.` : ""}${customTools.length > 0 ? `
- SKILLS: Custom skills loaded from wolverine-claw/skills/. All incoming data is security-scanned. Blocked content should NOT be processed.` : ""}`;

  console.log(chalk.blue.bold("\n  🐾 Wolverine Claw — Interactive Agent\n"));
  console.log(chalk.gray(`  Model:     ${model}`));
  console.log(chalk.gray(`  Workspace: ${workspacePath}`));
  console.log(chalk.gray(`  Tools:     ${TOOL_DEFINITIONS.length} across ${Object.keys(categories).length} categories`));
  console.log(chalk.gray(`             file(5) shell(3) diagnostics(9) database(2) deps(2)`));
  console.log(chalk.gray(`             research(1) advanced(7) env(1) server(1) control(1)`));
  console.log(chalk.gray(`  Max turns: ${maxTurns}`));
  console.log(chalk.gray(`  Type 'exit' or Ctrl+C to quit.\n`));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.blue("  🐾 > "),
  });

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

    if (input === "/clear") {
      messages = [];
      console.log(chalk.gray("  Conversation cleared.\n"));
      rl.prompt();
      return;
    }
    if (input === "/status") {
      console.log(chalk.gray(`  Messages: ${messages.length}, Model: ${model}, Tools: ${TOOL_DEFINITIONS.length}`));
      rl.prompt();
      return;
    }
    if (input === "/tools") {
      for (const [cat, names] of Object.entries(categories)) {
        console.log(chalk.gray(`  ${cat}: ${names.join(", ")}`));
      }
      console.log("");
      rl.prompt();
      return;
    }

    messages.push({ role: "user", content: input });

    let turn = 0;
    let done = false;

    while (turn < maxTurns && !done) {
      turn++;
      try {
        const response = await aiCallWithHistory({
          model,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          tools: TOOL_DEFINITIONS,
          maxTokens: 4096,
          category: "tool",
        });

        const msg = response.choices?.[0]?.message;
        if (!msg) {
          console.log(chalk.yellow("  (empty response)\n"));
          done = true;
          continue;
        }

        const textContent = msg.content || "";
        const toolCalls = msg.tool_calls || [];

        if (textContent) {
          console.log(chalk.white(`\n  ${textContent.replace(/\n/g, "\n  ")}\n`));
        }

        if (toolCalls.length > 0) {
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

            if (toolName === "done") {
              const summary = toolInput.summary || toolInput.message || "Task completed.";
              console.log(chalk.green(`  ✅ ${summary}\n`));
              messages.push({ role: "tool", tool_call_id: tc.id, content: summary });
              done = true;
              break;
            }

            console.log(chalk.gray(`  [${toolName}] ${JSON.stringify(toolInput).slice(0, 120)}`));

            // Execute: browser/skill tools to their executors, rest to AgentEngine
            let toolResult;
            try {
              if (browserExecutors[toolName]) {
                toolResult = await browserExecutors[toolName](toolInput);
              } else if (customExecutors[toolName]) {
                toolResult = await customExecutors[toolName](toolInput);
              } else {
                const result = await engine._executeTool({
                  function: { name: toolName, arguments: JSON.stringify(toolInput) },
                });
                toolResult = typeof result === "string" ? result : (result?.content || JSON.stringify(result));
              }
            } catch (e) {
              toolResult = `[ERROR] ${e.message}`;
            }

            // Cap display output
            const displayResult = toolResult.length > 300
              ? toolResult.slice(0, 300) + "..."
              : toolResult;
            console.log(chalk.gray(`  → ${displayResult.replace(/\n/g, "\n    ")}`));

            messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
          }
        } else if (textContent) {
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

    setInterval(() => {
      try {
        process.send({ type: "claw_heartbeat", uptime: process.uptime(), memory: process.memoryUsage(), timestamp: Date.now() });
      } catch {}
    }, 30000);
  }
}

/**
 * Get tool definitions for external use (e.g., tests).
 */
function getToolDefinitions() {
  try {
    const { TOOL_DEFINITIONS } = require("../agent/agent-engine");
    return TOOL_DEFINITIONS;
  } catch {
    return [];
  }
}

module.exports = { startRepl, getToolDefinitions };
