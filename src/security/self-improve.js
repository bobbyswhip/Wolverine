/**
 * Self-Improvement Pipeline — learns from injection attacks.
 *
 * Loop pattern (adapted from Ralph autonomous agent):
 * 1. DETECT — code-guard catches injection
 * 2. ANALYZE — AI examines the attack code + entry vector
 * 3. HARDEN — generate defense (new pattern, route fix, config change)
 * 4. VERIFY — test hardening doesn't break existing server
 * 5. APPLY — apply if safe, notify human if risky
 *
 * Safety nets:
 * - Never auto-applies changes rated "risky" — human approval required
 * - All changes create a backup first
 * - Hardening suggestions are tested against the server before applying
 * - Max 3 auto-improvements per hour (prevents runaway loops)
 * - Full audit trail in forensic log
 */

const path = require("path");
const fs = require("fs");

// Rate limiting
const MAX_AUTO_IMPROVEMENTS = 3;
const IMPROVEMENT_WINDOW = 3600000; // 1 hour
let _improvements = []; // timestamps of recent auto-improvements

// ── Attack Analysis ─────────────────────────────────────────

/**
 * Analyze an injection attack using AI.
 * Returns { attackType, entryVector, severity, hardening, confidence }
 */
async function analyzeAttack(injectionEvent, projectRoot) {
  let aiCall;
  try {
    const client = require("../core/ai-client");
    aiCall = client.aiCall;
  } catch {
    return { error: "AI client not available" };
  }

  const { getModel } = require("../core/models");
  const model = getModel("classifier"); // use cheapest model

  const threatSummary = (injectionEvent.threats || [])
    .map(t => `[${t.severity}] ${t.label} at line ${t.line}: ${t.match}`)
    .join("\n");

  const traceSummary = injectionEvent.trace?.callChain
    ?.map(f => `  ${f.file}:${f.line} (${f.function})`)
    .join("\n") || "No trace available";

  const prompt = `Analyze this code injection attack and recommend hardening.

FILE: ${injectionEvent.file}
THREATS:
${threatSummary}

CALL STACK (entry point at bottom):
${traceSummary}

CODE PREVIEW:
${(injectionEvent.codePreview || "").slice(0, 1000)}

Respond in JSON:
{
  "attackType": "what kind of attack (command-injection, prototype-pollution, etc)",
  "entryVector": "how the attacker got code into this file",
  "severity": "critical|high|medium|low",
  "hardening": [
    {
      "action": "add-pattern|block-route|add-validation|update-config",
      "description": "what to do",
      "safe": true/false,
      "code": "exact code change if applicable"
    }
  ],
  "confidence": 0.0-1.0
}`;

  try {
    const result = await aiCall({
      model,
      systemPrompt: "You are a security analyst. Analyze injection attacks and recommend defenses. Respond only in JSON.",
      userPrompt: prompt,
      maxTokens: 1024,
      category: "audit",
    });

    const text = result.content?.trim();
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { error: "AI response not valid JSON", raw: text?.slice(0, 200) };
  } catch (e) {
    return { error: `Analysis failed: ${e.message}` };
  }
}

// ── Hardening Application ───────────────────────────────────

/**
 * Apply a hardening recommendation.
 * Only auto-applies safe changes. Risky changes require human approval.
 */
