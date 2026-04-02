const chalk = require("chalk");
const { verifyFix } = require("../core/verifier");

/**
 * Goal Loop — claw-code run_turn_loop pattern.
 *
 * Instead of: try fast → try agent → give up
 * Now:        set goal → attempt → verify → learn → retry with new context
 *
 * The loop:
 *   1. Set goal (e.g. "server starts without error X")
 *   2. Check brain for past attempts on this goal
 *   3. Attempt a fix (strategy chosen by iteration)
 *   4. Verify: did we meet the goal?
 *   5. Yes → record success, exit
 *   6. No  → record failure, research if needed, loop with new context
 *
 * Each iteration gets smarter because failures feed into the next attempt's context.
 */

class GoalLoop {
  constructor(options = {}) {
    this.maxIterations = options.maxIterations || 3;
    this.researcher = options.researcher;
    this.logger = options.logger;
    this.onAttempt = options.onAttempt; // async (iteration, context) => { healed, explanation }
    this.onVerify = options.onVerify;   // async () => { verified, status }
    this.goal = options.goal || "Fix the error";

    this._attempts = [];
  }

  /**
   * Run the goal loop. Returns the final result.
   */
  async run({ errorMessage, filePath, cwd }) {
    console.log(chalk.magenta(`\n  🎯 Goal: ${this.goal}`));
    console.log(chalk.gray(`     Max iterations: ${this.maxIterations}\n`));

    if (this.logger) {
      this.logger.info("goal.start", `Goal: ${this.goal}`, { maxIterations: this.maxIterations, error: errorMessage?.slice(0, 100) });
    }

    for (let i = 0; i < this.maxIterations; i++) {
      const iteration = i + 1;
      console.log(chalk.blue(`  ── Iteration ${iteration}/${this.maxIterations} ──`));

      // Build context from past attempts
      let context = "";
      if (this.researcher) {
        context = await this.researcher.buildFixContext(errorMessage);
      }
      if (this._attempts.length > 0) {
        context += "\n\n## This Session's Attempts";
        for (const a of this._attempts) {
          context += `\nAttempt ${a.iteration}: ${a.success ? "SUCCESS" : "FAILED"} — ${a.explanation}`;
        }
      }

      // Attempt the fix — pass prior attempts so the handler can include concise summary
      let attempt;
      try {
        attempt = await this.onAttempt(iteration, context, this._attempts);
      } catch (err) {
        attempt = { healed: false, explanation: `Error: ${err.message}` };
      }

      this._attempts.push({
        iteration,
        mode: attempt.mode || "unknown",
        success: attempt.healed,
        explanation: attempt.explanation || "No explanation",
      });

      if (attempt.healed) {
        // Goal met!
        console.log(chalk.green(`  ✅ Goal achieved on iteration ${iteration}`));

        if (this.researcher) {
          await this.researcher.recordAttempt({
            errorMessage, filePath,
            success: true,
            explanation: attempt.explanation,
          }).catch(() => {});
        }

        if (this.logger) {
          this.logger.info("goal.success", `Goal achieved: ${this.goal}`, { iteration, explanation: attempt.explanation });
        }

        return {
          success: true,
          iteration,
          explanation: attempt.explanation,
          attempts: this._attempts,
          ...attempt,
        };
      }

      // Record failure
      console.log(chalk.yellow(`  ↩️ Iteration ${iteration} failed: ${attempt.explanation?.slice(0, 80)}`));

      if (this.researcher) {
        await this.researcher.recordAttempt({
          errorMessage, filePath,
          success: false,
          explanation: attempt.explanation,
        }).catch(() => {});

        // Deep research after 2nd failure — bring in RESEARCH_MODEL
        if (iteration >= 2) {
          console.log(chalk.magenta(`  🔬 Triggering deep research after ${iteration} failures...`));
          const research = await this.researcher.research(errorMessage, context);
          if (research) {
            console.log(chalk.gray(`  🔬 Research insight: ${research.slice(0, 100)}`));
          }
        }
      }

      if (this.logger) {
        this.logger.warn("goal.attempt_failed", `Iteration ${iteration} failed`, { iteration, explanation: attempt.explanation });
      }
    }

    // All iterations exhausted
    console.log(chalk.red(`  🛑 Goal not achieved after ${this.maxIterations} iterations`));

    if (this.logger) {
      this.logger.error("goal.failed", `Goal failed: ${this.goal}`, { attempts: this._attempts.length });
    }

    return {
      success: false,
      iteration: this.maxIterations,
      explanation: `Failed after ${this.maxIterations} iterations`,
      attempts: this._attempts,
    };
  }
}

module.exports = { GoalLoop };
