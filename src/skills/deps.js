/**
 * Dependency Manager Skill — structured npm dependency analysis + repair.
 *
 * The agent often sees errors caused by dependency issues (version conflicts,
 * missing peer deps, deprecated APIs, vulnerabilities) and wastes tokens trying
 * to "fix" code when the real problem is in package.json or node_modules.
 *
 * This skill provides structured analysis BEFORE the AI runs, so the agent
 * gets actionable context like "express@4.21 has a known vulnerability,
 * upgrade to 4.22" instead of guessing from a stack trace.
 *
 * Capabilities:
 * 1. Audit: npm audit wrapper — finds vulnerabilities with fix commands
 * 2. Outdated: detects packages with available updates
 * 3. Peer deps: finds missing/conflicting peer dependencies
 * 4. Unused: detects packages in package.json not imported anywhere
 * 5. Lock repair: detects and fixes corrupted package-lock.json
 * 6. Version conflicts: finds packages requiring incompatible versions
 * 7. Migration knowledge: knows common upgrade paths (express→fastify, etc.)
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

/**
 * Run npm audit and return structured vulnerability data.
 * @param {string} cwd — project root
 * @returns {{ vulnerabilities: number, critical: number, high: number, fixes: string[] }}
 */
function audit(cwd) {
  try {
    const raw = execSync("npm audit --json 2>/dev/null", { cwd, encoding: "utf-8", timeout: 30000 });
    const data = JSON.parse(raw);
    const meta = data.metadata || {};
    const vulns = meta.vulnerabilities || {};
    const total = (vulns.critical || 0) + (vulns.high || 0) + (vulns.moderate || 0) + (vulns.low || 0);

    const fixes = [];
    if (total > 0) {
      try {
        const fixOutput = execSync("npm audit fix --dry-run --json 2>/dev/null", { cwd, encoding: "utf-8", timeout: 30000 });
        const fixData = JSON.parse(fixOutput);
        if (fixData.added || fixData.updated || fixData.removed) {
          fixes.push("npm audit fix");
        }
      } catch { fixes.push("npm audit fix (may require --force for breaking changes)"); }
    }

    return {
      vulnerabilities: total,
      critical: vulns.critical || 0,
      high: vulns.high || 0,
      moderate: vulns.moderate || 0,
      low: vulns.low || 0,
      fixes,
    };
  } catch (e) {
    // npm audit exits non-zero when vulnerabilities exist
    try {
      const data = JSON.parse(e.stdout || "{}");
      const vulns = (data.metadata || {}).vulnerabilities || {};
      return {
        vulnerabilities: (vulns.critical || 0) + (vulns.high || 0) + (vulns.moderate || 0) + (vulns.low || 0),
        critical: vulns.critical || 0,
        high: vulns.high || 0,
        moderate: vulns.moderate || 0,
        low: vulns.low || 0,
        fixes: ["npm audit fix"],
      };
    } catch { return { vulnerabilities: 0, critical: 0, high: 0, moderate: 0, low: 0, fixes: [], error: e.message?.slice(0, 100) }; }
  }
}

/**
 * Find outdated packages.
 * @param {string} cwd
 * @returns {Array<{ name, current, wanted, latest, type }>}
 */
function outdated(cwd) {
  try {
    const raw = execSync("npm outdated --json 2>/dev/null", { cwd, encoding: "utf-8", timeout: 30000 });
    const data = JSON.parse(raw || "{}");
    return Object.entries(data).map(([name, info]) => ({
      name,
      current: info.current,
      wanted: info.wanted,
      latest: info.latest,
      type: info.type || "dependencies",
    }));
  } catch (e) {
    // npm outdated exits non-zero when outdated packages exist
    try {
      const data = JSON.parse(e.stdout || "{}");
      return Object.entries(data).map(([name, info]) => ({
        name,
        current: info.current,
        wanted: info.wanted,
        latest: info.latest,
        type: info.type || "dependencies",
      }));
    } catch { return []; }
  }
}

/**
 * Find missing or conflicting peer dependencies.
 * @param {string} cwd
 * @returns {Array<{ package, requires, missing }>}
 */
