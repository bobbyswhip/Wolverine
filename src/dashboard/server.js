const http = require("http");
const chalk = require("chalk");
const { AdminAuth } = require("../security/admin-auth");
const { AgentEngine } = require("../agent/agent-engine");

/**
 * Wolverine Dashboard Server — real-time web UI + agent command interface.
 *
 * Command routing (claw-code pattern):
 * ALL commands → UTILITY_MODEL classifier (1 word: CHAT or AGENT) → handler
 *
 * No regex. No heuristics. The AI decides the route, every time.
 */

class DashboardServer {
  constructor(options = {}) {
    this.port = options.port || (parseInt(process.env.WOLVERINE_DASHBOARD_PORT, 10) || (parseInt(process.env.PORT, 10) || 3000) + 1);
    this.logger = options.logger;
    this.backupManager = options.backupManager;
    this.perfMonitor = options.perfMonitor;
    this.healthMonitor = options.healthMonitor;
    this.brain = options.brain;
    this.sandbox = options.sandbox;
    this.redactor = options.redactor;
    this.scriptPath = options.scriptPath;
    this.runner = options.runner;
    this.tokenTracker = options.tokenTracker;
    this.skills = options.skills;
    this.repairHistory = options.repairHistory;
    this.processMonitor = options.processMonitor;
    this.routeProber = options.routeProber;

    this.auth = new AdminAuth();
    this._sseClients = new Set();
    this._server = null;
    this._commandRunning = false;

    // Conversation memory (claw-code: TranscriptStore pattern)
    // Maintains rolling context window across chat turns
    this._chatHistory = [];       // { role, content } messages
    this._maxHistoryTurns = 20;   // keep last 20 exchanges
    this._compactAfter = 30;      // compact older messages after this many
  }

