const fs = require("fs");
const path = require("path");

/**
 * Live Function Map — scans the server project on startup to build
 * a complete map of routes, exports, functions, and modules.
 *
 * This gives the agent instant context about what the server IS and
 * what it's capable of, without reading every file at heal time.
 *
 * Scans for:
 * - HTTP route handlers (express, http, fastify, koa patterns)
 * - Module exports (module.exports, exports.X)
 * - Function declarations and arrow functions
 * - Class definitions
 * - Package.json dependencies
 * - Config files (.env, .json, .yaml)
 */

const SKIP_DIRS = new Set(["node_modules", ".wolverine", ".git", "dist", "build", "coverage", "src", "bin", "tests"]);
const CODE_EXTENSIONS = new Set([".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx"]);
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".env"]);

/**
 * Scan the project and return a structured function map.
 */
function scanProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const map = {
    routes: [],
    exports: [],
    functions: [],
    classes: [],
    files: [],
    configs: [],
    dependencies: {},
    summary: "",
  };

  // Scan package.json for dependencies
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      map.dependencies = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };
    } catch { /* skip */ }
  }

  // Recursive scan
  _scanDir(root, root, map);

  // Build summary
  map.summary = _buildSummary(map);

  return map;
}

function _scanDir(dir, root, map) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".env") continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      _scanDir(fullPath, root, map);
      continue;
    }

    const ext = path.extname(entry.name);

    if (CONFIG_EXTENSIONS.has(ext) || entry.name.startsWith(".env")) {
      map.configs.push(relPath);
      map.files.push({ path: relPath, type: "config" });
      continue;
    }

    if (!CODE_EXTENSIONS.has(ext)) continue;

    map.files.push({ path: relPath, type: "code" });

    // Parse the file for patterns
    let content;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch { continue; }

    _extractRoutes(content, relPath, map);
    _extractExports(content, relPath, map);
    _extractFunctions(content, relPath, map);
    _extractClasses(content, relPath, map);
  }
}

function _extractRoutes(content, filePath, map) {
  // Express-style routes: app.get('/path', ...), router.post('/path', ...)
  const expressPattern = /(?:app|router)\.(get|post|put|delete|patch|use|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let match;
  while ((match = expressPattern.exec(content)) !== null) {
    map.routes.push({ method: match[1].toUpperCase(), path: match[2], file: filePath });
  }

  // http.createServer with URL checks: req.url === '/path'
  const httpPattern = /req\.url\s*===?\s*['"`]([^'"`]+)['"`]/gi;
  while ((match = httpPattern.exec(content)) !== null) {
    // Try to find method from nearby req.method check
    const nearby = content.slice(Math.max(0, match.index - 200), match.index + 200);
    const methodMatch = nearby.match(/req\.method\s*===?\s*['"`]([^'"`]+)['"`]/i);
    map.routes.push({
      method: methodMatch ? methodMatch[1].toUpperCase() : "*",
      path: match[1],
      file: filePath,
    });
  }

  // Fastify-style: fastify.get('/path', ...)
  const fastifyPattern = /fastify\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  while ((match = fastifyPattern.exec(content)) !== null) {
    map.routes.push({ method: match[1].toUpperCase(), path: match[2], file: filePath });
  }
}

function _extractExports(content, filePath, map) {
  // module.exports = { ... } or module.exports = functionName
  const moduleExport = content.match(/module\.exports\s*=\s*(?:\{([^}]+)\}|(\w+))/);
  if (moduleExport) {
    if (moduleExport[1]) {
      // Object exports: { foo, bar, baz }
      const names = moduleExport[1].split(",").map(s => s.trim().split(":")[0].trim()).filter(Boolean);
      for (const name of names) {
        map.exports.push({ name, file: filePath });
      }
    } else if (moduleExport[2]) {
      map.exports.push({ name: moduleExport[2], file: filePath });
    }
  }

  // exports.name = ...
  const namedExports = content.matchAll(/exports\.(\w+)\s*=/g);
  for (const m of namedExports) {
    map.exports.push({ name: m[1], file: filePath });
  }
}

function _extractFunctions(content, filePath, map) {
  // function declarations
  const funcDecls = content.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g);
  for (const m of funcDecls) {
    map.functions.push({ name: m[0].includes("async") ? `async ${m[1]}` : m[1], file: filePath });
  }

  // Named arrow functions: const foo = (...) => or const foo = async (...) =>
  const arrowFuncs = content.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/g);
  for (const m of arrowFuncs) {
    map.functions.push({ name: m[1], file: filePath });
  }
}

