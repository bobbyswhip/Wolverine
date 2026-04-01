#!/usr/bin/env node

/**
 * Demo Runner — copies a demo into server/, runs wolverine, then restores.
 *
 * Usage:
 *   node examples/run-demo.js 01-basic-typo
 *   node examples/run-demo.js 02-multi-file
 *   node examples/run-demo.js --list
 *
 * What it does:
 * 1. Backs up the current server/ directory
 * 2. Copies the demo files into server/
 * 3. Runs wolverine against server/index.js
 * 4. On exit, restores the original server/
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEMOS_DIR = path.join(__dirname, "demos");
const SERVER_DIR = path.join(ROOT, "server");
const BACKUP_DIR = path.join(ROOT, ".wolverine", "_server_backup");
const BIN = path.join(ROOT, "bin", "wolverine.js");

// List demos
if (process.argv.includes("--list") || process.argv.length < 3) {
  const demos = fs.readdirSync(DEMOS_DIR).filter(f => fs.statSync(path.join(DEMOS_DIR, f)).isDirectory());
  console.log("\nAvailable demos:\n");
  for (const demo of demos) {
    const indexPath = path.join(DEMOS_DIR, demo, "index.js");
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, "utf-8");
      const bugMatch = content.match(/\/\/ BUG:(.+)/);
      const bug = bugMatch ? bugMatch[1].trim() : "see source";
      console.log(`  ${demo.padEnd(25)} ${bug}`);
    }
  }
  console.log("\nUsage: node examples/run-demo.js <demo-name>\n");
  process.exit(0);
}

const demoName = process.argv[2];
const demoDir = path.join(DEMOS_DIR, demoName);

if (!fs.existsSync(demoDir)) {
  console.error(`Demo not found: ${demoName}`);
  console.error(`Run with --list to see available demos.`);
  process.exit(1);
}

// Step 1: Backup current server/
console.log(`\n📦 Backing up server/ → .wolverine/_server_backup/`);
copyDir(SERVER_DIR, BACKUP_DIR);

// Step 2: Copy demo into server/
console.log(`📋 Copying demo '${demoName}' → server/`);
clearDir(SERVER_DIR);
copyDir(demoDir, SERVER_DIR);

// Step 3: Run wolverine
console.log(`🐺 Starting wolverine with demo...\n`);

const child = spawn("node", [BIN, "server/index.js"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env },
});

// Step 4: Restore on exit
function restore() {
  console.log(`\n📦 Restoring original server/`);
  clearDir(SERVER_DIR);
  copyDir(BACKUP_DIR, SERVER_DIR);
  clearDir(BACKUP_DIR);
  try { fs.rmdirSync(BACKUP_DIR); } catch {}
}

process.on("SIGINT", () => { child.kill("SIGTERM"); restore(); process.exit(0); });
process.on("SIGTERM", () => { child.kill("SIGTERM"); restore(); process.exit(0); });
child.on("exit", () => { restore(); });

// Helpers
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

function clearDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      clearDir(p);
      fs.rmdirSync(p);
    } else {
      fs.unlinkSync(p);
    }
  }
}
