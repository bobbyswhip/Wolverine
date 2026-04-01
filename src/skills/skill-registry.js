const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

/**
 * Skill Registry — discovers skills and injects relevant ones into agent context.
 *
 * claw-code pattern:
 * 1. On startup, scan all skills and build a token-searchable index
 * 2. Before any AI call, match the user's command/error against skills
 * 3. Inject matched skill context into the prompt (not the AI — the prompt)
 *
 * Skills are JS modules in src/skills/ that export:
 * - name: string
 * - description: string
 * - keywords: string[] — tokens for matching
 * - usage: string — code example to inject into agent prompts
 * - middleware?: function — Express middleware to mount
 */

class SkillRegistry {
  constructor(options = {}) {
    this.skillsDir = options.skillsDir || path.join(__dirname);
    this._skills = [];
    this._loaded = false;
  }

  /**
   * Discover and load all skills from the skills directory.
   */
  load() {
    if (!fs.existsSync(this.skillsDir)) return;

    const files = fs.readdirSync(this.skillsDir).filter(f =>
      f.endsWith(".js") && f !== "skill-registry.js"
    );

    for (const file of files) {
      try {
        const mod = require(path.join(this.skillsDir, file));
        const skill = {
          file,
          name: mod.SKILL_NAME || file.replace(".js", ""),
          description: mod.SKILL_DESCRIPTION || "",
          keywords: mod.SKILL_KEYWORDS || [],
          usage: mod.SKILL_USAGE || "",
          hasMiddleware: typeof mod.sqlGuard === "function" || typeof mod.middleware === "function",
        };
        this._skills.push(skill);
      } catch (err) {
        console.log(chalk.yellow(`  ⚠️ Skill load error (${file}): ${err.message}`));
      }
    }

    this._loaded = true;
    if (this._skills.length > 0) {
      console.log(chalk.gray(`  🔧 Skills: ${this._skills.map(s => s.name).join(", ")}`));
    }
  }

  /**
   * Match skills to a command/error using token scoring.
   * claw-code pattern: tokenize → score against name/description/keywords → return top matches.
   *
   * @param {string} text — user command or error message
   * @param {number} limit — max skills to return
   * @returns {Array<{ name, description, usage, score }>}
   */
  match(text, limit = 3) {
    if (!text || this._skills.length === 0) return [];

    const tokens = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(t => t.length > 2);

    const scored = this._skills.map(skill => {
      const haystacks = [
        skill.name.toLowerCase(),
        skill.description.toLowerCase(),
        ...skill.keywords.map(k => k.toLowerCase()),
      ].join(" ");

      let score = 0;
      for (const token of tokens) {
        if (haystacks.includes(token)) score++;
      }

      return { ...skill, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Build context string for matched skills — inject into AI prompt.
   * claw-code pattern: pre-enrich the prompt with tool availability.
   */
  buildContext(text) {
    const matches = this.match(text);
    if (matches.length === 0) return "";

    const parts = ["\n## Available Skills"];
    for (const skill of matches) {
      parts.push(`### ${skill.name}`);
      if (skill.description) parts.push(skill.description);
      if (skill.usage) parts.push("```js\n" + skill.usage + "\n```");
    }

    return parts.join("\n");
  }

  /**
   * Get all skills for dashboard display.
   */
  getAll() {
    return this._skills.map(s => ({
      name: s.name,
      description: s.description,
      keywords: s.keywords,
      hasMiddleware: s.hasMiddleware,
    }));
  }
}

module.exports = { SkillRegistry };