function checkPeerDeps(cwd) {
  const issues = [];
  try {
    const raw = execSync("npm ls --json --depth=1 2>/dev/null", { cwd, encoding: "utf-8", timeout: 30000 });
    const data = JSON.parse(raw || "{}");

    const walk = (deps, parentName = "root") => {
      if (!deps) return;
      for (const [name, info] of Object.entries(deps)) {
        if (info.peerMissing) {
          for (const peer of info.peerMissing) {
            issues.push({ package: name, requires: peer.requires, missing: peer.requiredBy || name });
          }
        }
        if (info.problems) {
          for (const problem of info.problems) {
            if (problem.includes("peer dep")) {
              issues.push({ package: name, requires: problem, missing: parentName });
            }
          }
        }
        if (info.dependencies) walk(info.dependencies, name);
      }
    };
    walk(data.dependencies);
  } catch (e) {
    try {
      const data = JSON.parse(e.stdout || "{}");
      if (data.problems) {
        for (const p of data.problems) {
          issues.push({ package: "root", requires: p, missing: "project" });
        }
      }
    } catch {}
  }
  return issues;
}

/**
 * Find packages in package.json that aren't imported anywhere in the project.
 * @param {string} cwd
 * @returns {string[]} — unused package names
 */
function findUnused(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return [];

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const allDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

  // Scan all .js/.ts/.mjs/.cjs files for require/import statements
  const usedPackages = new Set();
  let _fileCount = 0;
  const FILE_SCAN_CAP = 5000;
  const scanDir = (dir) => {
    if (_fileCount >= FILE_SCAN_CAP) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (_fileCount >= FILE_SCAN_CAP) return;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".wolverine") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { scanDir(fullPath); continue; }
      if (!/\.(js|ts|mjs|cjs|jsx|tsx)$/.test(entry.name)) continue;
      _fileCount++;
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        // Match require("X") and import ... from "X"
        const requires = content.match(/require\s*\(\s*["']([^"'./][^"']*)["']\s*\)/g) || [];
        const imports = content.match(/from\s+["']([^"'./][^"']*)["']/g) || [];
        for (const r of requires) {
          const m = r.match(/["']([^"']+)["']/);
          if (m) usedPackages.add(m[1].split("/")[0]);
        }
        for (const i of imports) {
          const m = i.match(/["']([^"']+)["']/);
          if (m) usedPackages.add(m[1].split("/")[0]);
        }
      } catch {}
    }
  };
  scanDir(cwd);

  // Filter: only report deps that are truly unused
  // Exclude common false positives (types, plugins, bin-only packages)
  const falsePositives = new Set(["typescript", "@types", "eslint", "prettier", "nodemon", "ts-node"]);
  return allDeps.filter(dep => {
    const baseName = dep.startsWith("@") ? dep : dep.split("/")[0];
    return !usedPackages.has(baseName) && !falsePositives.has(baseName) && !baseName.startsWith("@types/");
  });
}

/**
 * Check if package-lock.json is healthy.
 * @param {string} cwd
 * @returns {{ healthy: boolean, issue?: string, fix?: string }}
 */
function checkLockFile(cwd) {
  const lockPath = path.join(cwd, "package-lock.json");
  const pkgPath = path.join(cwd, "package.json");

  if (!fs.existsSync(lockPath)) {
    return { healthy: false, issue: "No package-lock.json found", fix: "npm install" };
  }

  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

    // Check lock version
    if (!lock.lockfileVersion || lock.lockfileVersion < 2) {
      return { healthy: false, issue: `Outdated lockfile version ${lock.lockfileVersion || 1}`, fix: "rm package-lock.json && npm install" };
    }

    // Check if lock matches package.json
    const pkgDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const lockDeps = lock.packages?.[""]?.dependencies || {};
    const lockDevDeps = lock.packages?.[""]?.devDependencies || {};
    const allLockDeps = { ...lockDeps, ...lockDevDeps };

    for (const [name] of Object.entries(pkgDeps)) {
      if (!allLockDeps[name] && !lock.dependencies?.[name]) {
        return { healthy: false, issue: `${name} in package.json but missing from lock`, fix: "npm install" };
      }
    }

    return { healthy: true };
  } catch (e) {
    return { healthy: false, issue: `Corrupted lock file: ${e.message?.slice(0, 60)}`, fix: "rm package-lock.json && npm install" };
  }
}

