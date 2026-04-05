/**
 * Tool Router — maps error types to recommended tool chains.
 *
 * Lightweight adjacency graph that tells the agent which tools to use
 * for each error category. Injected into the agent prompt so it doesn't
 * waste turns guessing.
 *
 * Structure per error type:
 *   diagnose: tools to understand the problem (read-only)
 *   fix: tools to apply the solution (write)
 *   hint: one-line strategy for the AI
 *   prereq: tools that must run BEFORE fix tools
 *
 * Lookup: O(1) by error classifier output or regex match on error message.
 */

const TOOL_ROUTES = {
  // ── Code Errors ──
  "TypeError": {
    diagnose: ["read_file", "grep_code"],
    fix: ["edit_file"],
    hint: "Read the file at the error line. Find the undefined/null variable. Add a guard or fix the assignment.",
  },
  "ReferenceError": {
    diagnose: ["read_file", "grep_code"],
    fix: ["edit_file"],
    hint: "Variable is not defined. Check for typos, missing imports, or scope issues.",
  },
  "SyntaxError": {
    diagnose: ["read_file"],
    fix: ["edit_file"],
    hint: "Parse error in source. Read the file and fix the syntax at the reported line.",
  },
  "RangeError": {
    diagnose: ["read_file", "check_memory"],
    fix: ["edit_file"],
    hint: "Stack overflow or invalid array length. Check for infinite recursion or unbounded growth.",
  },

  // ── Module/Dependency Errors ──
  "missing_module": {
    diagnose: ["audit_deps", "verify_node_modules"],
    fix: ["bash_exec"],
    hint: "Run npm install <module>. If in package.json but missing from disk, run npm ci.",
  },
  "missing_file": {
    diagnose: ["read_file", "list_dir", "inspect_env"],
    fix: ["write_file", "bash_exec"],
    hint: "Check if the path is wrong (edit require) or if the file should exist (create it with expected content).",
  },
  "version_conflict": {
    diagnose: ["audit_deps", "check_migration", "verify_node_modules"],
    fix: ["bash_exec"],
    hint: "Check peer deps and version compatibility. May need npm install package@version or full reinstall.",
  },

  // ── File System Errors ──
  "ENOENT": {
    diagnose: ["list_dir", "inspect_env", "read_file"],
    fix: ["write_file", "bash_exec"],
    prereq: ["read_file"],
    hint: "File or directory doesn't exist. Check if path is correct, create if missing.",
  },
  "EACCES": {
    diagnose: ["bash_exec", "list_dir"],
    fix: ["bash_exec"],
    hint: "Permission denied. Run chmod to fix permissions on the target file/directory.",
  },
  "ENOSPC": {
    diagnose: ["disk_cleanup", "check_memory"],
    fix: ["disk_cleanup"],
    hint: "Disk full. Run disk_cleanup with dry_run=false to clear old backups and caches.",
  },
  "EMFILE": {
    diagnose: ["check_file_descriptors", "list_processes", "check_event_loop"],
    fix: ["disk_cleanup", "restart_service"],
    hint: "Too many open files. Check for FD leaks, clear caches, consider raising ulimit in system profile.",
  },

  // ── Network Errors ──
  "ECONNREFUSED": {
    diagnose: ["check_network", "check_port", "inspect_cache", "inspect_env"],
    fix: ["edit_file", "restart_service"],
    hint: "Target service is down or wrong host/port. Check config, verify service is running.",
  },
  "ECONNRESET": {
    diagnose: ["check_network", "check_logs"],
    fix: ["edit_file"],
    hint: "Connection reset by remote. Check for timeout settings, proxy config, or unstable network.",
  },
  "ETIMEDOUT": {
    diagnose: ["check_network", "check_logs", "inspect_certificate"],
    fix: ["edit_file"],
    hint: "Connection timed out. Increase timeout, check DNS, verify endpoint is reachable.",
  },
  "EADDRINUSE": {
    diagnose: ["check_port", "list_processes"],
    fix: ["bash_exec"],
    hint: "Port already in use. Find and kill the stale process holding the port.",
  },

  // ── Database Errors ──
  "database": {
    diagnose: ["inspect_db", "inspect_cache", "read_file"],
    fix: ["run_db_fix", "edit_file"],
    prereq: ["inspect_db"],
    hint: "ALWAYS inspect_db before run_db_fix. Check table schema, query the affected data, then fix.",
  },
  "pool_exhaustion": {
    diagnose: ["inspect_cache", "check_network", "check_logs"],
    fix: ["edit_file", "restart_service"],
    hint: "DB connection pool exhausted. Check for connection leaks, increase pool size, or restart.",
  },

  // ── SSL/TLS Errors ──
  "certificate": {
    diagnose: ["inspect_certificate", "check_network", "inspect_env"],
    fix: ["bash_exec", "edit_file", "add_env_var"],
    hint: "Check cert expiry, SAN list, and chain. May need renewal, hostname fix, or CA bundle.",
  },

  // ── Memory/Performance Errors ──
  "OOM": {
    diagnose: ["check_memory", "check_event_loop", "list_processes"],
    fix: ["edit_file", "restart_service"],
    hint: "Out of memory. Check for memory leaks (growing arrays, unclosed streams), reduce batch sizes.",
  },
  "event_loop_blocked": {
    diagnose: ["check_event_loop", "check_logs", "check_memory"],
    fix: ["edit_file"],
    hint: "Synchronous operation blocking event loop. Replace readFileSync→readFile, execSync→exec, etc.",
  },

  // ── WebSocket Errors ──
  "websocket": {
    diagnose: ["check_websocket", "check_network", "check_port"],
    fix: ["edit_file"],
    hint: "Test WS handshake. Check upgrade headers, proxy config, and connection timeout settings.",
  },

  // ── Config/Environment Errors ──
  "config": {
    diagnose: ["read_file", "inspect_env", "list_dir"],
    fix: ["write_file", "edit_file", "add_env_var"],
    hint: "Check if config file exists and has expected structure. Check if required env vars are set.",
  },
  "env_missing": {
    diagnose: ["inspect_env", "read_file"],
    fix: ["add_env_var"],
    hint: "Required environment variable not set. Add it to .env.local with the correct value.",
  },
};