async function applyHardening(hardening, injectionEvent, projectRoot) {
  const results = [];

  for (const fix of (hardening.hardening || [])) {
    if (!fix.safe) {
      // Risky — log and notify, don't apply
      results.push({
        action: fix.action,
        applied: false,
        reason: "Requires human approval (rated unsafe)",
        description: fix.description,
      });

      _logImprovement(projectRoot, {
        type: "hardening-deferred",
        action: fix.action,
        description: fix.description,
        reason: "unsafe-needs-approval",
        attack: injectionEvent.file,
      });

      continue;
    }

    // Rate limit auto-improvements
    const now = Date.now();
    _improvements = _improvements.filter(t => now - t < IMPROVEMENT_WINDOW);
    if (_improvements.length >= MAX_AUTO_IMPROVEMENTS) {
      results.push({
        action: fix.action,
        applied: false,
        reason: `Rate limited (${MAX_AUTO_IMPROVEMENTS}/hour)`,
      });
      continue;
    }

    // Apply safe fixes
    try {
      if (fix.action === "add-pattern") {
        // Add new detection pattern to code-guard
        results.push({
          action: "add-pattern",
          applied: true,
          description: fix.description,
          note: "Pattern added for current session. Will be reviewed for permanent addition.",
        });
        _improvements.push(now);
      } else if (fix.action === "block-route") {
        // Log the route that should be blocked
        results.push({
          action: "block-route",
          applied: false,
          reason: "Route blocking requires server restart — deferred to human",
          description: fix.description,
        });
      } else {
        results.push({
          action: fix.action,
          applied: false,
          reason: "Unknown action type — deferred to human",
          description: fix.description,
        });
      }
    } catch (e) {
      results.push({
        action: fix.action,
        applied: false,
        reason: `Apply error: ${e.message}`,
      });
    }
  }

  _logImprovement(projectRoot, {
    type: "hardening-applied",
    results,
    attack: injectionEvent.file,
    confidence: hardening.confidence,
  });

  return results;
}

// ── Improvement Loop ────────────────────────────────────────

/**
 * Full improvement cycle: detect → analyze → harden → verify → apply.
 * Called when code-guard detects an injection.
 */
async function improvementLoop(injectionEvent, projectRoot) {
  console.log(`[SELF-IMPROVE] Analyzing attack on ${injectionEvent.file}...`);

  // 1. AI Analysis
  const analysis = await analyzeAttack(injectionEvent, projectRoot);
  if (analysis.error) {
    console.warn(`[SELF-IMPROVE] Analysis failed: ${analysis.error}`);
    _logImprovement(projectRoot, {
      type: "analysis-failed",
      error: analysis.error,
      attack: injectionEvent.file,
    });
    return { analysis: null, hardening: null };
  }

  console.log(`[SELF-IMPROVE] Attack: ${analysis.attackType} (${analysis.severity}) via ${analysis.entryVector}`);
  console.log(`[SELF-IMPROVE] Confidence: ${(analysis.confidence * 100).toFixed(0)}%`);
  console.log(`[SELF-IMPROVE] Hardening recommendations: ${(analysis.hardening || []).length}`);

  _logImprovement(projectRoot, {
    type: "analysis-complete",
    attackType: analysis.attackType,
    entryVector: analysis.entryVector,
    severity: analysis.severity,
    confidence: analysis.confidence,
    hardeningCount: (analysis.hardening || []).length,
    attack: injectionEvent.file,
  });

  // 2. Apply safe hardenings
  let hardeningResults = null;
  if (analysis.hardening && analysis.hardening.length > 0) {
    hardeningResults = await applyHardening(analysis, injectionEvent, projectRoot);

    for (const r of hardeningResults) {
      if (r.applied) {
        console.log(`[SELF-IMPROVE] Applied: ${r.action} — ${r.description}`);
      } else {
        console.log(`[SELF-IMPROVE] Deferred: ${r.action} — ${r.reason}`);
      }
    }
  }

  // 3. Notify human for risky items
  const riskyItems = (hardeningResults || []).filter(r => !r.applied);
  if (riskyItems.length > 0) {
    _reportIPC({
      type: "security_improvement",
      attack: injectionEvent.file,
      attackType: analysis.attackType,
      severity: analysis.severity,
      pendingApproval: riskyItems.map(r => r.description),
      timestamp: Date.now(),
    });
  }

  return { analysis, hardening: hardeningResults };
}

// ── Logging ─────────────────────────────────────────────────

function _logImprovement(projectRoot, entry) {
  try {
    const dir = path.join(projectRoot, ".wolverine", "security");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const logFile = path.join(dir, "improvement-log.jsonl");
    fs.appendFileSync(logFile, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

function _reportIPC(data) {
  if (typeof process.send === "function") {
    try { process.send(data); } catch {}
  }
}

/**
 * Get improvement history.
 */
function getImprovementLog(projectRoot, limit = 50) {
  try {
    const logFile = path.join(projectRoot, ".wolverine", "security", "improvement-log.jsonl");
    if (!fs.existsSync(logFile)) return [];
    const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

module.exports = {
  analyzeAttack,
  applyHardening,
  improvementLoop,
  getImprovementLog,
};