/**
 * Diagnose a dependency-related error and return structured fix recommendations.
 * This is the main entry point — call it from the heal pipeline.
 *
 * @param {string} errorMessage
 * @param {string} cwd
 * @returns {{ diagnosed: boolean, category: string, summary: string, fixes: string[] }}
 */
function diagnose(errorMessage, cwd) {
  const msg = (errorMessage || "").toLowerCase();

  // Pattern: Cannot find module 'X'
  const missingMatch = errorMessage.match(/Cannot find module '([^']+)'/);
  if (missingMatch) {
    const mod = missingMatch[1];
    if (!mod.startsWith(".") && !mod.startsWith("/")) {
      // Check if it's in package.json
      const pkgPath = path.join(cwd, "package.json");
      let inPkg = false;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        inPkg = !!(pkg.dependencies?.[mod] || pkg.devDependencies?.[mod]);
      } catch {}

      if (inPkg) {
        return {
          diagnosed: true,
          category: "missing_install",
          summary: `${mod} is in package.json but not installed`,
          fixes: ["npm install"],
        };
      }
      return {
        diagnosed: true,
        category: "missing_package",
        summary: `${mod} is not in package.json and not installed`,
        fixes: [`npm install ${mod}`],
      };
    }
  }

  // Pattern: Fastify v5 on old Node.js (tracingChannel requires Node 19.9+)
  if (/tracingChannel is not a function/i.test(msg) || /diagnostics.*tracingChannel/i.test(msg)) {
    const nodeVersion = parseInt(process.version.slice(1), 10);
    if (nodeVersion < 20) {
      return {
        diagnosed: true,
        category: "version_conflict",
        summary: `Fastify v5 requires Node.js >= 20 (you have ${process.version}). diagnostics_channel.tracingChannel() was added in Node 19.9`,
        fixes: [
          "npm install fastify@4", // downgrade to v4 which supports Node 16+
        ],
      };
    }
    return {
      diagnosed: true,
      category: "version_conflict",
      summary: "Fastify tracingChannel error — try reinstalling: rm -rf node_modules && npm install",
      fixes: ["rm -rf node_modules && npm install"],
    };
  }

  // Pattern: version/compatibility errors
  if (/version mismatch|incompatible|peer dep|ERESOLVE/i.test(msg)) {
    const peerIssues = checkPeerDeps(cwd);
    return {
      diagnosed: true,
      category: "version_conflict",
      summary: `Dependency version conflict (${peerIssues.length} peer dep issues)`,
      fixes: peerIssues.length > 0
        ? peerIssues.map(p => `npm install ${p.package}@latest`).concat(["npm install --legacy-peer-deps"])
        : ["npm install --legacy-peer-deps", "rm -rf node_modules && npm install"],
      details: peerIssues,
    };
  }

  // Pattern: deprecated/removed API
  if (/is not a function|is not a constructor|has no method|deprecated/i.test(msg)) {
    const outdatedPkgs = outdated(cwd);
    if (outdatedPkgs.length > 0) {
      // Find the package mentioned in the error
      const relevantPkgs = outdatedPkgs.filter(p =>
        msg.includes(p.name.toLowerCase()) || errorMessage.includes(p.name)
      );
      if (relevantPkgs.length > 0) {
        return {
          diagnosed: true,
          category: "outdated_api",
          summary: `API may have changed in newer version of ${relevantPkgs.map(p => p.name).join(", ")}`,
          fixes: relevantPkgs.map(p => `npm install ${p.name}@${p.latest}`),
          details: relevantPkgs,
        };
      }
    }
  }

  // Pattern: corrupted node_modules
  if (/unexpected token|cannot find module.*node_modules|EISDIR|ENOTDIR/i.test(msg) && msg.includes("node_modules")) {
    return {
      diagnosed: true,
      category: "corrupted_modules",
      summary: "node_modules appears corrupted",
      fixes: ["rm -rf node_modules package-lock.json && npm install"],
    };
  }

  return { diagnosed: false };
}

/**
 * Full dependency health report — used by dashboard and agent context.
 * @param {string} cwd
 * @returns {object}
 */