/**
 * Find tool recommendations for an error.
 * @param {string} errorMessage — the raw error message
 * @param {string} errorType — from error-parser classifyError() (optional)
 * @returns {{ diagnose: string[], fix: string[], prereq?: string[], hint: string } | null}
 */
function route(errorMessage, errorType) {
  const msg = (errorMessage || "").toLowerCase();

  // 1. Try exact error type match
  if (errorType && TOOL_ROUTES[errorType]) return TOOL_ROUTES[errorType];

  // 2. Try error class match
  if (/typeerror/i.test(msg)) return TOOL_ROUTES.TypeError;
  if (/referenceerror/i.test(msg)) return TOOL_ROUTES.ReferenceError;
  if (/syntaxerror|unexpected token/i.test(msg)) return TOOL_ROUTES.SyntaxError;
  if (/rangeerror/i.test(msg)) return TOOL_ROUTES.RangeError;

  // 3. Try errno/code match
  if (/enoent|no such file/i.test(msg)) return TOOL_ROUTES.ENOENT;
  if (/eacces|eperm/i.test(msg)) return TOOL_ROUTES.EACCES;
  if (/enospc/i.test(msg)) return TOOL_ROUTES.ENOSPC;
  if (/emfile|enfile/i.test(msg)) return TOOL_ROUTES.EMFILE;
  if (/econnrefused/i.test(msg)) return TOOL_ROUTES.ECONNREFUSED;
  if (/econnreset/i.test(msg)) return TOOL_ROUTES.ECONNRESET;
  if (/etimedout/i.test(msg)) return TOOL_ROUTES.ETIMEDOUT;
  if (/eaddrinuse/i.test(msg)) return TOOL_ROUTES.EADDRINUSE;

  // 4. Try pattern match
  if (/cannot find module/i.test(msg)) return /['"][./\\]/.test(msg) ? TOOL_ROUTES.missing_file : TOOL_ROUTES.missing_module;
  if (/cert|ssl|tls|self.signed/i.test(msg)) return TOOL_ROUTES.certificate;
  if (/pool.*exhaust|pool.*timeout|acquire.*timeout/i.test(msg)) return TOOL_ROUTES.pool_exhaustion;
  if (/websocket|ws.*close|transport.*close/i.test(msg)) return TOOL_ROUTES.websocket;
  if (/out of memory|heap.*limit|allocation.*failed/i.test(msg)) return TOOL_ROUTES.OOM;
  if (/not.set|undefined.*env|missing.*env/i.test(msg)) return TOOL_ROUTES.env_missing;
  if (/missing.*config|invalid.*json|invalid.*config/i.test(msg)) return TOOL_ROUTES.config;
  if (/sqlite|postgres|mysql|mongo|sequelize|prisma|knex/i.test(msg)) return TOOL_ROUTES.database;
  if (/peer dep|eresolve|version.*mismatch/i.test(msg)) return TOOL_ROUTES.version_conflict;

  return null; // unknown — let the AI figure it out
}

/**
 * Get a compact prompt injection for the agent.
 * Returns a string like "TOOL ROUTE: diagnose with [check_port, list_processes], fix with [bash_exec]. Hint: ..."
 */
function getRoutePrompt(errorMessage, errorType) {
  const r = route(errorMessage, errorType);
  if (!r) return "";
  const parts = [`TOOL ROUTE for this error:`];
  parts.push(`  Diagnose: ${r.diagnose.join(", ")}`);
  if (r.prereq) parts.push(`  Prerequisites: ${r.prereq.join(", ")} (run these FIRST)`);
  parts.push(`  Fix: ${r.fix.join(", ")}`);
  parts.push(`  Strategy: ${r.hint}`);
  return parts.join("\n");
}

module.exports = { route, getRoutePrompt, TOOL_ROUTES };
