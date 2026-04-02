const chalk = require("chalk");
const { aiCall } = require("../core/ai-client");
const { getModel } = require("../core/models");
const { redact } = require("../security/secret-redactor");

/**
 * Research Agent — deep research + learning from experience.
 *
 * Uses RESEARCH_MODEL for deep analysis of errors and solutions.
 * Stores everything in the brain so wolverine gets smarter over time.
 *
 * Loop prevention:
 * - Before fixing, checks brain for past attempts on the same error
 * - If past fix failed, provides that context so agent tries something different
 * - Stores both successes AND failures
 */

class ResearchAgent {
  constructor(options = {}) {
    this.brain = options.brain;
    this.logger = options.logger;
  }

  /**
   * Check if we've seen this error before. Returns past attempts.
   */
  async checkHistory(errorMessage) {
    if (!this.brain || !this.brain._initialized) return null;

    const fixes = await this.brain.recall(errorMessage, { topK: 3, namespace: "fixes" });
    const errors = await this.brain.recall(errorMessage, { topK: 3, namespace: "errors" });
    const learnings = await this.brain.recall(errorMessage, { topK: 2, namespace: "learnings" });

    const total = fixes.length + errors.length + learnings.length;
    if (total === 0) return null;

    console.log(chalk.gray(`  🔍 Research: ${fixes.length} past fixes, ${errors.length} past errors, ${learnings.length} learnings`));

    return {
      hasPastAttempts: true,
      fixes: fixes.map(r => r.text),
      errors: errors.map(r => r.text),
      learnings: learnings.map(r => r.text),
    };
  }

  /**
   * Record a fix attempt (success or failure).
   */
  async recordAttempt({ errorMessage, filePath, fix, success, explanation }) {
    if (!this.brain || !this.brain._initialized) return;

    const safeError = redact(errorMessage);
    const safeExplanation = redact(explanation || fix || "");

    const namespace = success ? "fixes" : "errors";
    const prefix = success ? "FIXED" : "FAILED";
    const text = `${prefix}: ${safeError} in ${filePath}. ${success ? "Solution" : "Attempted"}: ${safeExplanation}`;

    await this.brain.remember(namespace, text, { type: success ? "fix-success" : "fix-failure", file: filePath });
    console.log(chalk.gray(`  🧠 ${success ? "✅" : "❌"} Recorded ${prefix.toLowerCase()} for ${safeError.slice(0, 50)}`));
  }

  /**
   * Deep research using RESEARCH_MODEL. Called when normal fixes fail.
   * Stores findings in brain for future reference.
   */
  async research(errorMessage, context) {
    const safeError = redact(errorMessage);

    console.log(chalk.magenta(`  🔬 Deep research (${getModel("research")})...`));

    try {
      const result = await aiCall({
        model: getModel("research"),
        systemPrompt: "You are a Node.js debugging researcher. Given an error and context of failed fix attempts, research the root cause deeply and provide a specific, actionable solution. Include exact code changes. If the previous fix attempts failed, explain WHY they failed and what to do differently.",
        userPrompt: `Error: ${safeError}\n\n${context || "No previous attempts."}`,
        maxTokens: 1024,
        category: "research",
      });

      const findings = result.content || "";

      // Store research in brain
      if (this.brain && this.brain._initialized && findings.length > 20) {
        await this.brain.remember("learnings", `Research for "${safeError.slice(0, 60)}": ${findings.slice(0, 500)}`, { type: "deep-research" });
        this.brain.store.save();
      }

      const tokens = (result.usage?.prompt_tokens || result.usage?.input_tokens || 0)
        + (result.usage?.completion_tokens || result.usage?.output_tokens || 0);
      console.log(chalk.magenta(`  🔬 Research complete (${tokens} tokens)`));

      return findings;
    } catch (err) {
      console.log(chalk.yellow(`  Research failed: ${err.message}`));
      return null;
    }
  }

  /**
   * Build full context for the agent — past attempts + research.
   */
  async buildFixContext(errorMessage) {
    const parts = [];

    const history = await this.checkHistory(errorMessage);
    if (history && history.hasPastAttempts) {
      parts.push("## Past Attempts (from brain)");
      if (history.fixes.length > 0) parts.push("Successful fixes for similar errors:\n" + history.fixes.join("\n"));
      if (history.errors.length > 0) parts.push("Failed attempts (DO NOT repeat these):\n" + history.errors.join("\n"));
      if (history.learnings.length > 0) parts.push("Research findings:\n" + history.learnings.join("\n"));
      parts.push("\nIMPORTANT: Use a DIFFERENT approach from any failed attempts listed above.");
    }

    return parts.join("\n");
  }
}

module.exports = { ResearchAgent };