function healthReport(cwd) {
  const auditResult = audit(cwd);
  const outdatedPkgs = outdated(cwd);
  const peerIssues = checkPeerDeps(cwd);
  const unused = findUnused(cwd);
  const lockStatus = checkLockFile(cwd);

  const score = Math.max(0, 100
    - (auditResult.critical * 20)
    - (auditResult.high * 10)
    - (auditResult.moderate * 3)
    - (peerIssues.length * 5)
    - (lockStatus.healthy ? 0 : 15)
    - Math.min(outdatedPkgs.length * 2, 20)
  );

  return {
    score,
    audit: auditResult,
    outdated: outdatedPkgs,
    peerDeps: peerIssues,
    unused,
    lockFile: lockStatus,
    summary: score >= 80 ? "Healthy" : score >= 50 ? "Needs attention" : "Critical issues",
  };
}

// ── Migration Knowledge ──

const MIGRATION_PATTERNS = {
  "express": {
    to: "fastify",
    reason: "5.6x faster routing, built-in validation, async-first",
    patterns: [
      { from: "app.get(path, handler)", to: "fastify.get(path, handler)" },
      { from: "app.use(middleware)", to: "fastify.addHook('preHandler', middleware)" },
      { from: "res.json(data)", to: "reply.send(data)" },
      { from: "res.status(code)", to: "reply.code(code)" },
      { from: "app.listen(port)", to: "fastify.listen({ port, host: '0.0.0.0' })" },
    ],
  },
  "request": {
    to: "node-fetch or undici",
    reason: "request is deprecated since 2020",
    patterns: [
      { from: "request(url, callback)", to: "const res = await fetch(url)" },
      { from: "request.post(url, { body })", to: "await fetch(url, { method: 'POST', body })" },
    ],
  },
  "moment": {
    to: "dayjs or date-fns",
    reason: "moment is in maintenance mode, 70KB vs 2KB",
    patterns: [
      { from: "moment().format('YYYY-MM-DD')", to: "dayjs().format('YYYY-MM-DD')" },
      { from: "moment(date).diff(other)", to: "dayjs(date).diff(other)" },
    ],
  },
  "body-parser": {
    to: "built-in (Express 4.16+ / Fastify)",
    reason: "Included by default in modern frameworks",
    patterns: [
      { from: "app.use(bodyParser.json())", to: "app.use(express.json())" },
    ],
  },
  "callback-style": {
    to: "async/await with util.promisify",
    reason: "Cleaner error handling, no callback hell",
    patterns: [
      { from: "fs.readFile(path, (err, data) => {})", to: "const data = await fs.promises.readFile(path)" },
      { from: "db.query(sql, (err, rows) => {})", to: "const rows = await db.query(sql)" },
    ],
  },
};

/**
 * Check if a package has a known migration path.
 * @param {string} packageName
 * @returns {object|null}
 */
function getMigration(packageName) {
  return MIGRATION_PATTERNS[packageName] || null;
}

// ── Skill Metadata ──

const SKILL_NAME = "deps";
const SKILL_DESCRIPTION = "Dependency manager: npm audit, version conflicts, peer deps, unused packages, lock file repair, migration knowledge. Diagnoses dependency-related errors before AI runs, providing actionable fix commands instead of code edits.";
const SKILL_KEYWORDS = ["dependency", "dependencies", "npm", "package", "install", "audit", "vulnerability", "outdated", "peer", "version", "conflict", "lock", "node_modules", "upgrade", "migrate", "deprecated"];
const SKILL_USAGE = `// Diagnose a dependency error (returns structured fix)
const { diagnose } = require("../src/skills/deps");
const result = diagnose("Cannot find module 'cors'", process.cwd());
// { diagnosed: true, category: "missing_package", fixes: ["npm install cors"] }

// Full health report
const { healthReport } = require("../src/skills/deps");
const report = healthReport(process.cwd());
// { score: 85, audit: {...}, outdated: [...], peerDeps: [...], unused: [...] }

// Check migration paths
const { getMigration } = require("../src/skills/deps");
const migration = getMigration("moment");
// { to: "dayjs", reason: "maintenance mode, 70KB vs 2KB", patterns: [...] }`;

module.exports = {
  SKILL_NAME,
  SKILL_DESCRIPTION,
  SKILL_KEYWORDS,
  SKILL_USAGE,
  audit,
  outdated,
  checkPeerDeps,
  findUnused,
  checkLockFile,
  diagnose,
  healthReport,
  getMigration,
  MIGRATION_PATTERNS,
};