  start() {
    if (this.logger) {
      this.logger.on("event", (event) => this._broadcast(event));
    }

    this._server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Key");

      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      if (req.url === "/api/events/stream") return this._handleSSE(req, res);
      if (req.url === "/api/events") return this._handleEvents(req, res);
      if (req.url === "/api/stats") return this._handleStats(req, res);
      if (req.url === "/api/metrics") return this._handleMetrics(req, res);
      if (req.url === "/api/backups") return this._handleBackups(req, res);
      if (req.url === "/api/brain") return this._handleBrain(req, res);
      if (req.url === "/api/usage") return this._handleUsage(req, res);
      if (req.url === "/api/repairs") return this._handleRepairs(req, res);
      if (req.url === "/api/system") return this._handleSystem(req, res);
      if (req.url === "/api/process") return this._handleProcess(req, res);
      if (req.url === "/api/routes") return this._handleRoutes(req, res);
      if (req.url === "/api/usage/history") return this._handleUsageHistory(req, res);
      if (req.url === "/api/auth/verify" && req.method === "POST") return this._handleAuthVerify(req, res);
      if (req.url === "/api/command" && req.method === "POST") return this._handleCommand(req, res);
      if (req.url === "/api/chat/clear" && req.method === "POST") {
        this._chatHistory = [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cleared: true }));
        return;
      }
      if (req.url === "/" || req.url === "/dashboard") return this._handleDashboard(req, res);

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    this._server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.log(chalk.yellow(`  ⚠️  Dashboard port ${this.port} in use — trying ${this.port + 1}`));
        this.port++;
        this._server.listen(this.port, () => {
          console.log(chalk.magenta(`  🖥️  Dashboard: http://localhost:${this.port}`));
        });
      } else {
        console.log(chalk.yellow(`  ⚠️  Dashboard failed to start: ${err.message}`));
      }
    });

    this._server.listen(this.port, () => {
      console.log(chalk.magenta(`  🖥️  Dashboard: http://localhost:${this.port}`));
    });
  }

  stop() {
    for (const client of this._sseClients) client.end();
    this._sseClients.clear();
    if (this._server) this._server.close();
  }

  _broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this._sseClients) client.write(data);
  }

  // ── Auth ──

  _handleAuthVerify(req, res) {
    this._readBody(req, (body) => {
      const fakeReq = { ...req, headers: { ...req.headers, "x-admin-key": body.key } };
      Object.defineProperty(fakeReq, "socket", { get: () => req.socket });
      Object.defineProperty(fakeReq, "connection", { get: () => req.connection });
      const result = this.auth.validate(fakeReq);

      if (result.authorized) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `wolverine_admin_key=${encodeURIComponent(body.key)}; Path=/; SameSite=Strict; Max-Age=31536000`,
        });
        res.end(JSON.stringify({ authorized: true }));
      } else {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ authorized: false, reason: result.reason }));
      }
    });
  }

  // ── Command Interface ──

  _handleCommand(req, res) {
    const authResult = this.auth.validate(req);
    if (!authResult.authorized) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden", reason: authResult.reason }));
      return;
    }

    if (this._commandRunning) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent is already running a command. Wait for it to finish." }));
      return;
    }

    this._readBody(req, async (body) => {
      const command = body.command;
      if (!command || typeof command !== "string" || command.trim().length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No command provided" }));
        return;
      }

      const safeCommand = this.redactor ? this.redactor.redact(command) : command;

      if (this._isSecretExtractionRequest(command)) {
        const refusal = this._buildSecretRefusal();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          summary: refusal,
          filesModified: [],
          turns: 1,
          tokens: 0,
          mode: "chat",
        }));
        return;
      }

      console.log(chalk.magenta(`\n  🎯 Admin command: ${safeCommand.slice(0, 100)}`));
      if (this.logger) {
        this.logger.info("agent.command", `Admin command: ${safeCommand.slice(0, 200)}`, { command: safeCommand });
      }

      this._commandRunning = true;

      const { getModel } = require("../core/models");
      // Helper to broadcast progress via SSE
      const progress = (type, msg) => {
        if (this.logger) this.logger.debug(type, msg, {});
      };

      try {
        // STEP 1: AI classifier
        progress("classify", `Classifying with ${getModel("classifier")}...`);
        const plan = await this._classify(safeCommand);
        progress("classify", `Route: ${plan.route} ${plan.tier}`);

        if (plan.route === "SIMPLE") {
          progress("chat.start", `Simple chat (${getModel("chat")}) — brain lookup...`);
          const result = await this._simpleChat(safeCommand);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        }

        if (plan.route === "TOOLS") {
          progress("chat.start", `Tool chat (${getModel("tool")}) — using tools...`);
          const result = await this._chat(safeCommand);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        }

        // STEP 2: Route by tier
        // SMALL → single AI call, no agent loop (cheapest, fastest)
        // MEDIUM/LARGE → agent with tool loop
        let result;

        // Conversation context for all tiers
        const chatContext = this._chatHistory.slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");

        if (plan.tier === "SMALL") {
          progress("develop", `Smart edit (${getModel("coding")}) — 1 AI call...`);
          result = await this._directEdit(safeCommand, chatContext);
        } else if (plan.tier === "MEDIUM") {
          progress("agent.turn", `Agent mode (${getModel("reasoning")}) — MEDIUM tier`);

          let brainContext = "";
          if (this.brain && this.brain._initialized) {
            try { brainContext = await this.brain.getContext(command); } catch {}
          }

          const agent = new AgentEngine({
            sandbox: this.sandbox,
            logger: this.logger,
            cwd: process.cwd(),
            maxTurns: 8,
            maxTokens: 25000,
          });

          const agentResult = await agent.run({
            errorMessage: safeCommand + (chatContext ? "\n\nConversation:\n" + chatContext : ""),
            stackTrace: "",
            primaryFile: "N/A",
            sourceCode: "",
            brainContext,
          });

          result = {
            success: agentResult.success,
            summary: agentResult.summary,
            filesModified: agentResult.filesModified,
            turns: agentResult.turnCount,
            tokens: agentResult.totalTokens,
            mode: "agent",
            tier: "MEDIUM",
          };
        } else {
          // LARGE tier — sub-agents: explore → plan → fix
          const { exploreAndFix } = require("../agent/sub-agents");
          progress("agent.spawn", `Sub-agents (explore → plan → fix) — LARGE tier`);

          let brainContext = "";
          if (this.brain && this.brain._initialized) {
            try { brainContext = await this.brain.getContext(command); } catch {}
          }

          const subResult = await exploreAndFix(
            safeCommand + (chatContext ? "\n\nConversation:\n" + chatContext : ""),
            { sandbox: this.sandbox, logger: this.logger, cwd: process.cwd(), mcp: this.runner?.mcp, brainContext }
          );

          result = {
            success: subResult.success,
            summary: subResult.summary,
            filesModified: subResult.filesModified || [],
            turns: (subResult.exploration?.turnCount || 0) + (subResult.plan?.turnCount || 0) + (subResult.fix?.turnCount || 0),
            tokens: subResult.totalTokens,
            mode: "sub-agents",
            tier: "LARGE",
          };
        }

        // Add to chat history
        this._chatHistory.push({ role: "user", content: safeCommand });
        this._chatHistory.push({ role: "assistant", content: `[${result.mode}: ${result.summary}. Files: ${(result.filesModified || []).join(", ") || "none"}]` });

        if (this.brain && this.brain._initialized && result.success) {
          this.brain.remember("learnings",
            `Admin command: ${safeCommand}. Result: ${result.summary}. Files: ${result.filesModified.join(", ")}`,
            { type: "admin-command" }
          ).catch(() => {});
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      } finally {
        this._commandRunning = false;
      }
    });
  }

  _isSecretExtractionRequest(command) {
    if (!command || typeof command !== "string") return false;

    const normalized = command.toLowerCase().trim();
    const secretTerms = [
      "api key", "apikey", "openai key", "admin key", "token", "secret", "password", ".env", "environment variable", "env var",
    ];
    const extractionTerms = [
      "what is", "show", "tell me", "give me", "reveal", "print", "display", "dump", "return", "read", "find", "where is",
    ];

    const asksForSecret = secretTerms.some((term) => normalized.includes(term));
    const asksToExtract = extractionTerms.some((term) => normalized.includes(term));

    return asksForSecret && asksToExtract;
  }

  _buildSecretRefusal() {
    return "I can’t reveal API keys or other secrets. If you need to verify configuration, check the relevant environment variables such as process.env.OPENAI_API_KEY or process.env.WOLVERINE_ADMIN_KEY on the server without printing their values.";
  }

  // ── AI Classifier + Tier (UTILITY_MODEL, one call) ──

  async _classify(command) {
    const { aiCall } = require("../core/ai-client");
    const { getModel } = require("../core/models");

    try {
      const result = await aiCall({
        model: getModel("classifier"),
        systemPrompt: "Route a command. Respond with two words: ROUTE SIZE.\nROUTE: SIMPLE (general knowledge/explanation, no live data needed), TOOLS (needs live server data, file contents, or endpoint calls), AGENT (create/modify/fix code).\nSIZE: SMALL, MEDIUM, LARGE.\nExamples: 'what is wolverine' → SIMPLE SMALL. 'what time is it' → TOOLS SMALL. 'show me index.js' → TOOLS SMALL. 'add endpoint' → AGENT SMALL. 'build auth' → AGENT LARGE.",
        userPrompt: command,
        maxTokens: 10,
        category: "classify",
      });

      const raw = (result.content || "").trim().toUpperCase();
      // Parse flexibly — three routes: SIMPLE (no tools), TOOLS (with tools), AGENT (code changes)
      let route = "SIMPLE";
      if (raw.includes("AGENT")) route = "AGENT";
      else if (raw.includes("TOOL")) route = "TOOLS";
      else if (raw.includes("SIMPLE")) route = "SIMPLE";
      const tier = raw.includes("LARGE") ? "LARGE" : raw.includes("MEDIUM") ? "MEDIUM" : "SMALL";

      console.log(chalk.gray(`  🏷️  Route: ${route} ${tier} (raw: "${raw}")`));
      return { route, tier };
    } catch (err) {
      console.log(chalk.yellow(`  🏷️  Classifier failed: ${err.message} — defaulting to CHAT`));
      return { route: "CHAT", tier: "SMALL" };
    }
  }

  // ── Smart Edit (SMALL tier) — ONE AI call → structured file operations ──
  // Returns JSON with file operations: create, edit, mount.
  // Follows server best practices: routes in server/routes/, index.js is just wiring.

  async _directEdit(command, chatContext) {
    const { aiCall } = require("../core/ai-client");
    const { getModel } = require("../core/models");
    const fs = require("fs");
    const path = require("path");
    const http = require("http");

    const cwd = process.cwd();
    const serverDir = path.join(cwd, "server");
    console.log(chalk.gray(`  📐 Tier: SMALL (smart edit, 1 AI call)`));

    // Read the current server structure
    const indexPath = this.scriptPath ? path.relative(cwd, this.scriptPath).replace(/\\/g, "/") : "server/index.js";
    let indexContent = "";
    try { indexContent = this.sandbox.readFile(path.resolve(cwd, indexPath)); } catch {}

    // Read existing route files for context
    const routesDir = path.join(serverDir, "routes");
    let existingRoutes = "";
    if (fs.existsSync(routesDir)) {
      const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith(".js"));
      for (const rf of routeFiles.slice(0, 5)) {
        const content = fs.readFileSync(path.join(routesDir, rf), "utf-8");
        existingRoutes += `\n--- server/routes/${rf} ---\n${content}\n`;
      }
    }

    // Inject relevant skill context (claw-code: pre-enrich with matched skills)
    let skillContext = "";
    if (this.skills) {
      skillContext = this.skills.buildContext(command);
      if (skillContext) console.log(chalk.gray(`  🔧 Skills matched for this task`));
    }

    // One AI call: return a JSON plan with file operations
    const result = await aiCall({
      model: getModel("coding"),
      systemPrompt: `You are a Node.js server architect. Given an instruction, return ONLY valid JSON describing file operations.

RULES:
- Server uses Fastify (NOT Express). Routes are async functions registered as plugins.
- New endpoints go in server/routes/ as separate files (one per resource)
- server/index.js is ONLY for wiring: fastify.register(require("./routes/X"), { prefix: "/X" })
- Route file format: async function routes(fastify) { fastify.get("/", async () => ({...})); } module.exports = routes;
- If a route file already exists for this resource, edit it. Otherwise create a new one.
- If index.js needs a new register, include that edit.
- If a skill is available below, USE IT in the generated code instead of building from scratch.
${skillContext}

Return ONLY this JSON format:
{
  "summary": "what was done",
  "operations": [
    { "action": "create", "path": "server/routes/time.js", "content": "full file content" },
    { "action": "edit", "path": "server/index.js", "find": "exact text to find", "replace": "replacement text" }
  ]
}`,
      userPrompt: `Instruction: ${command}${chatContext ? "\nConversation: " + chatContext : ""}

Current server/index.js:
${indexContent}

Existing route files:
${existingRoutes || "(none)"}`,
      maxTokens: 2048,
      category: "develop",
    });

    const raw = (result.content || "").trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    let plan;
    try { plan = JSON.parse(raw); }
    catch { return { success: false, summary: "AI returned invalid JSON: " + raw.slice(0, 100), filesModified: [], turns: 1, tokens: 0, mode: "direct", tier: "SMALL" }; }

    const tokens = (result.usage?.prompt_tokens || result.usage?.input_tokens || 0)
      + (result.usage?.completion_tokens || result.usage?.output_tokens || 0);

    // Backup entire server/ before making changes
    if (this.runner && this.runner.backupManager) {
      const bid = this.runner.backupManager.createBackup(null);
      this.runner.backupManager.markVerified(bid);
      console.log(chalk.gray(`  💾 Backup created: ${bid}`));
    }

    // Execute operations
    const filesModified = [];
    for (const op of (plan.operations || [])) {
      const filePath = path.resolve(cwd, op.path);
      const relPath = op.path;

      // Protected path check
      const { AgentEngine } = require("../agent/agent-engine");
      const guard = new AgentEngine({ cwd });
      if (guard._isProtectedPath(relPath)) {
        console.log(chalk.red(`  🛡️ Blocked: ${relPath}`));
        continue;
      }

      if (op.action === "create") {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        this.sandbox.writeFile(filePath, op.content);
        filesModified.push(relPath);
        console.log(chalk.green(`  📝 Created: ${relPath}`));
      } else if (op.action === "edit" && op.find && op.replace !== undefined) {
        try {
          const current = this.sandbox.readFile(filePath);
          if (current.includes(op.find)) {
            this.sandbox.writeFile(filePath, current.replace(op.find, op.replace));
            filesModified.push(relPath);
            console.log(chalk.green(`  ✏️  Edited: ${relPath}`));
          } else {
            console.log(chalk.yellow(`  ⚠️ Could not find text to replace in ${relPath}`));
          }
        } catch (e) { console.log(chalk.yellow(`  ⚠️ ${relPath}: ${e.message}`)); }
      }
    }

    // Restart the server to pick up changes, then test
    const port = parseInt(process.env.PORT, 10) || 3000;
    const endpointMatch = command.match(/\/\w[\w/]*/);

    if (filesModified.length > 0 && this.runner) {
      console.log(chalk.blue(`  🔄 Restarting server to apply changes...`));
      this.runner.restart();

      // Wait for server to come back up
      await new Promise(r => setTimeout(r, 3000));

      // Test the endpoint if one was mentioned
      if (endpointMatch) {
        const testPath = endpointMatch[0];
        console.log(chalk.gray(`  🧪 Testing ${testPath}...`));
        try {
          const testResult = await new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}${testPath}`, { timeout: 5000 }, (res) => {
              let body = "";
              res.on("data", (d) => { body += d; });
              res.on("end", () => resolve({ status: res.statusCode, body: body.slice(0, 200) }));
            });
            req.on("error", (e) => resolve({ status: 0, body: e.message }));
            req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
          });
          if (testResult.status >= 200 && testResult.status < 400) {
            console.log(chalk.green(`  ✅ ${testPath} → ${testResult.status}: ${testResult.body.slice(0, 80)}`));
            plan.summary += ` | Tested: ${testPath} → ${testResult.status}: ${testResult.body.slice(0, 60)}`;
          } else {
            console.log(chalk.yellow(`  ⚠️ ${testPath} → ${testResult.status}: ${testResult.body.slice(0, 80)}`));
            plan.summary += ` | Test: ${testPath} → ${testResult.status}`;
          }
        } catch {}
      }
    }

    // Update brain: rescan function map + embed new knowledge
    if (this.brain && this.brain._initialized && filesModified.length > 0) {
      try {
        const { scanProject, mapToChunks } = require("../brain/function-map");
        const { embedBatch } = require("../brain/embedder");

        // Rescan the project to pick up new routes/functions
        this.brain.functionMap = scanProject(cwd);
        console.log(chalk.gray(`  🧠 Rescanned: ${this.brain.functionMap.routes.length} routes, ${this.brain.functionMap.functions.length} functions`));

        // Clear old function entries and re-embed
        const oldEntries = this.brain.store.getNamespace("functions");
        for (const e of oldEntries) this.brain.store.delete(e.id);

        const chunks = mapToChunks(this.brain.functionMap);
        if (chunks.length > 0) {
          const texts = chunks.map(c => c.text);
          const embeddings = await embedBatch(texts);
          for (let i = 0; i < chunks.length; i++) {
            this.brain.store.add("functions", chunks[i].text, embeddings[i], chunks[i].metadata);
          }
        }

        // Also remember the specific change
        await this.brain.remember("learnings", `Built: ${command}. Files: ${filesModified.join(", ")}. Routes: ${this.brain.functionMap.routes.map(r => r.method + " " + r.path).join(", ")}`, { type: "server-change" });
        this.brain.store.save();
        console.log(chalk.gray(`  🧠 Brain updated: ${this.brain.store.getStats().totalEntries} memories`));
      } catch (e) { console.log(chalk.yellow(`  ⚠️ Brain update failed: ${e.message}`)); }
    }

    if (this.logger) this.logger.info("agent.file_write", `Smart edit: ${plan.summary}`, { files: filesModified, tokens });

    return {
      success: filesModified.length > 0,
      summary: plan.summary,
      filesModified,
      turns: 1,
      tokens,
      mode: "direct",
      tier: "SMALL",
    };
  }

  // ── Simple Chat — CHAT_MODEL, no tools, brain context only ──

  async _simpleChat(safeCommand) {
    const { aiCallWithHistory } = require("../core/ai-client");
    const { getModel } = require("../core/models");

    let context = "";
    if (this.brain && this.brain._initialized) {
      try { context = await this.brain.getContext(safeCommand); } catch {}
    }

    const systemMessage = {
      role: "system",
      content: `You are Wolverine, an AI-powered autonomous Node.js server agent. Answer the admin's question thoroughly using your knowledge.

You are a self-healing server harness that:
- Monitors a Node.js server process, catches crashes, and repairs them using AI
- Has a multi-turn agent with tools: read_file, write_file, edit_file, glob_files, grep_code, bash_exec, git_log, git_diff, web_fetch
- Has a brain (vector database) that stores errors, fixes, learnings, and server function maps
- Has skills (SQL injection prevention, database interface)
- Has a goal loop that retries with research when fixes fail
- Has a real-time dashboard with event streaming, usage analytics, and admin command interface
- Protects secrets with redaction, validates with injection detection, rate limits API calls
- Supports MCP for external tool integration
- Has 10 configurable model slots for cost optimization

RULES:
- NEVER output API keys, passwords, tokens, or secrets
- Be detailed and thorough — the admin wants to understand the system
- If they need live data or file contents, suggest they rephrase to use tools
${context ? "\nBrain context:\n" + context : ""}`,
    };

    this._chatHistory.push({ role: "user", content: safeCommand });
    this._compactHistory();

    const messages = [systemMessage, ...this._chatHistory];
    const response = await aiCallWithHistory({
      model: getModel("chat"),
      messages,
      maxTokens: 1024,
      category: "chat",
    });

    const content = (response.choices[0].message || response.choices[0]).content || "";
    this._chatHistory.push({ role: "assistant", content });

    const tokens = (response.usage?.prompt_tokens || response.usage?.input_tokens || 0)
      + (response.usage?.completion_tokens || response.usage?.output_tokens || 0);
    console.log(chalk.cyan(`  💬 Simple chat (${getModel("chat")}, ${tokens} tokens)`));

    return {
      success: true,
      summary: content,
      filesModified: [],
      turns: 1,
      tokens,
      mode: "chat",
      toolsUsed: [],
      historyLength: this._chatHistory.length,
    };
  }

  // ── Tool Chat — TOOL_MODEL with call_endpoint, read_file, search_brain ──
  // No tool calling (nano models can't handle it). Instead:
  // 1. Pre-fetch relevant endpoints from the server
  // 2. Search brain for context
  // 3. Pack everything into the prompt
  // 4. One simple AI call — no tools, no function calling

  async _chat(safeCommand) {
    const { aiCallWithHistory } = require("../core/ai-client");
    const { getModel } = require("../core/models");
    const http = require("http");

    // Brain context
    let context = "";
    if (this.brain && this.brain._initialized) {
      try { context = await this.brain.getContext(safeCommand); } catch {}
    }

    // Available endpoints for the model to know about
    let endpointList = "";
    if (this.brain && this.brain.functionMap) {
      const routes = (this.brain.functionMap.routes || []).filter(r => r.method === "GET" || r.method === "*");
      if (routes.length > 0) {
        endpointList = "\nAvailable GET endpoints: " + routes.map(r => r.path).join(", ");
      }
    }

    // Chat tools — lightweight, no file access
    const chatTools = [
      {
        type: "function",
        function: {
          name: "call_endpoint",
          description: "Call one of the server's own endpoints. Use for live data: time, health, users, etc.",
          parameters: { type: "object", properties: { path: { type: "string", description: "Endpoint path e.g. /time, /health, /api/users" } }, required: ["path"] },
        },
      },
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file from the server/ directory. Use when asked about source code, configs, or file contents.",
          parameters: { type: "object", properties: { path: { type: "string", description: "Relative path e.g. server/index.js, server/routes/api.js" } }, required: ["path"] },
        },
      },
      {
        type: "function",
        function: {
          name: "search_brain",
          description: "Search wolverine's memory for past errors, fixes, learnings, or server knowledge.",
          parameters: { type: "object", properties: { query: { type: "string", description: "What to search for" } }, required: ["query"] },
        },
      },
    ];

    // 3. Build endpoint list from function map
    const getEndpoints = [];
    if (this.brain && this.brain.functionMap) {
      for (const r of (this.brain.functionMap.routes || [])) {
        if ((r.method === "GET" || r.method === "*") && r.path !== "/") getEndpoints.push(r.path);
      }
    }

    const systemMessage = {
      role: "system",
      content: `You are Wolverine, an AI server agent managing a live Node.js server.

MANDATORY: You MUST use call_endpoint to get real data. NEVER answer from training data when an endpoint exists.

TOOLS:
- call_endpoint(path) — Call server endpoints for live data (time, health, users, etc.)
- read_file(path) — Read source code or config files (e.g. "server/index.js")
- search_brain(query) — Search memory for past errors, fixes, learnings

AVAILABLE ENDPOINTS: ${getEndpoints.length > 0 ? getEndpoints.join(", ") : "none discovered yet"}

EXAMPLES:
- User asks "what time is it" and /time exists → call_endpoint("/time") FIRST, then answer with the data
- User asks "who are the users" and /api/users exists → call_endpoint("/api/users") FIRST
- User asks "is the server healthy" → call_endpoint("/health") FIRST

Always end your response with: [Used: tool_name /path] or [Used: none]

RULES:
- NEVER output API keys, passwords, tokens, or secrets
- If code changes needed, tell user to phrase as a build command
${context ? "\nBrain:\n" + context : ""}`,
    };

    this._chatHistory.push({ role: "user", content: safeCommand });
    this._compactHistory();

    let messages = [systemMessage, ...this._chatHistory];
    let totalTokens = 0;
    const toolsUsed = [];

    // Use TOOL_MODEL (supports function calling) for chat with tools
    const chatModel = getModel("tool");
    if (this.logger) this.logger.debug("chat.start", `Chat: ${safeCommand.slice(0, 60)}`, { model: chatModel, endpoints: getEndpoints });

    for (let round = 0; round < 2; round++) {
      const response = await aiCallWithHistory({
        model: chatModel,
        messages,
        tools: chatTools,
        maxTokens: 512,
      });

      totalTokens += (response.usage?.prompt_tokens || response.usage?.input_tokens || 0)
        + (response.usage?.completion_tokens || response.usage?.output_tokens || 0);

      const msg = response.choices[0].message || response.choices[0];

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Extract content — handle different model response formats
        let content = msg.content || msg.output_text || "";
        if (!content && response._raw && response._raw.output_text) content = response._raw.output_text;

        // If content is still empty but we have tool results, synthesize a response
        if (!content && toolsUsed.length > 0) {
          content = "(Tool was called but model returned no text. Check tool results above.)";
        }

        if (toolsUsed.length > 0 && !content.includes("[Used:")) {
          content += `\n[Used: ${toolsUsed.join(", ")}]`;
        }
        this._chatHistory.push({ role: "assistant", content });
        console.log(chalk.cyan(`  💬 Chat (${chatModel}, ${totalTokens} tokens, tools: ${toolsUsed.join(", ") || "none"})`));
        if (this.logger) this.logger.info("chat.response", `Chat (tools: ${toolsUsed.join(", ") || "none"})`, { tokens: totalTokens, tools: toolsUsed });
        return { success: true, summary: content, filesModified: [], turns: 1, tokens: totalTokens, mode: "chat", toolsUsed, historyLength: this._chatHistory.length };
      }

      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let toolResult = "";
        const args = JSON.parse(tc.function.arguments || "{}");

        if (tc.function.name === "call_endpoint") {
          const port = parseInt(process.env.PORT, 10) || 3000;
          toolsUsed.push(`call_endpoint ${args.path}`);
          console.log(chalk.gray(`  🌐 Calling: GET ${args.path}`));
          if (this.logger) this.logger.debug("chat.tool", `GET ${args.path}`, { tool: "call_endpoint", path: args.path });
          try {
            toolResult = await new Promise((resolve) => {
              const req = http.get(`http://127.0.0.1:${port}${args.path}`, { timeout: 3000 }, (res) => {
                let body = "";
                res.on("data", (d) => { body += d; });
                res.on("end", () => resolve(`HTTP ${res.statusCode}: ${body.slice(0, 500)}`));
              });
              req.on("error", (e) => resolve(`Error: ${e.message}`));
              req.on("timeout", () => { req.destroy(); resolve("Timeout"); });
            });
            toolResult = this.redactor ? this.redactor.redact(toolResult) : toolResult;
            console.log(chalk.green(`  🌐 → ${toolResult.slice(0, 80)}`));
          } catch (e) { toolResult = `Error: ${e.message}`; }
        } else if (tc.function.name === "read_file") {
          const filePath = args.path || "";
          toolsUsed.push(`read_file ${filePath}`);
          console.log(chalk.gray(`  📖 Reading: ${filePath}`));
          if (this.logger) this.logger.debug("chat.tool", `Read ${filePath}`, { tool: "read_file", path: filePath });
          try {
            const fs = require("fs");
            const path = require("path");
            const fullPath = path.resolve(process.cwd(), filePath);
            // Security: only allow reading from server/ directory or project root files
            const rel = path.relative(process.cwd(), fullPath).replace(/\\/g, "/");
            if (rel.startsWith("..") || rel.startsWith("node_modules")) {
              toolResult = "BLOCKED: Can only read files within the project.";
            } else {
              const content = fs.readFileSync(fullPath, "utf-8");
              toolResult = this.redactor ? this.redactor.redact(content.slice(0, 3000)) : content.slice(0, 3000);
              if (content.length > 3000) toolResult += "\n... (truncated, " + content.length + " chars total)";
            }
            console.log(chalk.green(`  📖 → ${toolResult.slice(0, 60)}`));
          } catch (e) { toolResult = `Error reading file: ${e.message}`; }
        } else if (tc.function.name === "run_command") {
          const cmd = args.command || "";
          toolsUsed.push(`run_command "${cmd.slice(0, 30)}"`);
          console.log(chalk.gray(`  ⚡ Running: ${cmd.slice(0, 60)}`));
          if (this.logger) this.logger.debug("chat.tool", `Cmd: ${cmd}`, { tool: "run_command" });
          try {
            const { execSync } = require("child_process");
            // Block dangerous commands
            if (/rm\s+-rf|rmdir|format|mkfs|git\s+push\s+--force/i.test(cmd)) {
              toolResult = "BLOCKED: Dangerous command.";
            } else {
              const output = execSync(cmd, { cwd: process.cwd(), encoding: "utf-8", timeout: 10000, maxBuffer: 512 * 1024 });
              toolResult = this.redactor ? this.redactor.redact(output.slice(0, 2000)) : output.slice(0, 2000);
            }
            console.log(chalk.green(`  ⚡ → ${toolResult.slice(0, 60)}`));
          } catch (e) { toolResult = `Command failed: ${(e.stderr || e.message || "").slice(0, 500)}`; }
        } else if (tc.function.name === "search_brain") {
          toolsUsed.push(`search_brain "${(args.query || "").slice(0, 30)}"`);
          console.log(chalk.gray(`  🧠 Searching: ${args.query}`));
          if (this.logger) this.logger.debug("chat.tool", `Brain: ${args.query}`, { tool: "search_brain" });
          if (this.brain && this.brain._initialized) {
            try {
              const results = await this.brain.recall(args.query, { topK: 3 });
              toolResult = results.length > 0 ? results.map(r => `[${r.namespace}] ${r.text}`).join("\n") : "No matching memories.";
            } catch { toolResult = "Brain search failed."; }
          } else { toolResult = "Brain not initialized."; }
        }

        messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
      }
    }

    this._chatHistory.push({ role: "assistant", content: "Tool loop exhausted." });
    return { success: true, summary: "Tool loop exhausted", filesModified: [], turns: 1, tokens: totalTokens, mode: "chat", toolsUsed, historyLength: this._chatHistory.length };
  }

  // claw-code: TranscriptStore.compact() — prune old messages to manage context window
  _compactHistory() {
    if (this._chatHistory.length <= this._compactAfter) return;

    // Keep the last N turns (user+assistant pairs)
    const keepMessages = this._maxHistoryTurns * 2;
    const excess = this._chatHistory.length - keepMessages;
    if (excess <= 0) return;

    // Summarize the oldest messages into one context message
    const old = this._chatHistory.slice(0, excess);
    const summary = old.map(m => `${m.role}: ${m.content.slice(0, 100)}`).join(" | ");

    // Replace old messages with a single summary
    this._chatHistory = [
      { role: "assistant", content: `[Earlier conversation summary: ${summary}]` },
      ...this._chatHistory.slice(excess),
    ];

    console.log(chalk.gray(`  📝 Compacted ${excess} old messages into summary`));
  }

  // ── Read-only endpoints ──

  _handleSSE(req, res) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`);
    this._sseClients.add(res);
    req.on("close", () => this._sseClients.delete(res));
  }

  _handleEvents(req, res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.logger ? this.logger.query({ limit: 200 }) : []));
  }

  _handleStats(req, res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      session: this.logger ? this.logger.getSessionStats() : {},
      backups: this.backupManager ? this.backupManager.getStats() : {},
      health: this.healthMonitor ? this.healthMonitor.getStats() : {},
    }));
  }

  _handleMetrics(req, res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.perfMonitor ? this.perfMonitor.getMetrics() : {}));
  }

  _handleBackups(req, res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.backupManager ? this.backupManager.manifest.backups : []));
  }

  _handleUsage(req, res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.tokenTracker ? this.tokenTracker.getAnalytics() : {}));
  }

  _handleUsageHistory(req, res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.tokenTracker ? this.tokenTracker.getAggregates() : {}));
  }

  _handleSystem(req, res) {
    const { detect } = require("../core/system-info");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(detect()));
  }

  _handleProcess(req, res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.processMonitor ? this.processMonitor.getMetrics() : {}));
  }

  _handleRoutes(req, res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    const metrics = this.routeProber ? this.routeProber.getMetrics() : {};
    const summary = this.routeProber ? this.routeProber.getSummary() : {};
    res.end(JSON.stringify({ routes: metrics, summary }));
  }

  _handleRepairs(req, res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.repairHistory ? { repairs: this.repairHistory.getAll(), stats: this.repairHistory.getStats() } : { repairs: [], stats: {} }));
  }

  _handleBrain(req, res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.brain ? this.brain.getStats() : {}));
  }

  _handleDashboard(req, res) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(DASHBOARD_HTML.replace(/__PORT__/g, String(this.port)));
  }

  _readBody(req, cb) {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { cb(JSON.parse(body)); } catch { cb({}); }
    });
  }
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Wolverine Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0e14;--surface:#12171f;--surface2:#1a2030;--border:#1e2a3a;--text:#c5cdd8;--text2:#6b7a8d;--accent:#f0883e;--green:#3fb950;--red:#f85149;--blue:#58a6ff;--yellow:#d29922;--purple:#bc8cff}
body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);display:grid;grid-template-columns:220px 1fr;grid-template-rows:56px 1fr;height:100vh;overflow:hidden}
header{grid-column:1/3;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 24px;gap:16px}
header h1{font-size:1.1rem;color:var(--accent);font-weight:700;display:flex;align-items:center;gap:8px}
header h1 svg{width:24px;height:24px}
.conn{width:8px;height:8px;border-radius:50%;background:var(--red);transition:background .3s}
.conn.on{background:var(--green)}
.header-stat{font-size:.75rem;color:var(--text2);margin-left:auto;display:flex;gap:20px}
.header-stat span{color:var(--text)}
.auth-badge{font-size:.7rem;padding:3px 10px;border-radius:20px;background:rgba(248,81,73,.15);color:var(--red)}
.auth-badge.ok{background:rgba(63,185,80,.15);color:var(--green)}
nav{background:var(--surface);border-right:1px solid var(--border);padding:16px 0;overflow-y:auto}
nav a{display:flex;align-items:center;gap:10px;padding:10px 20px;color:var(--text2);text-decoration:none;font-size:.85rem;transition:all .15s;cursor:pointer;border-left:3px solid transparent}
nav a:hover{background:var(--surface2);color:var(--text)}
nav a.active{color:var(--accent);border-left-color:var(--accent);background:rgba(240,136,62,.06)}
nav .sep{height:1px;background:var(--border);margin:12px 16px}
nav .label{font-size:.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--text2);padding:12px 20px 6px;font-weight:600}
main{overflow-y:auto;padding:24px}
.panel{display:none}.panel.active{display:block}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:24px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px 20px;position:relative;overflow:hidden}
.stat-card::after{content:'';position:absolute;top:0;left:0;right:0;height:3px}
.stat-card.heal::after{background:var(--green)}.stat-card.err::after{background:var(--red)}
.stat-card.roll::after{background:var(--yellow)}.stat-card.brain::after{background:var(--purple)}
.stat-card.up::after{background:var(--blue)}
.stat-val{font-size:1.8rem;font-weight:700;color:var(--text);line-height:1}
.stat-lbl{font-size:.7rem;color:var(--text2);margin-top:6px;text-transform:uppercase;letter-spacing:.5px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px}
.card h3{font-size:.85rem;color:var(--text2);margin-bottom:14px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.ev{padding:10px 14px;border-radius:6px;margin-bottom:4px;font-size:.8rem;display:grid;grid-template-columns:72px 170px 1fr;gap:10px;transition:background .1s}
.ev:hover{background:var(--surface2)}
.ev .t{color:var(--text2);font-family:'SF Mono',monospace;font-size:.75rem}
.ev .tp{font-family:'SF Mono',monospace;font-size:.75rem}
.ev .m{color:var(--text);word-break:break-word}
.sev-info .tp{color:var(--green)}.sev-warn .tp{color:var(--yellow)}
.sev-error .tp,.sev-critical .tp{color:var(--red)}.sev-debug .tp{color:var(--text2)}
.ev-list{max-height:calc(100vh - 280px);overflow-y:auto}
.mrow{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:.82rem}
.mrow:last-child{border:none}
.mrow .ep{color:var(--blue);font-family:'SF Mono',monospace;font-size:.78rem}
.mrow .vals{color:var(--text2)}.mrow .vals b{color:var(--text);font-weight:500}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:.7rem;font-weight:600;letter-spacing:.3px}
.badge-stable{background:rgba(63,185,80,.15);color:var(--green)}
.badge-verified{background:rgba(88,166,255,.15);color:var(--blue)}
.badge-unstable{background:rgba(248,81,73,.15);color:var(--red)}
.ns-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.ns-card{background:var(--surface2);border-radius:8px;padding:14px;text-align:center}
.ns-card .n{font-size:1.6rem;font-weight:700;color:var(--purple)}
.ns-card .l{font-size:.7rem;color:var(--text2);margin-top:4px;text-transform:uppercase}
.empty{color:var(--text2);font-size:.82rem;padding:20px 0;text-align:center}
.chat-wrap{display:flex;flex-direction:column;height:calc(100vh - 140px)}
.chat-log{flex:1;overflow-y:auto;padding:4px 0}
.chat-msg{padding:12px 16px;margin:6px 0;border-radius:8px;font-size:.85rem;line-height:1.5;max-width:85%;word-break:break-word}
.chat-msg.user{background:var(--surface2);margin-left:auto;border-bottom-right-radius:2px}
.chat-msg.agent{background:rgba(240,136,62,.08);border:1px solid rgba(240,136,62,.15);border-bottom-left-radius:2px}
.chat-msg.system{background:rgba(88,166,255,.08);color:var(--blue);font-size:.78rem;text-align:center;max-width:100%}
.chat-msg .files{margin-top:8px;font-size:.75rem;color:var(--text2)}
.chat-msg .files span{color:var(--green)}
.chat-input{display:flex;gap:10px;padding:14px 0 0}
.chat-input input{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;color:var(--text);font-size:.85rem;outline:none}
.chat-input input:focus{border-color:var(--accent)}
.chat-input button{background:var(--accent);color:white;border:none;border-radius:8px;padding:12px 24px;font-weight:600;cursor:pointer;font-size:.85rem}
.chat-input button:hover{opacity:.9}
.chat-input button:disabled{opacity:.4;cursor:not-allowed}
.auth-gate{max-width:400px;margin:60px auto;text-align:center}
.auth-gate h2{color:var(--accent);margin-bottom:8px;font-size:1.1rem}
.auth-gate p{color:var(--text2);font-size:.82rem;margin-bottom:20px}
.auth-gate input{width:100%;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;color:var(--text);font-size:.85rem;outline:none;text-align:center;letter-spacing:2px;margin-bottom:12px}
.auth-gate input:focus{border-color:var(--accent)}
.auth-gate button{background:var(--accent);color:white;border:none;border-radius:8px;padding:10px 32px;font-weight:600;cursor:pointer}
.auth-gate .err{color:var(--red);font-size:.78rem;margin-top:8px}
.chat-msg .mode-tag{display:inline-block;font-size:.65rem;padding:2px 6px;border-radius:4px;margin-bottom:4px}
.mode-tag.chat{background:rgba(88,166,255,.15);color:var(--blue)}
.mode-tag.agent{background:rgba(240,136,62,.15);color:var(--accent)}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style></head>
<body>
<header>
  <h1><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg> Wolverine</h1>
  <div class="conn" id="status"></div>
  <span class="auth-badge" id="auth-badge">Locked</span>
  <div class="header-stat">
    <div>Session <span id="h-uptime">0s</span></div>
    <div>Events <span id="h-events">0</span></div>
  </div>
</header>
<nav>
  <div class="label">Monitor</div>
  <a class="active" data-panel="overview">📊 Overview</a>
  <a data-panel="events">📋 Events</a>
  <a data-panel="perf">⚡ Performance</a>
  <a data-panel="analytics">📊 Analytics</a>
  <a data-panel="processes">⚙️ Processes</a>
  <div class="sep"></div>
  <div class="label">Agent</div>
  <a data-panel="command">💬 Command</a>
  <div class="sep"></div>
  <div class="label">System</div>
  <a data-panel="backups">💾 Backups</a>
  <a data-panel="brain">🧠 Brain</a>
  <a data-panel="tools">🔧 Tools</a>
  <a data-panel="repairs">🔧 Repairs</a>
  <a data-panel="usage">📈 Usage</a>
</nav>
<main>
<div class="panel active" id="p-overview">
  <div class="stats">
    <div class="stat-card heal"><div class="stat-val" id="s-heals">0</div><div class="stat-lbl">Heals</div></div>
    <div class="stat-card err"><div class="stat-val" id="s-errors">0</div><div class="stat-lbl">Errors</div></div>
    <div class="stat-card roll"><div class="stat-val" id="s-rollbacks">0</div><div class="stat-lbl">Rollbacks</div></div>
    <div class="stat-card brain"><div class="stat-val" id="s-memories">0</div><div class="stat-lbl">Memories</div></div>
    <div class="stat-card up"><div class="stat-val" id="s-uptime">0s</div><div class="stat-lbl">Uptime</div></div>
  </div>
  <div class="row2">
    <div class="card"><h3>Recent Events</h3><div class="ev-list" id="ov-events" style="max-height:400px"></div></div>
    <div>
      <div class="card"><h3>Backups</h3><div id="ov-backups"><div class="empty">No backups yet</div></div></div>
      <div class="card"><h3>Performance</h3><div id="ov-metrics"><div class="empty">No traffic yet</div></div></div>
    </div>
  </div>
</div>
<div class="panel" id="p-events"><div class="card"><h3>Live Event Stream</h3><div class="ev-list" id="ev-all"></div></div></div>
<div class="panel" id="p-perf"><div class="card"><h3>Endpoint Metrics</h3><div id="perf-list"><div class="empty">No traffic yet</div></div></div></div>
<div class="panel" id="p-processes">
  <div class="stats" style="grid-template-columns:repeat(4,1fr)">
    <div class="stat-card heal"><div class="stat-val" id="proc-pid">-</div><div class="stat-lbl">Server PID</div></div>
    <div class="stat-card up"><div class="stat-val" id="proc-up">-</div><div class="stat-lbl">Uptime</div></div>
    <div class="stat-card err"><div class="stat-val" id="proc-mem">-</div><div class="stat-lbl">Memory (RSS)</div></div>
    <div class="stat-card brain"><div class="stat-val" id="proc-cpu">-</div><div class="stat-lbl">CPU %</div></div>
  </div>
  <div class="row2">
    <div class="card">
      <h3>System</h3>
      <div id="proc-sys"><div class="empty">Loading...</div></div>
    </div>
    <div class="card">
      <h3>Process Health</h3>
      <div id="proc-health"><div class="empty">Loading...</div></div>
    </div>
  </div>
  <div class="card">
    <h3>Memory Timeline</h3>
    <div id="proc-mem-chart" style="height:160px"></div>
  </div>
  <div class="card">
    <h3>Active Connections & Listeners</h3>
    <div id="proc-listen"><div class="empty">Loading...</div></div>
  </div>
</div>
<div class="panel" id="p-analytics">
  <div class="stats" style="grid-template-columns:repeat(4,1fr)">
    <div class="stat-card heal"><div class="stat-val" id="a-mem">-</div><div class="stat-lbl">Memory (RSS)</div></div>
    <div class="stat-card up"><div class="stat-val" id="a-cpu">-</div><div class="stat-lbl">CPU %</div></div>
    <div class="stat-card brain"><div class="stat-val" id="a-routes">-</div><div class="stat-lbl">Routes Monitored</div></div>
    <div class="stat-card err"><div class="stat-val" id="a-health">-</div><div class="stat-lbl">Route Health</div></div>
  </div>
  <div class="row2">
    <div class="card"><h3>Memory Over Time</h3><div id="a-mem-chart" style="height:150px"></div></div>
    <div class="card"><h3>CPU Over Time</h3><div id="a-cpu-chart" style="height:150px"></div></div>
  </div>
  <div class="card"><h3>Route Response Times</h3><div id="a-route-list"><div class="empty">Waiting for first probe cycle...</div></div></div>
</div>
<div class="panel" id="p-command">
  <div id="cmd-auth" class="auth-gate">
    <h2>🔐 Admin Authentication</h2>
    <p>Enter your WOLVERINE_ADMIN_KEY to access the agent command interface.</p>
    <input type="password" id="auth-input" placeholder="Admin key" autocomplete="off">
    <br><button onclick="doAuth()">Authenticate</button>
    <div class="err" id="auth-err"></div>
  </div>
  <div id="cmd-chat" style="display:none" class="chat-wrap">
    <div class="chat-log" id="chat-log">
      <div class="chat-msg system">Chat has conversation memory. Questions → chat model. Build commands → agent. AI routes automatically.</div>
    </div>
    <div class="chat-input">
      <input type="text" id="cmd-input" placeholder="Ask a question or give a command..." onkeydown="if(event.key==='Enter')sendCmd()">
      <button id="cmd-btn" onclick="sendCmd()">Send</button>
      <button onclick="clearChat()" style="background:var(--surface2);color:var(--text2);border:1px solid var(--border);border-radius:8px;padding:12px 16px;cursor:pointer;font-size:.8rem">Clear</button>
    </div>
  </div>
</div>
<div class="panel" id="p-backups"><div class="card"><h3>Backup History</h3><div id="bk-list"><div class="empty">No backups</div></div></div></div>
<div class="panel" id="p-brain">
  <div class="card"><h3>Brain Statistics</h3><div class="ns-grid" id="br-ns"></div></div>
  <div class="card" style="margin-top:16px"><h3>Function Map</h3><div id="br-fmap"><div class="empty">Loading...</div></div></div>
</div>
<div class="panel" id="p-tools"><div class="card"><h3>Agent Tool Harness</h3><div id="tool-list"></div></div></div>
<div class="panel" id="p-repairs">
  <div class="stats" style="grid-template-columns:repeat(4,1fr)">
    <div class="stat-card heal"><div class="stat-val" id="r-total">0</div><div class="stat-lbl">Total Repairs</div></div>
    <div class="stat-card up"><div class="stat-val" id="r-rate">0%</div><div class="stat-lbl">Success Rate</div></div>
    <div class="stat-card err"><div class="stat-val" id="r-cost">$0</div><div class="stat-lbl">Repair Cost</div></div>
    <div class="stat-card brain"><div class="stat-val" id="r-avg">0</div><div class="stat-lbl">Avg Tokens/Repair</div></div>
  </div>
  <div class="card"><h3>Repair History</h3><div id="r-list"><div class="empty">No repairs yet — crashes will be logged here with resolution details</div></div></div>
</div>
<div class="panel" id="p-usage">
  <div class="stats" style="grid-template-columns:repeat(3,1fr)">
    <div class="stat-card heal"><div class="stat-val" id="u-total">0</div><div class="stat-lbl">Total Tokens</div></div>
    <div class="stat-card err"><div class="stat-val" id="u-cost">$0</div><div class="stat-lbl">Total Cost (USD)</div></div>
    <div class="stat-card up"><div class="stat-val" id="u-calls">0</div><div class="stat-lbl">API Calls</div></div>
    <div class="stat-card brain"><div class="stat-val" id="u-tpm">0</div><div class="stat-lbl">Tokens/min</div></div>
  </div>
  <div class="row2">
    <div class="card"><h3>By Category</h3><div id="u-cat"></div></div>
    <div class="card"><h3>By Model</h3><div id="u-model"></div></div>
  </div>
  <div class="card"><h3>By Tool</h3><div id="u-tool"></div></div>
  <div class="card"><h3>Usage Over Time</h3><div id="u-chart" style="height:200px;position:relative"></div></div>
</div>
</main>
<script>
const P=__PORT__,B='http://localhost:'+P;
const $=s=>document.getElementById(s);
const esc=s=>s?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):'';
let adminKey=null;

(function(){const m=document.cookie.match(/wolverine_admin_key=([^;]+)/);if(m){adminKey=decodeURIComponent(m[1]);verifyKey(adminKey);}})();

document.querySelectorAll('nav a[data-panel]').forEach(a=>{
  a.onclick=()=>{
    document.querySelectorAll('nav a').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
    a.classList.add('active');$('p-'+a.dataset.panel).classList.add('active');
  };
});

async function doAuth(){const key=$('auth-input').value.trim();if(!key){$('auth-err').textContent='Enter a key';return;}await verifyKey(key);}

async function verifyKey(key){
  try{
    const r=await fetch(B+'/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const d=await r.json();
    if(d.authorized){adminKey=key;$('cmd-auth').style.display='none';$('cmd-chat').style.display='flex';$('auth-badge').textContent='Admin';$('auth-badge').classList.add('ok');}
    else{$('auth-err').textContent=d.reason||'Invalid key';$('auth-badge').textContent='Locked';$('auth-badge').classList.remove('ok');}
  }catch(e){$('auth-err').textContent='Connection failed';}
}

async function sendCmd(){
  const input=$('cmd-input'),btn=$('cmd-btn'),cmd=input.value.trim();
  if(!cmd||!adminKey)return;
  addChat('user',cmd);input.value='';btn.disabled=true;btn.textContent='Running...';
  const statusEl=document.createElement('div');
  statusEl.className='chat-msg system';
  statusEl.id='cmd-status';
  statusEl.textContent='Starting...';
  $('chat-log').appendChild(statusEl);
  $('chat-log').scrollTop=$('chat-log').scrollHeight;
  try{
    const r=await fetch(B+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':adminKey},body:JSON.stringify({command:cmd})});
    const d=await r.json();
    const old=document.getElementById('cmd-status');if(old)old.remove();
    if(d.error){addChat('agent',d.error+(d.reason?' — '+d.reason:''));}
    else{
      const mode=d.mode||'agent';
      let msg=(d.summary||'Done.');
      if(d.filesModified&&d.filesModified.length>0)msg+='\\n\\nFiles: '+d.filesModified.join(', ');
      const ctx=d.historyLength?' | ctx:'+d.historyLength:'';
      const tools=d.toolsUsed&&d.toolsUsed.length?' | tools: '+d.toolsUsed.join(', '):'';
      msg+='\\n('+mode+', '+(d.turns||0)+' turn'+(d.turns!==1?'s':'')+', '+(d.tokens||0)+' tokens'+ctx+tools+')';
      addChat('agent',msg,d.filesModified,mode);
    }
  }catch(e){const log=$('chat-log');if(log.lastChild)log.removeChild(log.lastChild);addChat('agent','Error: '+e.message);}
  finally{btn.disabled=false;btn.textContent='Send';$('cmd-input').focus();}
}

async function clearChat(){
  try{await fetch(B+'/api/chat/clear',{method:'POST',headers:{'X-Admin-Key':adminKey}});}catch{}
  $('chat-log').innerHTML='<div class="chat-msg system">Conversation cleared. Memory reset.</div>';
}

function addChat(role,text,files,mode){
  const log=$('chat-log'),div=document.createElement('div');
  div.className='chat-msg '+role;
  let html='';
  if(mode)html+='<span class="mode-tag '+mode+'">'+mode+'</span><br>';
  html+=esc(text).replace(/\\n/g,'<br>');
  if(files&&files.length)html+='<div class="files">Modified: '+files.map(f=>'<span>'+esc(f)+'</span>').join(', ')+'</div>';
  div.innerHTML=html;log.appendChild(div);log.scrollTop=log.scrollHeight;
}

const es=new EventSource(B+'/api/events/stream');
es.onopen=()=>$('status').classList.add('on');
es.onerror=()=>$('status').classList.remove('on');
es.onmessage=e=>{
  const ev=JSON.parse(e.data);if(ev.type==='connected')return;
  addEvent(ev);
  // Update command status with live progress
  const st=document.getElementById('cmd-status');
  if(st){
    const icons={classify:'🏷️',chat:'💬','chat.tool':'🔌','chat.start':'🧠','chat.response':'✅',security:'🛡️',heal:'🔧',develop:'🔨','agent.turn':'🤖','agent.file_read':'📖','agent.file_write':'✏️','agent.command':'🎯','mcp.tool_call':'🔌',goal:'🎯'};
    const icon=icons[ev.type]||icons[ev.type.split('.')[0]]||'⏳';
    st.textContent=icon+' '+ev.message.slice(0,120);
    $('chat-log').scrollTop=$('chat-log').scrollHeight;
  }
};

function addEvent(ev){
  ['ov-events','ev-all'].forEach(id=>{const el=$(id);if(!el)return;const d=document.createElement('div');d.className='ev sev-'+ev.severity;
    d.innerHTML='<span class="t">'+new Date(ev.timestamp).toLocaleTimeString()+'</span><span class="tp">'+esc(ev.type)+'</span><span class="m">'+esc(ev.message)+'</span>';
    el.prepend(d);if(el.children.length>300)el.removeChild(el.lastChild);});
}

async function refresh(){
  try{
    const [sr,mr,br2,brn,usage,repairs,proc,routeData]=await Promise.all([fetch(B+'/api/stats').then(r=>r.json()),fetch(B+'/api/metrics').then(r=>r.json()),fetch(B+'/api/backups').then(r=>r.json()),fetch(B+'/api/brain').then(r=>r.json()),fetch(B+'/api/usage').then(r=>r.json()).catch(()=>({})),fetch(B+'/api/repairs').then(r=>r.json()).catch(()=>({repairs:[],stats:{}})),fetch(B+'/api/process').then(r=>r.json()).catch(()=>({})),fetch(B+'/api/routes').then(r=>r.json()).catch(()=>({routes:{},summary:{}}))]);
    if(sr.session){$('s-heals').textContent=sr.session.heals||0;$('s-errors').textContent=sr.session.errors||0;$('s-rollbacks').textContent=sr.session.rollbacks||0;$('h-events').textContent=sr.session.totalEvents||0;
      const s=Math.round((sr.session.uptime||0)/1000),m=Math.floor(s/60),h=Math.floor(m/60);
      const ut=h>0?h+'h '+m%60+'m':m>0?m+'m '+s%60+'s':s+'s';$('s-uptime').textContent=ut;$('h-uptime').textContent=ut;}
    $('s-memories').textContent=brn.totalEntries||0;
    if(brn.namespaces)$('br-ns').innerHTML=Object.entries(brn.namespaces).map(([k,v])=>'<div class="ns-card"><div class="n">'+v+'</div><div class="l">'+esc(k)+'</div></div>').join('');
    if(brn.functionMap){const fm=brn.functionMap;$('br-fmap').innerHTML=['Routes:'+fm.routes,'Functions:'+fm.functions,'Classes:'+fm.classes,'Files:'+fm.files].map(x=>'<div class="mrow"><span>'+x.split(':')[0]+'</span><span class="vals"><b>'+x.split(':')[1]+'</b></span></div>').join('');}
    const eps=Object.entries(mr);const mh=eps.length?eps.map(([p,m])=>'<div class="mrow"><span class="ep">'+esc(p)+'</span><span class="vals"><b>'+m.avgResponseMs+'ms</b> avg &middot; '+m.requestsPerMin+' req/min &middot; '+m.errorRate+'% err</span></div>').join(''):'<div class="empty">No traffic yet</div>';
    $('ov-metrics').innerHTML=mh;$('perf-list').innerHTML=mh;
    const bh=br2.length?br2.slice(-15).reverse().map(b=>'<div class="mrow"><span>'+new Date(b.timestamp).toLocaleString()+'</span><span><span class="badge badge-'+b.status+'">'+b.status+'</span> '+b.files.length+' file(s)</span></div>').join(''):'<div class="empty">No backups</div>';
    $('ov-backups').innerHTML=bh;$('bk-list').innerHTML=bh;
    // Usage analytics
    if(usage&&usage.session){
      $('u-total').textContent=(usage.session.totalTokens||0).toLocaleString();
      $('u-cost').textContent='$'+(usage.session.totalCostUsd||0).toFixed(4);
      $('u-calls').textContent=usage.session.totalCalls||0;
      $('u-tpm').textContent=usage.session.tokensPerMinute||0;
      const catColors={heal:'var(--red)',develop:'var(--blue)',chat:'var(--green)',security:'var(--yellow)',classify:'var(--text2)',research:'var(--purple)',brain:'var(--purple)',mcp:'var(--accent)'};
      const fmt$=n=>'$'+(n||0).toFixed(4);
      if(usage.byCategory){
        $('u-cat').innerHTML=Object.entries(usage.byCategory).sort((a,b)=>b[1].cost-a[1].cost).map(([k,v])=>'<div class="mrow"><span class="ep" style="color:'+(catColors[k]||'var(--text)')+'">'+k+'</span><span class="vals"><b>'+fmt$(v.cost)+'</b> &middot; '+v.total.toLocaleString()+' tokens (in:'+v.input.toLocaleString()+' out:'+v.output.toLocaleString()+') &middot; '+v.calls+' calls</span></div>').join('')||'<div class="empty">No usage yet</div>';
      }
      if(usage.byModel){
        $('u-model').innerHTML=Object.entries(usage.byModel).sort((a,b)=>b[1].cost-a[1].cost).map(([k,v])=>'<div class="mrow"><span class="ep">'+k+'</span><span class="vals"><b>'+fmt$(v.cost)+'</b> &middot; '+v.total.toLocaleString()+' tokens (in:'+v.input.toLocaleString()+' out:'+v.output.toLocaleString()+') &middot; '+v.calls+' calls</span></div>').join('')||'<div class="empty">No usage yet</div>';
      }
      if(usage.byTool){
        $('u-tool').innerHTML=Object.entries(usage.byTool).sort((a,b)=>b[1].total-a[1].total).map(([k,v])=>'<div class="mrow"><span class="ep">'+k+'</span><span class="vals"><b>'+v.total.toLocaleString()+'</b> tokens &middot; '+v.calls+' calls</span></div>').join('')||'<div class="empty">No tool usage yet</div>';
      }
      // Timeline chart
      if(usage.timeline&&usage.timeline.length>1){
        const tl=usage.timeline;
        const max=Math.max(...tl.map(e=>e.tokens))||1;
        const w=$('u-chart').offsetWidth||600;
        const h=180;
        const barW=Math.max(4,Math.floor(w/tl.length)-2);
        const catC={heal:'#f85149',develop:'#58a6ff',chat:'#3fb950',security:'#d29922',classify:'#6b7a8d',research:'#bc8cff',brain:'#bc8cff'};
        let svg='<svg width="'+w+'" height="'+h+'" style="display:block">';
        tl.forEach((e,i)=>{
          const bh=Math.max(2,Math.round((e.tokens/max)*h*0.85));
          const x=i*(barW+2);
          const color=catC[e.cat]||'#58a6ff';
          svg+='<rect x="'+x+'" y="'+(h-bh)+'" width="'+barW+'" height="'+bh+'" fill="'+color+'" rx="2"><title>'+e.tokens+' tokens ('+e.cat+', '+e.model+')</title></rect>';
        });
        svg+='</svg>';
        $('u-chart').innerHTML=svg;
      }else{
        $('u-chart').innerHTML='<div class="empty">Chart appears after multiple API calls</div>';
      }
    }
    // Repair history
    if(repairs&&repairs.stats){
      const rs=repairs.stats;
      $('r-total').textContent=rs.total||0;
      $('r-rate').textContent=(rs.successRate||0)+'%';
      $('r-cost').textContent='$'+(rs.totalCost||0).toFixed(4);
      $('r-avg').textContent=(rs.avgTokensPerRepair||0).toLocaleString();
    }
    if(repairs&&repairs.repairs&&repairs.repairs.length>0){
      $('r-list').innerHTML=repairs.repairs.slice(-20).reverse().map(r=>{
        const icon=r.success?'✅':'❌';
        const date=new Date(r.timestamp).toLocaleString();
        const cost='$'+(r.cost||0).toFixed(4);
        return '<div class="mrow" style="flex-wrap:wrap"><div style="flex:1"><span style="margin-right:6px">'+icon+'</span><span class="ep">'+esc(r.error).slice(0,60)+'</span></div><span class="vals">'+r.mode+' &middot; '+r.tokens.toLocaleString()+' tokens &middot; '+cost+' &middot; iter '+r.iteration+' &middot; '+(r.duration/1000).toFixed(1)+'s</span><div style="width:100%;font-size:.75rem;color:var(--text2);margin-top:4px">'+date+' — '+esc(r.resolution).slice(0,100)+'</div></div>';
      }).join('');
    }
    // Processes panel
    if(proc){
      $('proc-pid').textContent=proc.pid||'-';
      if(proc.current){
        $('proc-mem').textContent=proc.current.rss+'MB';
        $('proc-cpu').textContent=proc.current.cpu+'%';
      }
      // Uptime from server stats
      if(sr.session){
        const u=Math.round((sr.session.uptime||0)/1000);
        const h=Math.floor(u/3600),m=Math.floor((u%3600)/60),s=u%60;
        $('proc-up').textContent=(h>0?h+'h ':'')+(m>0?m+'m ':'')+s+'s';
      }
      // Leak detection
      if(proc.leakDetection){
        const ld=proc.leakDetection;
        $('proc-health').innerHTML='<div class="mrow"><span>Leak Detection</span><span class="vals">'+(ld.warning?'<span style="color:var(--yellow)">⚠️ Growing</span>':'<span style="color:var(--green)">✅ Stable</span>')+' ('+ld.consecutiveGrowth+'/'+ld.threshold+' samples)</span></div>'
          +'<div class="mrow"><span>Peak Memory</span><span class="vals"><b>'+(proc.peak?.memory||0)+'MB</b></span></div>'
          +'<div class="mrow"><span>Avg Memory</span><span class="vals"><b>'+(proc.average?.memory||0)+'MB</b></span></div>'
          +'<div class="mrow"><span>Avg CPU</span><span class="vals"><b>'+(proc.average?.cpu||0)+'%</b></span></div>'
          +'<div class="mrow"><span>Process Alive</span><span class="vals">'+(proc.alive?'<span style="color:var(--green)">✅ Yes</span>':'<span style="color:var(--red)">❌ No</span>')+'</span></div>';
      }
      // Memory timeline chart
      if(proc.samples&&proc.samples.length>1){
        const s=proc.samples,max=Math.max(...s.map(e=>e.rss))||1,w=$('proc-mem-chart').offsetWidth||500,h=150;
        const bw=Math.max(3,Math.floor(w/s.length)-1);
        let svg='<svg width="'+w+'" height="'+h+'">';
        s.forEach((e,i)=>{
          const bh=Math.max(2,Math.round((e.rss/max)*h*0.85));
          const c=e.rss>400?'var(--red)':e.rss>200?'var(--yellow)':'var(--blue)';
          svg+='<rect x="'+(i*(bw+1))+'" y="'+(h-bh)+'" width="'+bw+'" height="'+bh+'" fill="'+c+'" rx="1"><title>'+e.rss+'MB</title></rect>';
        });
        svg+='</svg>';
        $('proc-mem-chart').innerHTML=svg;
      }
    }
    // System info
    const sysInfo=await fetch(B+'/api/system').then(r=>r.json()).catch(()=>({}));
    if(sysInfo&&sysInfo.cpu){
      $('proc-sys').innerHTML=[
        '<div class="mrow"><span>Platform</span><span class="vals">'+esc(sysInfo.platform)+'/'+esc(sysInfo.arch)+'</span></div>',
        '<div class="mrow"><span>CPU</span><span class="vals">'+esc((sysInfo.cpu.model||'').slice(0,40))+' ('+sysInfo.cpu.cores+' cores)</span></div>',
        '<div class="mrow"><span>RAM</span><span class="vals">'+sysInfo.memory.totalGB+'GB total, '+sysInfo.memory.freeGB+'GB free ('+sysInfo.memory.usedPercent+'%)</span></div>',
        '<div class="mrow"><span>Disk</span><span class="vals">'+sysInfo.disk.totalGB+'GB total, '+sysInfo.disk.freeGB+'GB free ('+sysInfo.disk.usedPercent+'%)</span></div>',
        '<div class="mrow"><span>Node</span><span class="vals">'+esc(sysInfo.nodeVersion)+'</span></div>',
        '<div class="mrow"><span>Hostname</span><span class="vals">'+esc(sysInfo.hostname)+'</span></div>',
        '<div class="mrow"><span>Environment</span><span class="vals">'+esc(sysInfo.environment?.type||'unknown')+(sysInfo.environment?.cloud?' ('+sysInfo.environment.cloud+')':'')+'</span></div>',
      ].join('');
      // Listening ports
      $('proc-listen').innerHTML='<div class="mrow"><span>Server</span><span class="vals">:'+(sysInfo.hostname?'running':'?')+'</span></div>'
        +'<div class="mrow"><span>Dashboard</span><span class="vals">:'+P+'</span></div>'
        +'<div class="mrow"><span>Workers Recommended</span><span class="vals">'+sysInfo.recommended?.workers+'</span></div>';
    }
    // Analytics: process + routes
    if(proc&&proc.current){
      $('a-mem').textContent=proc.current.rss+'MB';
      $('a-cpu').textContent=proc.current.cpu+'%';
    }
    if(routeData&&routeData.summary){
      const rs=routeData.summary;
      $('a-routes').textContent=rs.totalRoutes||0;
      $('a-health').textContent=(rs.healthy||0)+'/'+(rs.totalRoutes||0);
    }
    // Memory chart
    if(proc&&proc.samples&&proc.samples.length>1){
      const s=proc.samples,max=Math.max(...s.map(e=>e.rss))||1,w=$('a-mem-chart').offsetWidth||500,h=140;
      const bw=Math.max(3,Math.floor(w/s.length)-1);
      let svg='<svg width="'+w+'" height="'+h+'">';
      s.forEach((e,i)=>{const bh=Math.max(2,Math.round((e.rss/max)*h*0.85));svg+='<rect x="'+(i*(bw+1))+'" y="'+(h-bh)+'" width="'+bw+'" height="'+bh+'" fill="var(--blue)" rx="1"><title>'+e.rss+'MB</title></rect>';});
      svg+='</svg>';$('a-mem-chart').innerHTML=svg;
    }
    // CPU chart
    if(proc&&proc.samples&&proc.samples.length>1){
      const s=proc.samples,max=Math.max(...s.map(e=>e.cpu),1),w=$('a-cpu-chart').offsetWidth||500,h=140;
      const bw=Math.max(3,Math.floor(w/s.length)-1);
      let svg='<svg width="'+w+'" height="'+h+'">';
      s.forEach((e,i)=>{const bh=Math.max(2,Math.round((e.cpu/max)*h*0.85));const c=e.cpu>80?'var(--red)':e.cpu>50?'var(--yellow)':'var(--green)';svg+='<rect x="'+(i*(bw+1))+'" y="'+(h-bh)+'" width="'+bw+'" height="'+bh+'" fill="'+c+'" rx="1"><title>'+e.cpu+'%</title></rect>';});
      svg+='</svg>';$('a-cpu-chart').innerHTML=svg;
    }
    // Route list
    if(routeData&&routeData.routes){
      const routes=Object.entries(routeData.routes);
      if(routes.length>0){
        const trendIcon={stable:'→',degrading:'↗',improving:'↘'};
        $('a-route-list').innerHTML=routes.sort((a,b)=>b[1].avgMs-a[1].avgMs).map(([p,m])=>{
          const icon=m.healthy?'🟢':'🔴';
          const trend=trendIcon[m.trend]||'→';
          return '<div class="mrow"><span>'+icon+' <span class="ep">'+esc(p)+'</span></span><span class="vals"><b>'+m.avgMs+'ms</b> avg ('+m.minMs+'-'+m.maxMs+') '+trend+' &middot; '+m.errors+' errs &middot; '+m.samples+' probes</span></div>';
        }).join('');
      }
    }
  }catch(e){}
}

const tools=[{n:'read_file',d:'Read file with offset/limit',c:'file'},{n:'write_file',d:'Write complete file',c:'file'},{n:'edit_file',d:'Find-and-replace edit',c:'file'},{n:'glob_files',d:'Pattern file discovery',c:'file'},{n:'grep_code',d:'Regex search with context',c:'file'},{n:'bash_exec',d:'Sandboxed shell',c:'shell'},{n:'git_log',d:'Recent commits',c:'shell'},{n:'git_diff',d:'Uncommitted changes',c:'shell'},{n:'web_fetch',d:'Fetch URL',c:'web'},{n:'done',d:'Signal completion',c:'ctrl'}];
const cc={file:'var(--blue)',shell:'var(--yellow)',web:'var(--purple)',ctrl:'var(--green)'};
$('tool-list').innerHTML=tools.map(t=>'<div class="mrow"><span class="ep" style="color:'+cc[t.c]+'">'+t.n+'</span><span class="vals">'+esc(t.d)+'</span></div>').join('');

refresh();setInterval(refresh,5000);
fetch(B+'/api/events').then(r=>r.json()).then(evs=>evs.forEach(addEvent)).catch(()=>{});
</script></body></html>`;

module.exports = { DashboardServer };
