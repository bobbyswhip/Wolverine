const chalk = require("chalk");
const { AgentEngine } = require("./agent-engine");
const { getModel } = require("../core/models");

/**
 * Sub-Agent System — spawn specialized agents for divide-and-conquer.
 *
 * claw-code pattern:
 * - Parent agent identifies sub-tasks
 * - Each sub-agent gets: restricted tools, specific model, focused prompt
 * - Sub-agents run in parallel (Promise.all)
 * - Results aggregated back to parent
 *
 * Built-in agent types:
 * - explore:  Read-only. Investigates codebase, finds relevant files.
 * - plan:     Read-only. Analyzes problem, proposes a fix strategy.
 * - fix:      Read+write. Applies a specific, targeted fix.
 * - verify:   Read-only. Checks if a fix actually works.
 * - research: Read-only. Searches brain + web for solutions.
 * - security: Read-only. Audits code for vulnerabilities.
 * - database: Read+write. Handles database-related fixes (uses SQL skill).
 */

// Tool restrictions per agent type (claw-code: allowed_tools_for_subagent)
const AGENT_TOOL_SETS = {
  explore: ["read_file", "glob_files", "grep_code", "git_log", "git_diff", "list_dir", "check_env", "check_port", "inspect_db", "done"],
  plan: ["read_file", "glob_files", "grep_code", "list_dir", "inspect_db", "check_env", "search_brain", "done"],
  fix: ["read_file", "write_file", "edit_file", "glob_files", "grep_code", "bash_exec", "move_file", "run_db_fix", "done"],
  verify: ["read_file", "glob_files", "grep_code", "bash_exec", "inspect_db", "check_port", "done"],
  research: ["read_file", "grep_code", "web_fetch", "search_brain", "done"],
  security: ["read_file", "glob_files", "grep_code", "inspect_db", "done"],
  database: ["read_file", "write_file", "edit_file", "glob_files", "grep_code", "bash_exec", "inspect_db", "run_db_fix", "done"],
};

// Default model + budget per agent type
const AGENT_CONFIGS = {
  explore:  { model: "reasoning", maxTurns: 5,  maxTokens: 10000 },
  plan:     { model: "reasoning", maxTurns: 3,  maxTokens: 8000 },
  fix:      { model: "coding",   maxTurns: 5,  maxTokens: 15000 },
  verify:   { model: "reasoning", maxTurns: 3,  maxTokens: 5000 },
  research: { model: "research",  maxTurns: 3,  maxTokens: 10000 },
  security: { model: "audit",     maxTurns: 3,  maxTokens: 8000 },
  database: { model: "coding",   maxTurns: 5,  maxTokens: 15000 },
};

// System prompts per agent type
const AGENT_PROMPTS = {
  explore: "You are an Explorer agent. Your job is to investigate the codebase and find files relevant to the problem. Read files, search for patterns, check git history. Report what you found — do NOT make changes.",
  plan: "You are a Planner agent. Your job is to analyze the problem and propose a fix strategy. Read the relevant files, understand the root cause, and describe step-by-step what needs to change. Consider: is this a code bug (edit files) or an operational issue (npm install, create missing config, fix permissions)? Check package.json for dependencies. Do NOT make changes.",
  fix: "You are a Fixer agent. You receive a specific fix plan. Execute it precisely. Use edit_file for code fixes, bash_exec for operational fixes (npm install, chmod, mkdir, config creation). Not every error is a code bug — missing modules need npm install, missing files need creation, permission errors need chmod. Check package.json before editing imports.",
  verify: "You are a Verifier agent. Check if a fix actually works. Read the modified files, look for issues, run tests if available. Report whether the fix is correct.",
  research: "You are a Research agent. Search the brain for past fixes to similar errors, and search the web for solutions. Report your findings.",
  security: "You are a Security agent. Audit the code for vulnerabilities: SQL injection, XSS, path traversal, hardcoded secrets, missing input validation. Report all findings.",
  database: "You are a Database agent. Handle database-related issues: schema problems, query errors, connection failures, migration issues. You have access to the SQL skill.",
};

