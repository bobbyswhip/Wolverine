const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

/**
 * Initialize the server/ directory from the built-in template.
 *
 * Called on first run if server/ doesn't exist. NEVER overwrites existing files.
 * This is why wolverine ships without a server/ directory in the npm package —
 * so `npm install` and `git pull` can never destroy user code.
 *
 * The template lives in src/templates/server/ and contains a minimal Fastify
 * server with health, api, and time routes + default settings.json.
 */
function initServer(cwd, scriptPath) {
  const serverDir = path.join(cwd, "server");
  const scriptFile = path.resolve(cwd, scriptPath);

  // If the script file already exists, nothing to do
  if (fs.existsSync(scriptFile)) return false;

  // If server/ exists but the specific script doesn't, don't create — user has their own structure
  if (fs.existsSync(serverDir) && fs.readdirSync(serverDir).length > 0) {
    console.log(chalk.yellow(`  ⚠️  ${scriptPath} not found but server/ exists — skipping template init`));
    return false;
  }

  // Create server/ from template
  const templateDir = path.join(__dirname, "..", "templates", "server");
  if (!fs.existsSync(templateDir)) {
    console.log(chalk.yellow("  ⚠️  No server template found — create server/index.js manually"));
    return false;
  }

  console.log(chalk.blue("  📦 Creating default server/ from template..."));
  _copyDir(templateDir, serverDir);
  console.log(chalk.green("  ✅ Server initialized. Edit server/ to build your app."));
  return true;
}

function _copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      _copyDir(srcPath, destPath);
    } else {
      // NEVER overwrite existing files
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(chalk.gray(`    + ${path.relative(dest, destPath)}`));
      }
    }
  }
}

module.exports = { initServer };