function _extractClasses(content, filePath, map) {
  const classDecls = content.matchAll(/class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/g);
  for (const m of classDecls) {
    map.classes.push({ name: m[1], extends: m[2] || null, file: filePath });
  }
}

function _buildSummary(map) {
  const lines = [];
  lines.push(`Project: ${map.files.length} files (${map.files.filter(f => f.type === "code").length} code, ${map.configs.length} config)`);
  lines.push(`Dependencies: ${Object.keys(map.dependencies).length}`);

  if (map.routes.length > 0) {
    lines.push(`Routes (${map.routes.length}):`);
    for (const r of map.routes.slice(0, 20)) {
      lines.push(`  ${r.method.padEnd(7)} ${r.path} → ${r.file}`);
    }
    if (map.routes.length > 20) lines.push(`  ... and ${map.routes.length - 20} more`);
  }

  if (map.classes.length > 0) {
    lines.push(`Classes: ${map.classes.map(c => c.name).join(", ")}`);
  }

  if (map.exports.length > 0) {
    lines.push(`Exports (${map.exports.length}): ${map.exports.slice(0, 15).map(e => e.name).join(", ")}${map.exports.length > 15 ? "..." : ""}`);
  }

  if (map.functions.length > 0) {
    lines.push(`Functions (${map.functions.length}): ${map.functions.slice(0, 15).map(f => f.name).join(", ")}${map.functions.length > 15 ? "..." : ""}`);
  }

  return lines.join("\n");
}

/**
 * Convert the function map to embeddable text chunks.
 * Each chunk is focused on one aspect for precise vector search.
 */
function mapToChunks(map) {
  const chunks = [];

  // Routes chunk
  if (map.routes.length > 0) {
    chunks.push({
      namespace: "functions",
      text: `HTTP Routes:\n${map.routes.map(r => `${r.method} ${r.path} (${r.file})`).join("\n")}`,
      metadata: { type: "routes", count: map.routes.length },
    });
  }

  // Per-file function chunks
  const byFile = {};
  for (const fn of map.functions) {
    if (!byFile[fn.file]) byFile[fn.file] = [];
    byFile[fn.file].push(fn.name);
  }
  for (const [file, fns] of Object.entries(byFile)) {
    chunks.push({
      namespace: "functions",
      text: `File ${file} functions: ${fns.join(", ")}`,
      metadata: { type: "file-functions", file },
    });
  }

  // Dependencies chunk
  if (Object.keys(map.dependencies).length > 0) {
    chunks.push({
      namespace: "functions",
      text: `Dependencies: ${Object.entries(map.dependencies).map(([k, v]) => `${k}@${v}`).join(", ")}`,
      metadata: { type: "dependencies" },
    });
  }

  // Classes chunk
  if (map.classes.length > 0) {
    chunks.push({
      namespace: "functions",
      text: `Classes: ${map.classes.map(c => `${c.name}${c.extends ? ` extends ${c.extends}` : ""} (${c.file})`).join(", ")}`,
      metadata: { type: "classes" },
    });
  }

  // Config files chunk
  if (map.configs.length > 0) {
    chunks.push({
      namespace: "functions",
      text: `Config files: ${map.configs.join(", ")}`,
      metadata: { type: "configs" },
    });
  }

  return chunks;
}

module.exports = { scanProject, mapToChunks };
