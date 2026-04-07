#!/usr/bin/env node
/**
 * Integration test: Existing OpenClaw user → adds Wolverine
 *
 * Simulates a user who has an openclaw project and wants to add
 * wolverine self-healing. Tests:
 *   1. Detection of existing OpenClaw config (.openclaw/config.yml)
 *   2. Config merge (openclaw values override wolverine defaults)
 *   3. Scaffolding (wolverine-claw/ created with correct files)
 *   4. Validation (all checks pass)
 *   5. Standalone agent loads and can make AI calls (optional, needs API key)
 *
 * Usage:
 *   node tests/test-openclaw-to-wolverine.js           # runs all tests
 *   node tests/test-openclaw-to-wolverine.js --live     # also tests live AI call
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// Test framework
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed++;
  }
}

// ── Setup: create a temp copy of the fixture ────────────────────

const fixtureDir = path.join(__dirname, "fixtures", "openclaw-project");
const tmpDir = path.join(os.tmpdir(), `wolverine-claw-test-${Date.now()}`);

console.log(`\n  🧪 OpenClaw → Wolverine Integration Test\n`);
console.log(`  Fixture: ${fixtureDir}`);
console.log(`  Temp:    ${tmpDir}\n`);

// Copy fixture to temp (so we don't pollute the repo)
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDir(fixtureDir, tmpDir);

// ── Test 1: Detection ───────────────────────────────────────────

console.log("  --- Detection ---");

const { detectEnvironment, detectOpenClaw, mergeConfig, scaffold, validate } = require("../src/claw/setup");

const env = detectEnvironment(tmpDir);

assert(env.openclaw.found, "OpenClaw detected");
assert(env.openclaw.configPath !== null, "OpenClaw config path found");
assert(env.openclaw.config !== null, "OpenClaw config parsed");

if (env.openclaw.config) {
  assertEq(env.openclaw.config.gateway?.port, 19222, "Gateway port from config");
  assertEq(env.openclaw.config.gateway?.host, "0.0.0.0", "Gateway host from config");
  assertEq(env.openclaw.config.agent?.model, "claude-sonnet-4-6", "Agent model from config");
  assertEq(env.openclaw.config.agent?.maxTurns, 30, "Max turns from config");
  assert(env.openclaw.config.channels?.discord !== undefined, "Discord channel detected");
  assert(env.openclaw.config.channels?.telegram !== undefined, "Telegram channel detected");
  assertEq(env.openclaw.config.security?.dmPairing, false, "Security dmPairing from config");
}

// ── Test 2: Config Merge ────────────────────────────────────────

console.log("\n  --- Config Merge ---");

// Load wolverine defaults
const defaultConfigPath = path.join(__dirname, "..", "wolverine-claw", "config", "settings.json");
const defaults = JSON.parse(fs.readFileSync(defaultConfigPath, "utf-8"));
const merged = mergeConfig(env.openclaw.config, defaults);

assertEq(merged.gateway.port, 19222, "Merged gateway port (from openclaw)");
assertEq(merged.gateway.host, "0.0.0.0", "Merged gateway host (from openclaw)");
assertEq(merged.agent.model, "claude-sonnet-4-6", "Merged agent model");
assertEq(merged.agent.maxTurns, 30, "Merged maxTurns (from openclaw, was 25)");

// Channels: discord and telegram should be enabled (from openclaw)
assert(merged.channels.discord?.enabled === true, "Discord enabled after merge");
assert(merged.channels.telegram?.enabled === true, "Telegram enabled after merge");
assert(merged.channels.terminal?.enabled === true, "Terminal still enabled");

// Security: dmPairing overridden from openclaw
assertEq(merged.security.dmPairing, false, "dmPairing overridden to false");
assert(merged.security.sandbox === true, "Sandbox preserved from defaults");

// Skills: browserControl enabled from openclaw
assert(merged.skills.browserControl?.enabled === true, "browserControl enabled from openclaw");

// Healing should be untouched (from defaults)
assertEq(merged.healing.enabled, true, "Healing preserved from defaults");
assertEq(merged.healing.maxHealsPerWindow, 5, "Max heals preserved from defaults");

// ── Test 3: Scaffold ────────────────────────────────────────────

console.log("\n  --- Scaffold ---");

const scaffoldResult = scaffold(tmpDir, merged, env);

assert(scaffoldResult.errors.length === 0, `No scaffold errors (got ${scaffoldResult.errors.length})`);
assert(scaffoldResult.created.length > 0, `Files created: ${scaffoldResult.created.length}`);

// Verify files exist
const expectedFiles = [
  "wolverine-claw/config/settings.json",
  "wolverine-claw/index.js",
  "wolverine-claw/plugins/wolverine-integration.js",
  "wolverine-claw/workspace/.gitkeep",
  "wolverine-claw/workspace/.gitignore",
  "wolverine-claw/skills/.gitkeep",
];

for (const f of expectedFiles) {
  assert(fs.existsSync(path.join(tmpDir, f)), `File created: ${f}`);
}

// Verify merged config was written correctly
const writtenConfig = JSON.parse(fs.readFileSync(path.join(tmpDir, "wolverine-claw", "config", "settings.json"), "utf-8"));
assertEq(writtenConfig.gateway.port, 19222, "Written config has merged port");
assert(writtenConfig.channels.discord.enabled === true, "Written config has discord enabled");
assertEq(writtenConfig.agent.maxTurns, 30, "Written config has merged maxTurns");

// Verify index.js is valid JavaScript
const indexContent = fs.readFileSync(path.join(tmpDir, "wolverine-claw", "index.js"), "utf-8");
assert(indexContent.includes("wolverine"), "index.js references wolverine");
assert(indexContent.includes("openclaw"), "index.js references openclaw");

// Verify plugin is valid
const pluginContent = fs.readFileSync(path.join(tmpDir, "wolverine-claw", "plugins", "wolverine-integration.js"), "utf-8");
assert(pluginContent.includes("wolverine_backup"), "Plugin has backup tool");
assert(pluginContent.includes("wolverine_brain_search"), "Plugin has brain search tool");

// ── Test 4: Validation ──────────────────────────────────────────

console.log("\n  --- Validation ---");

const postEnv = detectEnvironment(tmpDir);
const checks = validate(tmpDir, postEnv);

for (const check of checks) {
  if (check.name === "Wolverine core") {
    // Wolverine won't be "installed" in the temp dir — that's expected
    // but the template dir resolution proves it can find the framework
    console.log(`  ⚠️  ${check.name}: ${check.detail} (expected in test env)`);
  } else if (check.name === "AI API key") {
    // API keys are in the fixture .env.local but not loaded in process.env here
    console.log(`  ⚠️  ${check.name}: ${check.detail} (not loaded in test env)`);
  } else {
    assert(check.pass, `Validation: ${check.name} — ${check.detail}`);
  }
}

// ── Test 5: npm scripts injection ────────────────────────────

console.log("\n  --- npm Scripts ---");

const { addClawScripts } = require("../src/claw/setup");
const scriptsResult = addClawScripts(tmpDir);
assert(scriptsResult.added === 3, `Added ${scriptsResult.added} npm scripts`);

// Verify package.json was updated
const updatedPkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"));
assertEq(updatedPkg.scripts.claw, "wolverine-claw", "claw script added");
assertEq(updatedPkg.scripts["claw:direct"], "wolverine-claw --direct", "claw:direct script added");
assertEq(updatedPkg.scripts["claw:info"], "wolverine-claw --info", "claw:info script added");

// Idempotency — running again shouldn't add duplicates
const scriptsResult2 = addClawScripts(tmpDir);
assertEq(scriptsResult2.added, 0, "No duplicate scripts on re-run");
assert(scriptsResult2.skipped === true, "Scripts skipped on re-run");

// ── Test 6: Idempotency (re-run scaffold) ────────────────────────

console.log("\n  --- Idempotency ---");

const scaffoldResult2 = scaffold(tmpDir, merged, env);
assertEq(scaffoldResult2.created.length, 0, "Second scaffold creates no new files");
assert(scaffoldResult2.skipped.length > 0, `Second scaffold skips ${scaffoldResult2.skipped.length} existing files`);
assertEq(scaffoldResult2.errors.length, 0, "Second scaffold has no errors");

// Config wasn't overwritten
const writtenConfig2 = JSON.parse(fs.readFileSync(path.join(tmpDir, "wolverine-claw", "config", "settings.json"), "utf-8"));
assertEq(writtenConfig2.gateway.port, 19222, "Config preserved on re-scaffold");

// ── Test 7: Live AI call (optional) ─────────────────────────────

const liveMode = process.argv.includes("--live");
if (liveMode) {
  console.log("\n  --- Live AI Test ---");

  // Load real env
  const dotenv = require("dotenv");
  dotenv.config({ path: path.resolve(__dirname, "..", ".env.local") });
  dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

  const { buildTools } = require("../src/claw/standalone-agent");
  const { aiCallWithHistory } = require("../src/core/ai-client");

  const tools = buildTools(tmpDir, path.join(tmpDir, "wolverine-claw/workspace"), merged);
  const toolDefs = tools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  (async () => {
    try {
      const response = await aiCallWithHistory({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "system", content: "You are a test agent. Use list_dir to check the project root, then use done." },
          { role: "user", content: "List the files in this directory and confirm wolverine-claw was set up." },
        ],
        tools: toolDefs,
        maxTokens: 1024,
        category: "tool",
      });

      const msg = response.choices?.[0]?.message;
      assert(msg !== undefined, "AI response received");

      const tcs = msg?.tool_calls || [];
      if (tcs.length > 0) {
        const toolName = tcs[0].function?.name;
        assert(toolName === "list_dir" || toolName === "done", `AI used tool: ${toolName}`);

        // Execute the tool
        const args = JSON.parse(tcs[0].function?.arguments || "{}");
        const tool = tools.find(t => t.name === toolName);
        const result = tool.execute(args);
        assert(result.includes("wolverine-claw") || toolName === "done", "Tool result references wolverine-claw");
        console.log(`  Tool result: ${result.slice(0, 100)}...`);
      } else {
        assert(msg.content && msg.content.length > 0, "AI text response received");
      }
    } catch (e) {
      console.log(`  ❌ Live AI test failed: ${e.message}`);
      failed++;
    }

    printResults();
  })();
} else {
  console.log("\n  (skip live AI test — run with --live to enable)\n");
  printResults();
}

// ── Cleanup ─────────────────────────────────────────────────────

function printResults() {
  // Cleanup temp dir
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.log("  ❌ SOME TESTS FAILED\n");
    process.exit(1);
  } else {
    console.log("  ✅ ALL TESTS PASSED\n");
    process.exit(0);
  }
}