/**
 * Spawn a single sub-agent.
 *
 * @param {string} type — agent type (explore, plan, fix, verify, research, security, database)
 * @param {string} task — what this agent should do
 * @param {object} options — { sandbox, logger, cwd, mcp, brainContext }
 * @returns {{ success, summary, filesModified, turnCount, totalTokens, type }}
 */
async function spawnAgent(type, task, options = {}) {
  const config = AGENT_CONFIGS[type] || AGENT_CONFIGS.explore;
  const allowedTools = AGENT_TOOL_SETS[type] || AGENT_TOOL_SETS.explore;
  const systemPrompt = AGENT_PROMPTS[type] || AGENT_PROMPTS.explore;

  console.log(chalk.magenta(`  🤖 [${type}] Spawning sub-agent (${getModel(config.model)}, ${config.maxTurns} turns)`));

  if (options.logger) {
    options.logger.info("agent.spawn", `Sub-agent [${type}]: ${task.slice(0, 80)}`, {
      type, model: getModel(config.model), maxTurns: config.maxTurns,
    });
  }

  const agent = new AgentEngine({
    sandbox: options.sandbox,
    logger: options.logger,
    cwd: options.cwd || process.cwd(),
    mcp: options.mcp,
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
  });

  // Override the system prompt for this agent type
  const result = await agent.run({
    errorMessage: task,
    stackTrace: "",
    primaryFile: "N/A",
    sourceCode: `// Sub-agent type: ${type}\n// ${systemPrompt}`,
    brainContext: options.brainContext || "",
  });

  console.log(chalk.magenta(`  🤖 [${type}] ${result.success ? "✅" : "❌"} ${(result.summary || "").slice(0, 80)}`));

  return {
    ...result,
    type,
    model: getModel(config.model),
  };
}

/**
 * Spawn multiple sub-agents in parallel.
 *
 * @param {Array<{ type, task }>} agents — agents to spawn
 * @param {object} options — shared options for all agents
 * @returns {Array} — results from all agents
 */
async function spawnParallel(agents, options = {}) {
  console.log(chalk.magenta(`\n  🤖 Spawning ${agents.length} sub-agents in parallel...`));

  if (options.logger) {
    options.logger.info("agent.spawn_parallel", `Spawning ${agents.length} sub-agents`, {
      agents: agents.map(a => a.type),
    });
  }

  const promises = agents.map(({ type, task }) =>
    spawnAgent(type, task, options).catch(err => ({
      success: false,
      summary: `[${type}] Error: ${err.message}`,
      filesModified: [],
      turnCount: 0,
      totalTokens: 0,
      type,
    }))
  );

  const results = await Promise.all(promises);

  const totalTokens = results.reduce((sum, r) => sum + (r.totalTokens || 0), 0);
  const successes = results.filter(r => r.success).length;

  console.log(chalk.magenta(`  🤖 Parallel complete: ${successes}/${results.length} succeeded, ${totalTokens} tokens total`));

  return results;
}

/**
 * Common workflow: explore → plan → fix → verify
 * Used by the goal loop for complex repairs.
 */
async function exploreAndFix(task, options = {}) {
  // Step 1: Explore — find relevant files
  const exploration = await spawnAgent("explore", `Investigate: ${task}`, options);

  // Step 2: Plan — propose a fix using exploration results
  const planTask = `Based on exploration:\n${exploration.summary}\n\nPlan a fix for: ${task}`;
  const plan = await spawnAgent("plan", planTask, options);

  // Step 3: Fix — execute the plan
  const fixTask = `Execute this fix plan:\n${plan.summary}\n\nOriginal problem: ${task}`;
  const fix = await spawnAgent("fix", fixTask, options);

  return {
    exploration,
    plan,
    fix,
    success: fix.success,
    summary: fix.summary,
    filesModified: fix.filesModified || [],
    totalTokens: (exploration.totalTokens || 0) + (plan.totalTokens || 0) + (fix.totalTokens || 0),
  };
}

module.exports = {
  spawnAgent,
  spawnParallel,
  exploreAndFix,
  AGENT_TOOL_SETS,
  AGENT_CONFIGS,
  AGENT_PROMPTS,
};
