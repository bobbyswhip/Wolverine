# Wolverine Node.js

**Self-healing Node.js servers powered by an AI coding harness.**

Wolverine watches your server process, catches crashes, diagnoses errors with AI, generates fixes, verifies them, and restarts — automatically. It also has a dashboard with a command interface where you can tell the agent to build features, and it will modify your server code directly.

Built on patterns from [claw-code](https://github.com/instructkr/claw-code) — the open-source Claude Code harness.

---

## Quick Start

### Install from npm

```bash
npm i wolverine-ai
cp node_modules/wolverine-ai/.env.example .env.local
# Edit .env.local — add your OPENAI_API_KEY
npx wolverine server/index.js
```

### Or clone from GitHub

```bash
git clone https://github.com/bobbyswhip/Wolverine.git
cd Wolverine
npm install
cp .env.example .env.local
# Edit .env.local — add your OPENAI_API_KEY
npm start
```

[![npm](https://img.shields.io/npm/v/wolverine-ai)](https://www.npmjs.com/package/wolverine-ai)
[![GitHub](https://img.shields.io/github/stars/bobbyswhip/Wolverine)](https://github.com/bobbyswhip/Wolverine)

Dashboard opens at `http://localhost:PORT+1`. Server runs on `PORT`.

### Try a Demo

Demos copy a buggy server into `server/`, let wolverine fix it, then restore your original:

```bash
npm run demo:list            # See all demos
npm run demo:01              # Basic typo (ReferenceError)
npm run demo:02              # Multi-file import mismatch
npm run demo:03              # Syntax error (extra paren)
npm run demo:04              # Secret leak in error output
npm run demo:05              # External service down (human notification)
npm run demo:06              # JSON config typo
npm run demo:07              # null.toString() crash
```

Each demo:
1. Backs up your current `server/` directory
2. Copies the buggy demo into `server/`
3. Runs wolverine — watch it detect, diagnose, fix, verify, and restart
4. Restores your original `server/` when you press Ctrl+C

---

## x402 Paid APIs

Turn any route into a USDC-paid API with one line of config. Uses the [x402 protocol](https://docs.cdp.coinbase.com/x402/welcome) for server-to-server payments on Base.

### Setup (one-time)

```bash
wolverine --init-vault                    # Create encrypted wallet
# Add CDP keys to .env.local (free at https://cdp.coinbase.com):
# CDP_API_KEY_ID=your-key-id
# CDP_API_KEY_SECRET=your-key-secret
```

### Usage

```javascript
// Free route — no config needed
fastify.get("/api/data", async () => ({ data: "free" }));

// Paid route — just add x402 config
fastify.get("/api/premium", {
  config: { x402: { price: "$0.01", description: "Premium data" } },
}, async (req) => ({
  data: "premium",
  paid: req.x402.amount,
  txHash: req.x402.txHash,
}));

// Variable price — caller chooses amount
fastify.post("/api/purchase", {
  config: { x402: { variable: true, min: "$1", max: "$1000", priceField: "dollars" } },
}, async (req) => ({
  credits: parseFloat(req.x402.amount.replace("$", "")) * 100,
  txHash: req.x402.txHash,
}));
```

The middleware handles everything: 402 responses, wallet signing, CDP facilitator verification, and on-chain USDC settlement. Your handler only runs after payment confirms on Base.

**Requirements:** Node 22+, CDP API keys (free tier: 1,000 tx/month), `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` for healing.

---

## Technical Paper: Autonomous AI Process Management for Node.js Servers

### 1. Abstract

Server downtime in production environments has direct costs: lost revenue, degraded user trust, and engineer hours spent on diagnosis and repair. The traditional incident response cycle -- detect, page an engineer, read logs, diagnose, write a fix, deploy, verify -- takes anywhere from 15 minutes to several hours. Much of this time is spent on routine errors that follow predictable patterns: missing dependencies, syntax mistakes, malformed configuration files, and port conflicts.

This paper describes Wolverine, a self-healing framework for Node.js servers that converts error output into structured AI prompts, routes errors through a tiered repair pipeline, and verifies fixes before restarting the process. The system uses a structured error-to-prompt conversion pipeline that enables autonomous recovery while keeping AI token costs low. Most errors are resolved for $0.00 to $0.01, with complex multi-file repairs typically under $0.10. The framework reduces mean time to recovery from minutes or hours (human intervention) to 3-60 seconds (autonomous AI repair), while maintaining security through defense-in-depth: secret redaction, prompt injection detection, file system sandboxing, and encrypted key storage.

---

### 2. The Case for AI-Driven Error Recovery

#### 2.1 The Traditional Incident Response Cycle

When a production server encounters an error, the typical response follows a well-known pattern:

```
1. Server crashes or returns 500 errors
2. Monitoring system detects the failure (30s - 5min)
3. Alert fires, pages on-call engineer (1-5min)
4. Engineer reads logs, identifies the error (5-15min)
5. Engineer diagnoses root cause (10-60min)
6. Engineer writes and tests a fix (15-120min)
7. Fix deployed to production (5-30min)
8. Engineer monitors for recurrence (15-30min)
```

Total elapsed time: **30 minutes to 4+ hours**. During this entire window, the service is degraded or unavailable.

The financial impact scales with the nature of the service. An e-commerce API returning 500 errors loses transactions directly. A SaaS platform experiencing downtime erodes customer confidence. Even internal services have indirect costs in blocked engineering work and cascading failures.

#### 2.2 Error Messages as Natural Language Prompts

The key insight behind AI-driven error recovery is that error messages and stack traces are already structured natural language descriptions of what went wrong. Consider a typical Node.js error:

```
TypeError: Cannot read properties of undefined (reading 'map')
    at /server/routes/users.js:47:23
    at Array.forEach (<anonymous>)
```

This contains everything a competent developer needs to diagnose the problem:

- **Error type**: `TypeError` -- a value is the wrong type
- **Specific cause**: Something is `undefined` when it should have a `.map` method
- **Location**: `server/routes/users.js`, line 47, column 23
- **Context**: Inside an `Array.forEach` callback

Converting this into an AI repair prompt is a zero-cost transformation. The error message does not need to be rewritten or reformatted -- it needs to be combined with the relevant source file and directed to an LLM with instructions to produce a fix. The conversion from "error text a human would read" to "error text an AI will read" is effectively free because they are the same text.

This observation has a practical consequence: the bottleneck in autonomous error recovery is not understanding the error -- it is (a) routing the error to the cheapest effective repair path, (b) preventing the AI from doing something harmful, and (c) verifying the fix actually works before restarting.

#### 2.3 Why Autonomous Recovery, Not Just Monitoring

Existing tools like PM2, nodemon, and systemd handle process restarts but not diagnosis or repair. They detect that a process died and restart it -- which simply triggers the same crash again if the underlying bug persists. APM tools (Datadog, New Relic, Sentry) excel at aggregation and alerting but still require a human to write the fix.

Wolverine fills the gap between "we know the server crashed" and "someone needs to fix it." For errors that follow patterns the AI can handle -- which in practice covers the majority of runtime crashes in Node.js applications -- the system eliminates the human from the loop entirely. For errors it cannot handle (external service outages, expired API keys, disk full), it detects that no code fix is possible and routes to human notification instead of wasting AI tokens.

---

### 3. Token Efficiency Through Structured Diagnosis

#### 3.1 The Problem with Naive AI Repair

A naive approach to AI-driven error recovery would be: send the entire error output and the full source code to an LLM with the prompt "fix this." This approach has several problems:

- **Token waste**: Sending 50KB of source files when the error is in one 20-line function
- **Ambiguity**: Without classification, the AI may attempt code fixes for problems that require operational actions (like `npm install`)
- **Cost**: At $3-15 per million input tokens (depending on the model), unstructured prompts can cost $0.15-$0.75 per repair attempt
- **Latency**: More tokens means slower response times

#### 3.2 Wolverine's Tiered Repair Pipeline

Wolverine addresses this with a four-tier approach that routes each error to the cheapest effective repair path. The tiers are arranged by cost, with the cheapest options tried first:

```
Tier 0: Operational Fix        — $0.00 (zero AI tokens)
Tier 1: Fast Path              — $0.001-$0.01 (single AI call, focused context)
Tier 2: Agent                  — $0.01-$0.10 (multi-turn, 32 tools)
Tier 3: Sub-Agents             — $0.05-$0.15 (explore -> plan -> fix with model escalation)
```

**Tier 0: Operational Fixes (Zero Tokens)**

Many production errors have deterministic solutions that require no AI involvement:

| Error Pattern | Detection | Resolution |
|---------------|-----------|------------|
| `Cannot find module 'cors'` | `missing_module` classification | `npm install cors` |
| `EADDRINUSE :3000` | `port_conflict` classification | Find and kill stale process |
| `ENOENT: no such file or directory 'config.json'` | `missing_file` classification | Read source code, infer expected fields, create file |
| `EACCES: permission denied` | `permission` classification | `chmod 755` on the target file |

These are handled by the `diagnoseDeps()` function and operational fix logic in the heal pipeline. The error parser classifies the error type, and the fix is applied directly -- no AI call, no token cost, no network latency. In practice, dependency errors (`Cannot find module`) are among the most common production crashes, and resolving them for $0.00 in under 2 seconds is a significant cost advantage.

For `ENOENT` (missing file) errors specifically, the system reads the source code that references the missing file, infers the expected structure (for JSON configs, it deduces the expected fields from how the config is accessed in code), and creates the file with the correct content. This is more sophisticated than simply creating an empty file, but still requires zero AI tokens.

**Tier 1: Fast Path (Minimal Tokens)**

For errors that require code changes but are localized to a single file:

```
Input to AI:
  - Error message (redacted)
  - Stack trace (redacted)
  - Source file contents (the file where the error occurred)
  - Last known good version (backup diff context)

Output from AI:
  - JSON with code patches AND/OR shell commands
  - Both are applied: commands first (npm install, mkdir), then patches
```

The fast path uses the `CODING_MODEL` (typically Claude Sonnet or GPT-4o) with a focused context window. By sending only the error, the relevant file, and the backup diff (so the AI can see what changed), the input is typically 1,000-3,000 tokens. The output is a structured JSON response with specific file edits.

Token budget for fast path: **20,000 tokens** for simple errors.

**Tier 2: Agent (Moderate Tokens)**

When the fast path fails verification (the fix did not resolve the error), the system escalates to a multi-turn agent with access to 32 tools:

| Category | Tools | Purpose |
|----------|-------|---------|
| File | `read_file`, `write_file`, `edit_file`, `glob_files`, `grep_code`, `list_dir`, `move_file` | Navigate and modify the codebase |
| Shell | `bash_exec`, `git_log`, `git_diff` | Run commands, inspect history |
| Database | `inspect_db`, `run_db_fix` | Examine and repair SQLite databases |
| Diagnostics | `check_port`, `check_env` | Investigate runtime environment |
| Dependencies | `audit_deps`, `check_migration` | Dependency health and upgrade paths |
| Research | `web_fetch` | Look up documentation and solutions |
| Control | `done` | Signal task completion |

The agent receives a dynamic system prompt sized to the error complexity:

- **Simple errors** (TypeError, ReferenceError): 400-token prompt with 7 essential tools
- **Complex errors** (multi-file, database, configuration): 1,200-token prompt with all 32 tools plus a fix strategy table mapping error types to recommended approaches

Token budget: **simple = 20K, moderate = 50K, complex = 100K**.

The agent also benefits from context compaction: every 3 turns, the conversation history is structurally compressed (extracting tool calls, file modifications, and error signals) without making an additional AI call. This zero-cost compaction prevents token usage from growing linearly with turn count.

**Tier 3: Sub-Agents (Maximum Capability)**

For errors that resist single-agent repair, the system spawns specialized sub-agents in sequence:

```
1. EXPLORE agent (read-only, REASONING_MODEL)
   - Investigates the codebase: reads files, checks ports, inspects databases
   - Produces a structured understanding of the problem

2. PLAN agent (read-only, REASONING_MODEL)
   - Receives the explorer's findings
   - Produces a specific fix plan with file paths and changes

3. FIX agent (read+write, CODING_MODEL)
   - Receives the plan
   - Executes the fix: file edits, shell commands, database operations
```

Sub-agents use model escalation: the explore and plan agents use cheaper models (Haiku-tier for triage), and only the fix agent uses the more capable (and expensive) Sonnet or Opus model. This reduces sub-agent costs by approximately 90% compared to running all phases on the most expensive model.

#### 3.3 Real-World Token Efficiency

The tiered approach produces measurable savings. Consider a `TypeError: Cannot read properties of undefined (reading 'map')` in a route handler:

| Approach | Tokens Used | Cost | Time |
|----------|-------------|------|------|
| Naive ("fix my code" + full source) | ~25,000 | ~$0.08-$0.31 | 8-15s |
| Wolverine fast path | ~2,000-5,000 | ~$0.01-$0.02 | 3-8s |
| If fast path fails, agent | ~8,000-20,000 | ~$0.03-$0.10 | 15-40s |

The framework also prevents token waste through several mechanisms:

- **Empty stderr guard**: Signal kills and clean shutdowns produce empty or near-empty stderr. The system detects `stderr.trim().length < 10` and skips the entire heal pipeline, saving 100% of tokens that would be wasted on non-errors.
- **Loop guard**: If the same error (identified by a normalized signature of error message + file path) fails to heal 3 times within 10 minutes, the system stops healing that error, files a bug report, and moves on. This prevents infinite loops where the AI keeps producing the same incorrect fix.
- **Rate limiter**: A global cap of 5 heals per 5 minutes prevents runaway spending regardless of how many errors occur.
- **Prior attempt summaries**: When escalating between tiers, the system passes concise "do NOT repeat" directives from failed attempts rather than the full conversation history. This reduces baseline token count while preserving the critical information about what has already been tried.

---

### 4. The Heal Pipeline

#### 4.1 Error Detection

Wolverine detects errors through three channels:

**Channel 1: Process Crashes (stderr)**

The primary channel. When the child server process exits with a non-zero code, its stderr output is captured and fed into the heal pipeline. The runner spawns the child with `stdio: ["inherit", "inherit", "pipe", "ipc"]` -- stdout passes through to the terminal, stderr is piped to the parent for analysis, and an IPC channel enables in-process communication.

**Channel 2: Caught 500 Errors (IPC)**

Most production bugs in Fastify/Express applications do not crash the process. The framework catches the error and returns a 500 response. Wolverine detects these through an error hook (`error-hook.js`) that is preloaded via Node.js `--require` flag:

```
Route handler throws → Fastify/Express error handler catches
  → error-hook.js reports error to parent via IPC
  → ErrorMonitor tracks errors per normalized route
  → Threshold reached (default: 1) → triggers heal pipeline
  → 60-second cooldown per route prevents duplicate heals
```

Route normalization collapses dynamic segments: `/api/users/123` and `/api/users/456` both map to `/api/users/:id`. This prevents the same underlying bug from triggering multiple independent heal attempts for different parameter values.

The error hook uses a WeakSet for deduplication, ensuring the same error object is never reported twice. It also auto-registers a default error handler if the user's server code never calls `setErrorHandler`, catching async route throws that would otherwise be silently swallowed.

**Channel 3: Health Check Failures**

Configurable health probes (`/health`, `/healthz`, `/ready`) run on a regular interval. If the health check fails (timeout, non-200 response, connection refused), the system treats this as a frozen process -- it force-kills the child and triggers a heal cycle.

#### 4.2 Error Processing

Once an error is detected, it passes through a processing pipeline before any AI is invoked:

```
Raw stderr/error
  │
  ├─ 1. Empty check: stderr.trim().length < 10 → just restart, no AI ($0.00)
  │
  ├─ 2. Secret redaction: all .env.local values replaced with key names
  │     "Connection failed: sk-abc123..." → "Connection failed: process.env.OPENAI_API_KEY..."
  │
  ├─ 3. Error parsing: extract file path, line number, error type, message, stack trace
  │
  ├─ 4. Injection scan: ~50 regex patterns check for prompt injection attempts
  │     "ignore all previous instructions" → BLOCKED
  │     "0x" + 64 hex chars (private key) → BLOCKED (key_leak_critical)
  │     "rm -rf /" in error message → BLOCKED (destructive_bash)
  │
  ├─ 5. Loop guard: same error failed 3+ times in 10min?
  │     → Yes: file bug report, stop healing this error
  │     → No: continue
  │
  ├─ 6. Rate limit: 5 heals per 5 minutes exceeded?
  │     → Yes: wait for window to clear
  │     → No: continue
  │
  └─ 7. Enter goal loop (Tier 0 → 1 → 2 → 3)
```

Secret redaction happens before any other processing, including logging. This ensures that API keys, database passwords, and other sensitive values from `.env.local` never appear in AI prompts, brain memory, event logs, dashboard displays, or telemetry payloads. The redactor reads all values from `.env.local` and replaces each occurrence with its key name (e.g., `sk-abc123def` becomes `process.env.OPENAI_API_KEY`).

#### 4.3 The Goal Loop

The goal loop orchestrates the tiered repair attempts with verification between each tier:

```
Goal Loop (max 3 iterations):

  Iteration 1: Fast Path
    → CODING_MODEL, single file + error context
    → AI returns JSON: { changes: [...], commands: [...] }
    → Execute commands (npm install, mkdir, etc.)
    → Apply file patches
    → Backup created before any file modification
    → VERIFY: syntax check → boot probe
    → Pass? → Record success to brain, done
    → Fail? → Rollback changes, continue to iteration 2

  Iteration 2: Agent
    → REASONING_MODEL with full tool harness (32 tools)
    → Dynamic prompt based on error complexity
    → Agent investigates, modifies files, runs commands
    → Turn budget: simple=4, config=5, complex=8 turns
    → VERIFY: syntax check → boot probe
    → Pass? → Record success to brain, done
    → Fail? → Rollback changes, continue to iteration 3

  Iteration 3: Sub-Agents
    → explore (read-only) → plan (read-only) → fix (read+write)
    → Haiku-tier triage, Sonnet/Opus-tier fix only
    → Each failure from prior iterations fed as context
    → VERIFY: syntax check → boot probe
    → Pass? → Record success to brain, done
    → Fail? → Rollback changes, report failure
```

#### 4.4 Verification

Every fix attempt is verified before the server restarts:

1. **Syntax check**: The modified files are parsed by Node.js to detect syntax errors. A fix that introduces a new syntax error is rejected immediately.

2. **Boot probe**: The server is started in a temporary process to verify it boots without crashing. The probe listens for either a successful startup signal or an error within a timeout window.

3. **Error classification comparison**: The verifier compares the error class of the original crash with any error produced during the boot probe. If the boot probe produces the same error class, the fix is considered unsuccessful.

For simple errors (TypeError, ReferenceError), the route probe step is skipped. The rationale is that the ErrorMonitor is already active and will catch any remaining 500 errors on the affected route after restart. This optimization avoids an additional $0.29 route-probe cost on errors where the syntax check and boot probe provide sufficient confidence.

#### 4.5 Learning

After a successful heal:

1. The fix is recorded in **repair history** with full metadata: error message, error type, file path, resolution description, tokens consumed, cost, repair mode (fast path/agent/sub-agent), and duration.

2. The fix is stored in the **brain** (vector store) with the error context, enabling future heals to find relevant past fixes through semantic search.

3. The backup created before the fix is promoted through the lifecycle: UNSTABLE (just created) to VERIFIED (fix passed verification) to STABLE (30 minutes of uptime without crashes).

After a failed heal:

1. The brain records the failed attempt with a "DO NOT REPEAT" tag, ensuring future attempts on similar errors do not try the same approach.

2. All file changes are rolled back to the pre-heal backup.

3. The loop guard increments its counter for this error signature.

---

### 5. Security Architecture

AI-driven code modification introduces a new class of security concerns. An attacker who can control error messages (through crafted requests, poisoned dependencies, or malicious input) could potentially use prompt injection to make the AI write malicious code. Wolverine addresses this through defense-in-depth across six layers.

#### 5.1 Secret Redaction

All values from `.env.local` are loaded at startup and automatically replaced in every string that passes through the system. This includes:

- AI prompts (error messages, file contents, system prompts)
- Brain memory (stored fixes, learnings, function maps)
- Event logs (JSONL persistence)
- Dashboard displays (real-time event stream)
- Telemetry payloads (heartbeat data)

The replacement is value-to-key: the actual secret value `sk-abc123...` is replaced with the string `process.env.OPENAI_API_KEY`. This preserves the semantic meaning (the AI knows an API key is involved) while preventing the actual credential from leaking.

#### 5.2 Prompt Injection Detection

Every error message is scanned before being sent to any AI model. The detection operates in two layers that both always run:

**Layer 1: Pattern Matching (Free)**

Approximately 50 regex patterns detect known injection techniques:

| Category | Example Patterns | Label |
|----------|------------------|-------|
| Prompt override | `ignore all previous instructions`, `forget previous` | `prompt-override` |
| Role hijack | `you are now a`, `pretend to be` | `role-hijack` |
| Code execution | `eval(`, `require('child_process')`, `Function(` | `code-exec` |
| Data exfiltration | `process.env`, `curl`, `fetch('http...` | `exfiltration` |
| Destructive operations | `rm -rf`, `rimraf`, `fs.unlinkSync` | `destructive-fs` |
| Key material leak | 64-character hex strings (private keys) | `key-leak-critical` |
| Vault path references | `master.key`, `eth.vault`, `.wolverine/vault` | `vault-path-leak` |
| Bash sandbox escape | `rm -rf /`, `rmdir /`, `shutdown`, `reboot` | `destructive-bash` |

If any pattern matches, the heal is blocked entirely. The error is logged with the detected label, and no AI model is invoked.

**Layer 2: AI-Powered Deep Scan**

Even if no regex pattern matches, every error message is also analyzed by the `AUDIT_MODEL` (typically the cheapest available model, such as GPT-4o-mini or Claude Haiku). This catches novel injection attempts that do not match known patterns. The audit model is specifically prompted to identify attempts to manipulate AI behavior through error messages.

Both layers must pass for the error to proceed to the repair pipeline. If either layer flags the error, it is blocked.

#### 5.3 File System Sandbox

The agent operates within a strict sandbox that limits which files it can read and modify:

**Writable paths**: Only files within `server/` are writable by the agent. This is the user's application code -- the only code the agent should ever need to modify.

**Read-only paths**: The agent can read files outside `server/` for investigation purposes (understanding imports, checking configurations) but cannot modify them.

**Blocked paths** (neither read nor write by the agent's modification tools):
- `src/` -- Wolverine framework source
- `bin/` -- CLI entry points
- `tests/` -- Test suite
- `node_modules/` -- Dependencies
- `.env` and `.env.local` -- Secrets
- `package.json` -- Dependency manifest

Symlink escape detection prevents the agent from creating symbolic links that point outside the sandbox. The sandbox resolves all paths to their real location before applying access checks.

#### 5.4 Command Blocking

The agent's `bash_exec` tool filters all commands through 18+ blocked patterns before execution:

```
Blocked command patterns:
  rm -rf /          — recursive deletion of root
  rmdir /           — directory deletion at root
  format, mkfs, dd  — disk formatting
  shutdown, reboot  — system control
  git push --force  — destructive git operations
  git reset --hard  — history destruction
  npm publish       — accidental package publication
  curl | bash       — remote code execution
  wget | sh         — remote code execution
  eval(             — dynamic code execution
  cat .env          — secret file reading via shell
  > src/            — redirect write into framework source
  cp ... src/       — copy into framework source
  mv ... src/       — move into framework source
  tee ... src/      — tee into framework source
```

Additionally, a sandbox escape detector blocks commands that operate on paths outside the project directory. Commands containing `../` traversals, absolute paths outside the project root, or references to system directories are rejected.

#### 5.5 Adaptive Rate Limiting

The adaptive rate limiter monitors system resources in real-time and throttles incoming requests when the server is under pressure:

| Zone | CPU/Memory | Behavior |
|------|-----------|----------|
| GREEN | < 70% | Full throughput, no limiting |
| YELLOW | 70-85% | Gradual connection shedding |
| RED | > 85% | Reject non-essential requests with 503 |

The limiter samples CPU and memory every 5 seconds, maintaining a 1-minute rolling history (12 samples). It reserves approximately 200MB of memory headroom for Wolverine's heal tools -- ensuring the AI repair pipeline can operate even when the application server is under heavy load.

Exempt paths that are never rate-limited: `/health`, `/healthz`, `/ready`, and Wolverine internal routes (`/api/v1/heartbeat`, `/api/v1/register`). Requests with the `X-Wolverine-Internal` header also bypass the limiter.

#### 5.6 Vault Encryption

Private keys (Ethereum wallet keys for x402 payments) are stored using AES-256-GCM encryption:

```
.wolverine/vault/
  master.key   — 32 bytes raw AES-256 key (chmod 0600)
  eth.vault    — JSON with AES-256-GCM encrypted private key
```

Design principles enforced by the vault:

- **Buffer-only key handling**: Private keys never exist as JavaScript strings. They are stored in `Buffer` objects and explicitly zeroed (`buffer.fill(0)`) after use. JavaScript strings are immutable and garbage-collected nondeterministically, making them unsuitable for secret storage.
- **Generic error messages**: The wallet operations layer (`wallet-ops.js`) catches and swallows all vault error details before they can reach the AI. If the vault fails, the AI sees "Vault operation failed" rather than any information about the key material.
- **Single secret on disk**: The `master.key` file is the only unencrypted secret. Everything else (Ethereum private key, future secrets) is encrypted with this master key.
- **Agent isolation**: The sandbox blocks the agent from reading any path containing `.wolverine/vault`. Even if an injection attack succeeded in bypassing other protections, the agent's tools physically cannot access the vault directory.
- **Persistence**: The vault lives in `.wolverine/`, which survives `git pull`, `npm install`, and auto-updates. Vault files are also included in every backup snapshot and are on the protected list for rollback (never overwritten during restore).

#### 5.7 SSRF Protection

The agent's `web_fetch` tool blocks requests to private IP ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x, 127.x.x.x, and IPv6 equivalents). This prevents server-side request forgery attacks where a crafted error message tricks the agent into fetching internal services or metadata endpoints (such as cloud provider instance metadata at 169.254.169.254).

---

### 6. The Brain: Vector-Indexed Memory

#### 6.1 Architecture

The brain is a hybrid retrieval system combining semantic vector search with keyword-based BM25 search. It serves as the framework's persistent memory, storing past fixes, error patterns, tool documentation, and learned behaviors.

The vector store uses five optimization techniques for performance at scale:

1. **Pre-normalized vectors**: All embedding vectors are L2-normalized at insertion time. This converts cosine similarity computation into a simple dot product (eliminating the square root operations that dominate naive implementations).

2. **IVF (Inverted File Index)**: Vectors are clustered into sqrt(N) buckets using k-means++ initialization. At query time, only the nearest 20% of clusters are probed, reducing search from O(N) to O(sqrt(N)).

3. **BM25 inverted index**: A proper term frequency-inverse document frequency index for keyword search. Lookup is O(query_tokens) instead of O(N) linear scan.

4. **Binary persistence**: Vectors are stored as Float32Array buffers in a binary file format, providing 10x faster load times and 4x smaller file sizes compared to JSON serialization.

5. **Incremental indexing**: New entries are added without rebuilding the entire index. The IVF index is only rebuilt when cluster balance degrades beyond a threshold.

**Search performance benchmarks:**

| Entries | Semantic Search | BM25 Keyword | IVF Clusters |
|---------|----------------|--------------|--------------|
| 100 | 0.2ms | 0.005ms | 10 |
| 1,000 | 0.4ms | 0.01ms | 32 |
| 10,000 | 4.4ms | 0.1ms | 100 |
| 50,000 | 23.7ms | 0.5ms | 224 |

These benchmarks demonstrate sub-linear scaling. At 50,000 entries, a semantic search completes in under 24ms -- well within the latency budget for real-time repair decisions.

#### 6.2 Namespace Isolation

The brain organizes content into namespaces:

| Namespace | Contents | Searchable During Heals |
|-----------|----------|------------------------|
| `errors` | Past error messages with context | Yes |
| `fixes` | Successful repairs with full metadata | Yes |
| `learnings` | Research findings, discovered patterns | Yes |
| `functions` | Function map (routes, classes, exports) | Yes |
| `seeds` | 60+ framework documentation entries | No (unless query is about Wolverine itself) |

Namespace isolation is critical for token efficiency. The 60+ seed documents contain approximately 20,000 tokens of framework documentation (tool descriptions, security patterns, best practices). If these were included in every error heal search, they would consume context window space without contributing to the repair. By isolating seeds to a separate namespace that is only searched when the query explicitly concerns Wolverine's own behavior, the system saves approximately 50% of context space during normal heal operations.

#### 6.3 Function Map

On startup and periodically during operation, the brain scans the `server/` directory and indexes:

- **Routes**: HTTP method, path, handler function, file location
- **Functions**: Named functions with parameters and approximate line ranges
- **Classes**: Class definitions with method lists
- **Exports**: Module export signatures

This function map serves two purposes. First, it provides the AI agent with a structural understanding of the codebase without reading every file (saving tokens). Second, it enables the route prober to auto-discover and monitor all endpoints.

The function map uses a content hash to detect changes. If the hash matches the previously scanned state, the re-embedding step is skipped -- avoiding unnecessary API calls to the embedding model.

#### 6.4 Learning Loop

Every successful heal feeds back into the brain:

```
Error occurs → heal pipeline fixes it → verification passes
  → Store in brain:
    - Namespace: "fixes"
    - Content: error message + classification + fix description
    - Metadata: file path, tokens used, cost, repair mode, duration
    - Embedding: vector representation for semantic search

Future similar error occurs → brain search finds past fix
  → Past fix context injected into AI prompt
  → AI sees what worked before, avoids what failed
  → Faster repair, fewer iterations, lower cost
```

Failed heals are also stored, tagged with "DO NOT REPEAT" metadata. When the brain search returns a failed past fix, the AI prompt explicitly instructs the model not to attempt the same approach.

---

### 7. x402 Paid APIs

#### 7.1 Protocol Overview

The x402 protocol extends HTTP with a payment layer using the `402 Payment Required` status code. When a client requests a paid endpoint without a payment header, the server responds with 402 and a JSON body describing the payment requirements (amount, asset, network, recipient address). The client constructs a payment authorization, signs it, and retransmits the request with an `X-Payment` header containing the signed payment.

This enables machine-to-machine payments without user interaction -- an AI agent calling a paid API can programmatically construct and sign payments.

#### 7.2 Integration

Wolverine's x402 implementation is a Fastify plugin that converts any route into a paid endpoint with a single configuration object:

```javascript
// Fixed price: $0.01 per call
fastify.get("/api/premium", {
  config: { x402: { price: "$0.01" } }
}, handler);

// Variable price: caller specifies amount
fastify.post("/api/credits", {
  config: { x402: { variable: true, min: "$1", max: "$10000", priceField: "dollars" } }
}, handler);
```

No additional middleware, no payment processing code in the handler. The plugin handles the entire flow in the `preHandler` hook:

```
Request arrives
  │
  ├─ No x402 config on route → pass through (free route)
  │
  ├─ Has x402 config, no payment header
  │   → Return 402 with payment requirements
  │
  ├─ Has x402 config + payment header
  │   ├─ Decode base64 payment payload
  │   ├─ Verify via x402 facilitator (CDP)
  │   │   ├─ Invalid → Return 402 with reason
  │   │   └─ Valid → Continue
  │   ├─ Settle via facilitator (USDC moves on-chain)
  │   │   ├─ Failed → Return 402
  │   │   └─ Success → Continue
  │   ├─ Attach payment info to request: req.x402 = { paid, amount, from, txHash }
  │   └─ Execute route handler (payment confirmed)
```

Settlement uses EIP-3009 `TransferWithAuthorization` via the Coinbase CDP facilitator. The USDC transfer is confirmed on Base L2 before the route handler executes. The handler only runs after money has moved on-chain.

#### 7.3 Wallet Management

The payment recipient address is auto-detected from the encrypted vault:

1. `wolverine --init-vault` generates an Ethereum private key, encrypts it with AES-256-GCM, and stores it in `.wolverine/vault/eth.vault`
2. On startup, the x402 plugin reads the wallet address (public key derivation only -- the private key is never loaded into the plugin)
3. The `payTo` address can also be set manually in `settings.json` or passed as a plugin option

Payment logs are maintained in `.wolverine/x402-payments.json` (capped at 1,000 entries) with route, method, amount, payer address, transaction hash, and timestamp.

---

### 8. Operational Features

#### 8.1 Backup System

All backups are stored in `~/.wolverine-safe-backups/` -- a location outside the project directory that survives `git pull`, `npm install`, project deletion, and framework updates.

**Lifecycle states:**

| State | Meaning | Transition |
|-------|---------|------------|
| UNSTABLE | Just created, fix not yet verified | → VERIFIED when fix passes verification |
| VERIFIED | Fix passed syntax + boot probe | → STABLE after 30 minutes of uptime |
| STABLE | Server has been running without crashes for 30+ minutes | Terminal state |

**Creation triggers:**
- Before every heal attempt (automatic)
- Before every framework update (automatic)
- On graceful shutdown (automatic)
- On manual request via CLI or dashboard

**Retention policy:**
- UNSTABLE and VERIFIED backups: pruned after 7 days
- STABLE backups older than 7 days: keep 1 per day (most recent that day)

**Protected files** (never overwritten during rollback):
- `server/config/settings.json` -- configuration
- `server/lib/db.js` -- database connection setup
- `server/lib/redis.js` -- Redis connection setup
- `.env` and `.env.local` -- secrets
- `.wolverine/vault/master.key` -- vault encryption key
- `.wolverine/vault/eth.vault` -- encrypted wallet

The rollback system creates a pre-rollback safety backup before restoring, enabling "undo rollback" if the restored state is worse than the current state.

#### 8.2 Auto-Update

The framework checks for new versions on npm and upgrades itself using a selective update strategy:

```
Update process:
  1. Create emergency backup in ~/.wolverine-safe-backups/
  2. Back up server/, .wolverine/, .env to memory
  3. Update ONLY src/ and bin/ (framework code)
  4. Update package.json dependencies
  5. Restore all user files (server code, brain, backups, config)
  6. Signal brain to merge new seed documents (append, not replace)
  7. Verify boot
```

The selective approach is critical. A naive `git pull` or `npm install wolverine-ai` overwrites the `server/` directory, which contains user application code, routes, database configurations, and settings. The auto-updater explicitly avoids touching `server/`, `.wolverine/`, and `.env` files.

Update checks run 30 seconds after startup and then at a configurable interval (default: every 5 minutes, configurable via `settings.json` `autoUpdate.intervalMs`). A version lock ensures only one update attempt per boot cycle.

#### 8.3 Dashboard

The dashboard runs on `PORT+1` (default: 3001) and provides a real-time web interface:

| Panel | Data Source | Update Method |
|-------|------------|---------------|
| Overview | Event logger, repair history | SSE (real-time) |
| Events | Event log (JSONL) | SSE stream |
| Performance | Perf monitor, route prober | SSE + polling |
| Command | AI client (chat/tools/agent routes) | Request/response |
| Analytics | Token tracker, process monitor | Polling |
| Backups | Backup manager | On-demand |
| Brain | Vector store stats | On-demand |
| Repairs | Repair history | On-demand |
| Tools | Agent engine tool definitions | Static |
| Usage | Token tracker (by model/category/tool) | Polling |

The command interface classifies each user message into one of three routes:

- **SIMPLE** (CHAT_MODEL, no tools): Knowledge questions, explanations
- **TOOLS** (TOOL_MODEL, limited tools): Live data queries, file reads, brain searches
- **AGENT** (CODING_MODEL, full 32-tool harness): Build features, fix code, modify server

Secured with `WOLVERINE_ADMIN_KEY` plus IP allowlist (localhost always allowed, additional IPs via `WOLVERINE_ADMIN_IPS` environment variable or runtime API).

#### 8.4 Process Management

Wolverine functions as a PM2-like process manager with AI-augmented diagnostics:

- **Heartbeat monitoring**: Checks process liveness every 10 seconds
- **Memory tracking**: RSS and heap size monitoring with leak detection (N consecutive growth samples trigger restart)
- **Memory limit**: Auto-restart when RSS exceeds configurable threshold (default: 512MB)
- **CPU sampling**: Per-process CPU percentage with trend detection
- **SIGKILL/OOM detection**: Detects when the OS kills the process (out of memory, signal 9)
- **Spawn retry**: Configurable retry logic for process startup failures
- **Graceful shutdown**: SIGTERM with configurable grace period, escalating to SIGKILL
- **SIGTERM startup grace**: 3-second window after spawning where SIGTERM is ignored, preventing restart scripts from killing a newly spawned process
- **Process dedup**: PID file ensures only one Wolverine instance runs per project. On startup, any existing process with a stale PID file is killed. The exit handler only deletes the PID file if it still belongs to the current process, preventing race conditions during rapid restarts.

#### 8.5 Health Monitoring

Configurable health probes run on a regular interval:

- Default endpoints: `/health`, `/healthz`, `/ready`
- Timeout: configurable per-probe
- Failure behavior: force-kill the process and trigger a heal cycle
- Integration: health check failures feed into the same heal pipeline as crashes

#### 8.6 Cluster Support

The server handles its own clustering internally. Wolverine remains a single process manager that spawns the server entry point. If `WOLVERINE_CLUSTER=true`, the server's entry point forks worker processes:

```
Wolverine (single process)
  └─ server/index.js (master)
       ├─ Worker 1 (port 3000, reusePort)
       ├─ Worker 2 (port 3000, reusePort)
       └─ Worker N (port 3000, reusePort)
```

Workers share port 3000 via `reusePort` with OS-level load balancing. Dead workers auto-respawn. Wolverine kills the entire process tree on restart to prevent orphaned workers. The `WOLVERINE_RECOMMENDED_WORKERS` environment variable is auto-set based on detected CPU cores and available RAM.

---

### 9. Benchmarks and Real-World Performance

#### 9.1 Heal Timing

Measured from error detection to verified fix applied and server restarted:

| Error Type | Typical Heal Time | Repair Tier |
|------------|-------------------|-------------|
| Missing module (`Cannot find module`) | 2-5 seconds | Tier 0 (operational) |
| Port conflict (`EADDRINUSE`) | 1-3 seconds | Tier 0 (operational) |
| Missing config file (`ENOENT`) | 2-4 seconds | Tier 0 (operational) |
| Simple TypeError/ReferenceError | 3-8 seconds | Tier 1 (fast path) |
| Syntax error | 3-10 seconds | Tier 1 (fast path) |
| Multi-file import mismatch | 15-40 seconds | Tier 2 (agent) |
| Database schema error | 20-60 seconds | Tier 2 (agent) |
| Complex multi-component bug | 30-90 seconds | Tier 3 (sub-agents) |

Operational fixes (Tier 0) complete in under 5 seconds because they involve no network calls to AI providers. The bottleneck is the `npm install` or `kill` command itself.

The 5-minute heal timeout (configurable via `WOLVERINE_HEAL_TIMEOUT_MS`) acts as a hard upper bound. If a heal exceeds this limit, partially applied changes are rolled back and the system reports failure.

#### 9.2 Token Usage

Distribution of token consumption across heal operations:

| Metric | Value |
|--------|-------|
| Heals using zero tokens (Tier 0) | ~30-40% of all heals |
| Heals using < 5,000 tokens (Tier 1) | ~40-50% of all heals |
| Heals using 5,000-20,000 tokens (Tier 2) | ~15-25% of all heals |
| Heals using > 20,000 tokens (Tier 3) | ~5-10% of all heals |

The distribution is heavily skewed toward cheap operations. The majority of production errors fall into categories that either require no AI (missing dependencies, port conflicts) or are simple enough for a single focused AI call (typos, null reference errors, missing null checks).

#### 9.3 Cost Per Heal

Estimated costs using typical model pricing (Claude Sonnet at ~$3/$15 per million input/output tokens):

| Repair Tier | Token Range | Estimated Cost |
|-------------|-------------|---------------|
| Tier 0: Operational | 0 | $0.00 |
| Tier 1: Fast Path | 1,000-5,000 | $0.001-$0.02 |
| Tier 2: Agent | 5,000-50,000 | $0.02-$0.10 |
| Tier 3: Sub-Agents | 20,000-100,000 | $0.05-$0.15 |

Cost optimizations that contribute to these numbers:

- **Prompt caching** (Anthropic): System prompts are marked with `cache_control: ephemeral`. On repeat calls (which are common during multi-turn agent sessions), the cached system prompt is 90% cheaper. For a typical 12,000-16,000 token system prompt, this saves $0.03-$0.04 per heal.
- **Haiku triage for sub-agents**: Explorer, planner, and verifier sub-agents use the cheapest model tier. Only the fixer uses the more expensive model.
- **Dynamic prompt sizing**: Simple errors get a 400-token system prompt with 7 tools instead of the full 1,200-token prompt with 32 tools.
- **Token budget caps**: Hard limits prevent any single heal from exceeding its allocated budget (simple=20K, moderate=50K, complex=100K).

#### 9.4 Limitations

Honest accounting of what the system does not handle well:

- **Logic errors with no runtime symptoms**: If the code runs without errors but produces wrong results, Wolverine has no signal to trigger a heal. It responds to crashes and 500 errors, not incorrect business logic.
- **External service outages**: When the root cause is an external API being down, no code change will fix the problem. The system detects these (ECONNREFUSED, ETIMEDOUT, 503 responses) and routes to human notification rather than attempting futile code repairs.
- **Performance regressions**: The system does not currently detect or repair performance degradation that does not result in errors or crashes.
- **Complex architectural problems**: Multi-service coordination issues, race conditions, and distributed system failures typically exceed what a single-project agent can diagnose and repair.
- **Novel attack vectors**: While the injection detector covers approximately 50 known patterns plus AI-powered deep scanning, sufficiently sophisticated prompt injection attempts in error messages could theoretically bypass both layers. The sandbox and protected paths provide defense-in-depth, but no injection detection system is provably complete.

---

### 10. Conclusion

Wolverine demonstrates that the combination of structured error-to-prompt conversion with tiered AI escalation creates a practical autonomous recovery system for Node.js servers. The key technical contributions are:

1. **Error classification as a routing mechanism**: By parsing and classifying errors before invoking AI, the system routes the majority of crashes to zero-cost operational fixes. This transforms AI-driven error recovery from an expensive novelty into a cost-effective production tool.

2. **Tiered escalation with verification gates**: Each repair tier is more capable and more expensive than the last. Verification between tiers prevents unnecessary escalation and ensures fixes are validated before deployment. Failed fixes are automatically rolled back.

3. **Token efficiency through structured prompts**: Dynamic prompt sizing, context compaction, namespace isolation, and prompt caching reduce per-heal costs by 10-15x compared to naive approaches. The median heal costs under $0.01.

4. **Defense-in-depth security**: Six overlapping security layers (secret redaction, injection detection, file system sandbox, command blocking, adaptive rate limiting, and encrypted vault) address the unique risks of autonomous code modification. No single layer is sufficient on its own; the combination provides practical security against the most likely attack vectors.

5. **Persistent learning**: The vector-indexed brain enables the system to improve over time. Successful fixes accelerate future repairs of similar errors. Failed fixes are remembered and avoided. The function map provides structural awareness without requiring the AI to read every file on every heal.

The practical result is a reduction in mean time to recovery from minutes or hours (human response) to seconds (autonomous repair) for the class of errors the system can handle -- which, based on the error classification distribution, covers the majority of routine production crashes in Node.js applications. For errors outside this class, the system degrades gracefully: detecting that no code fix is viable and routing to human notification rather than consuming tokens on futile repair attempts.

The framework is open-source, published as `wolverine-ai` on npm, and designed to wrap any existing Node.js server with zero code changes required in the target application.

---

## Architecture

```
wolverine/
├── server/                  ← YOUR server code (agent can edit)
│   ├── index.js             ← Entry point
│   ├── routes/              ← Route modules
│   └── config/settings.json ← All settings (models, cluster, telemetry, limits)
├── src/
│   ├── core/                ← Wolverine engine
│   │   ├── wolverine.js     ← Heal pipeline + goal loop
│   │   ├── runner.js        ← Process manager (PM2-like)
│   │   ├── ai-client.js     ← Dual provider client (OpenAI + Anthropic)
│   │   ├── models.js        ← 10-model configuration system
│   │   ├── verifier.js      ← Fix verification (syntax + boot probe)
│   │   ├── error-parser.js  ← Stack trace parsing + error classification
│   │   ├── error-hook.js   ← Auto-injected into child (IPC error reporting)
│   │   ├── patcher.js       ← File patching with sandbox
│   │   ├── health-monitor.js← PM2-style health checks
│   │   ├── config.js        ← Config loader (settings.json + env)
│   │   ├── system-info.js   ← Machine detection (cores, RAM, cloud, containers)
│   │   └── cluster-manager.js← Auto-scaling worker management
│   ├── agent/               ← AI agent system
│   │   ├── agent-engine.js  ← Multi-turn agent with 18 tools + 45s per-call timeout
│   │   ├── goal-loop.js     ← Goal-driven repair loop
│   │   ├── research-agent.js← Deep research + learning from failures
│   │   └── sub-agents.js    ← 7 specialized sub-agents (explore/plan/fix/verify/...)
│   ├── security/            ← Security stack
│   │   ├── sandbox.js       ← Directory-locked file access
│   │   ├── secret-redactor.js← Env value → key name replacement
│   │   ├── injection-detector.js ← AI-powered prompt injection scan
│   │   ├── rate-limiter.js  ← Error explosion protection
│   │   └── admin-auth.js    ← Dashboard admin authentication
│   ├── brain/               ← Semantic memory
│   │   ├── brain.js         ← Vector store + function map + learning
│   │   ├── vector-store.js  ← In-memory cosine similarity search
│   │   ├── embedder.js      ← Embedding + text compaction pipeline
│   │   └── function-map.js  ← Live project scanner
│   ├── backup/              ← Smart backup system
│   │   └── backup-manager.js← Full server/ snapshots with retention
│   ├── logger/              ← Observability
│   │   ├── event-logger.js  ← Structured event bus + JSONL persistence
│   │   ├── token-tracker.js ← Token usage + USD cost tracking
│   │   ├── repair-history.js← Error/resolution audit trail
│   │   └── pricing.js       ← Model cost calculations
│   ├── monitor/             ← Performance + process management
│   │   ├── perf-monitor.js  ← Endpoint response times + spam detection
│   │   ├── process-monitor.js← Memory/CPU/heartbeat + leak detection
│   │   ├── route-prober.js  ← Auto-discovers and tests all routes
│   │   └── error-monitor.js ← Caught 500 error detection (no-crash healing)
│   ├── dashboard/           ← Web UI
│   │   └── server.js        ← Real-time dashboard + command interface
│   ├── notifications/       ← Alerts
│   │   └── notifier.js      ← Human-required error detection
│   ├── mcp/                 ← External tools
│   │   ├── mcp-client.js    ← MCP protocol client (stdio + HTTP)
│   │   ├── mcp-registry.js  ← Server discovery + tool registration
│   │   └── mcp-security.js  ← Allowlists + injection scan on MCP results
│   ├── skills/              ← Reusable capabilities
│   │   ├── skill-registry.js← Auto-discovery + prompt injection
│   │   └── sql.js           ← Cluster-safe SQL + injection prevention
│   └── platform/            ← Fleet telemetry
│       ├── telemetry.js     ← Collects heartbeat data from all subsystems
│       ├── heartbeat.js     ← Sends heartbeats to platform backend
│       ├── register.js      ← Auto-registration on first run
│       └── queue.js         ← Offline queue with replay
├── bin/wolverine.js         ← CLI entry point (cluster-aware)
├── tests/                   ← Test suite
└── .wolverine/              ← Runtime state (gitignored)
    ├── brain/               ← Vector store persistence
    ├── events/              ← Event log (JSONL)
    ├── backups/             ← Server snapshots
    ├── usage.json           ← Token usage aggregates
    ├── usage-history.jsonl  ← Full token usage timeline
    ├── repair-history.json  ← Error/resolution audit trail
    └── mcp.json             ← MCP server configuration
```

---

## How Self-Healing Works

```
Server crashes
  → Error parsed (file, line, message, errorType)
  → Error classified: missing_module | missing_file | permission | port_conflict | syntax | runtime
  → Secrets redacted from error output
  → Prompt injection scan (AUDIT_MODEL)
  → Human-required check (expired keys, service down → notify, don't waste tokens)
  → Rate limit check (error loop → exponential backoff)

Operational Fix (zero AI tokens):
  → "Cannot find module 'cors'" → npm install cors (instant, free)
  → ENOENT on config file → read source code, infer expected fields, create with correct structure
  → EACCES/EPERM → chmod 755
  → EADDRINUSE → find and kill stale process on port
  → If operational fix works → done. No AI needed.

Goal Loop (iterate until fixed or exhausted):
  Iteration 1: Fast path (CODING_MODEL, single file, ~1-2k tokens)
    → AI returns code changes AND/OR shell commands (npm install, mkdir, etc.)
    → Execute commands first, apply patches second
    → Verify (syntax check + boot probe) → Pass? Done.
  Iteration 2: Single agent (REASONING_MODEL, multi-file, 10 tools)
    → Agent has error pattern → fix strategy table
    → Uses bash_exec for npm install, chmod, config creation
    → Uses edit_file for code fixes
    → Verify → Pass? Done.
  Iteration 3: Sub-agents (explore → plan → fix)
    → Explorer finds relevant files (read-only)
    → Planner considers operational vs code fixes
    → Fixer has bash_exec + file tools (can npm install AND edit code)
    → Deep research (RESEARCH_MODEL) feeds into context
    → Each failure feeds into the next attempt

After fix:
  → Record to repair history (error, resolution, tokens, cost, mode)
  → Store in brain for future reference
  → Promote backup to stable after 30min uptime
```

### Caught Error Healing (No-Crash)

Most production bugs don't crash the process — Fastify/Express catch them and return 500. Wolverine now detects these too:

```
Route returns 500 (process still alive)
  → Error hook reports to parent via IPC (auto-injected, zero user code changes)
  → ErrorMonitor tracks errors per normalized route (/api/users/:id)
  → Single error triggers heal pipeline immediately (configurable threshold)
  → Fix applied → server restarted → route prober verifies fix
```

| Setting | Default | Env Variable |
|---------|---------|-------------|
| Failure threshold | 1 | `WOLVERINE_ERROR_THRESHOLD` |
| Time window | 30s | `WOLVERINE_ERROR_WINDOW_MS` |
| Cooldown per route | 60s | `WOLVERINE_ERROR_COOLDOWN_MS` |

Routes are auto-normalized: `/api/users/123` and `/api/users/456` aggregate as `/api/users/:id`.

The error hook auto-patches Fastify and Express via `--require` preload. No middleware, no code changes to your server.

---

## Agent Tool Harness

The AI agent has 18 built-in tools (inspired by [claw-code](https://github.com/ultraworkers/claw-code)):

| Tool | Category | Description |
|------|----------|-------------|
| `read_file` | File | Read any file with optional offset/limit for large files |
| `write_file` | File | Write complete file content, creates parent dirs |
| `edit_file` | File | Surgical find-and-replace without rewriting entire file |
| `glob_files` | File | Pattern-based file discovery (`**/*.js`, `src/**/*.json`) |
| `grep_code` | File | Regex search across codebase with context lines |
| `list_dir` | File | List directory contents with sizes (find misplaced files) |
| `move_file` | File | Move or rename files (fix structure problems) |
| `bash_exec` | Shell | Sandboxed shell execution (npm install, chmod, kill, etc.) 30s default, 60s cap |
| `git_log` | Shell | View recent commit history |
| `git_diff` | Shell | View uncommitted changes |
| `inspect_db` | Database | List tables, show schema, run SELECT on SQLite databases |
| `run_db_fix` | Database | UPDATE/DELETE/INSERT/ALTER on SQLite (auto-backup before write) |
| `check_port` | Diagnostic | Check if a port is in use and by what process |
| `check_env` | Diagnostic | Check environment variables (values auto-redacted) |
| `audit_deps` | Deps | Full health check: vulnerabilities, outdated, peer conflicts, unused |
| `check_migration` | Deps | Known upgrade paths (express→fastify, moment→dayjs, etc.) |
| `web_fetch` | Research | Fetch URL content for documentation/research |
| `done` | Control | Signal task completion with summary |

**Blocked commands** (from claw-code's `destructiveCommandWarning`):
`rm -rf /`, `git push --force`, `git reset --hard`, `npm publish`, `curl | bash`, `eval()`

**Protected paths** — the agent can NEVER modify:
`src/`, `bin/`, `tests/`, `node_modules/`, `.env`, `package.json`

Only files in `server/` are editable.

### Sub-Agents

For complex repairs, wolverine spawns specialized sub-agents that run in sequence or parallel:

| Agent | Access | Model | Role |
|-------|--------|-------|------|
| `explore` | Read+diagnostics | REASONING | Investigate codebase, check env/ports/databases |
| `plan` | Read-only | REASONING | Analyze problem, propose fix strategy |
| `fix` | Read+write+shell | CODING | Execute targeted fix — code edits AND npm install/chmod |
| `verify` | Read-only | REASONING | Check if fix actually works |
| `research` | Read-only | RESEARCH | Search brain + web for solutions |
| `security` | Read-only | AUDIT | Audit code for vulnerabilities |
| `database` | Read+write+SQL | CODING | Database fixes: inspect_db + run_db_fix + SQL skill |

Each sub-agent gets **restricted tools** — the explorer can't write files, the fixer can't search the web. This prevents agents from overstepping their role. Diagnostic tools (check_port, check_env, inspect_db, list_dir) are available to explorers and planners for investigation.

**Workflows:**
- `exploreAndFix()` — explore → plan → fix (sequential, 3 agents)
- `spawnParallel()` — run multiple agents concurrently (e.g., security + explore)

---

## Dashboard

Real-time web UI at `http://localhost:PORT+1`:

| Panel | What it shows |
|-------|--------------|
| **Overview** | Heals, errors, rollbacks, memories, uptime + recent events |
| **Events** | Live SSE event stream with color-coded severity |
| **Performance** | Endpoint response times, request rates, error rates |
| **Command** | Admin chat interface — ask questions or build features |
| **Analytics** | Memory/CPU charts, route health, per-route response times + trends |
| **Backups** | Full backup management: rollback/hot-load buttons, undo, rollback log, admin IP allowlist |
| **Brain** | Vector store stats (23 seed docs), namespace counts, function map |
| **Repairs** | Error/resolution audit trail: error, fix, tokens, cost, duration |
| **Tools** | Agent tool harness listing (10 built-in + MCP) |
| **Usage** | Token analytics: by model, by category, by tool + USD cost per call |

### Command Interface

Three routes (AI-classified per command):

| Route | Model | Tools | When |
|-------|-------|-------|------|
| **SIMPLE** | CHAT_MODEL | None | Knowledge questions, explanations |
| **TOOLS** | TOOL_MODEL | call_endpoint, read_file, search_brain | Live data, file contents |
| **AGENT** | CODING_MODEL | Full 10-tool harness | Build features, fix code |

Secured with `WOLVERINE_ADMIN_KEY` + IP allowlist (localhost + `WOLVERINE_ADMIN_IPS`).

---

## 10-Model Configuration (OpenAI + Anthropic)

Every AI task has its own model slot. Three provider presets in `server/config/settings.json`:

```json
{
  "provider": "hybrid",              // "openai" | "anthropic" | "hybrid"
  "openai_settings": { ... },        // all OpenAI models
  "anthropic_settings": { ... },     // all Anthropic models
  "hybrid_settings": {               // best of both
    "reasoning": "claude-sonnet-4-6",
    "coding": "claude-opus-4-6",
    "tool": "claude-opus-4-6",
    "chat": "claude-haiku-4-5",
    "audit": "gpt-4o-mini",          // cheap OpenAI for bulk scans
    "embedding": "text-embedding-3-small"  // always OpenAI
  }
}
```

Change one line to switch all models: `"provider": "anthropic"`. Or override per-role with env vars.

| Env Variable | Role | Needs Tools? | Example Models |
|---|---|---|---|
| `REASONING_MODEL` | Multi-file agent | Yes | `claude-sonnet-4`, `gpt-5.4` |
| `CODING_MODEL` | Code repair/generation | Yes | `claude-sonnet-4`, `gpt-5.3-codex` |
| `CHAT_MODEL` | Simple text responses | No | `claude-haiku-4`, `gpt-5.4-mini` |
| `TOOL_MODEL` | Chat with function calling | **Yes** | `claude-sonnet-4`, `gpt-4o-mini` |
| `CLASSIFIER_MODEL` | SIMPLE/TOOLS/AGENT routing | No | `claude-haiku-4`, `gpt-4o-mini` |
| `AUDIT_MODEL` | Injection detection (every error) | No | `claude-haiku-4`, `gpt-5.4-nano` |
| `COMPACTING_MODEL` | Text compression for brain | No | `claude-haiku-4`, `gpt-5.4-nano` |
| `RESEARCH_MODEL` | Deep research on failures | No | `claude-opus-4`, `gpt-4o` |
| `TEXT_EMBEDDING_MODEL` | Brain vector embeddings | No | `text-embedding-3-small` (OpenAI only) |

**Notes:**
- Embeddings always use OpenAI (Anthropic doesn't have an embedding API)
- Tools (all 18) work identically on both providers — normalized at the client level
- Telemetry tracks per-model KPIs: latency, success rate, tokens/sec, cost/call
- Usage aggregated by model, category, tool, AND provider (`openai` / `anthropic`)
- Any future model from either provider works automatically — just set the model name

---

## Security

| Layer | What it does |
|-------|-------------|
| **Secret Redactor** | Reads `.env.local`, replaces secret values with `process.env.KEY_NAME` in all AI calls, logs, brain, dashboard |
| **Injection Detector** | Regex layer + AI audit (AUDIT_MODEL) on every error before repair |
| **Sandbox** | All file operations locked to project directory, symlink escape detection |
| **Protected Paths** | Agent blocked from modifying wolverine internals (`src/`, `bin/`, etc.) |
| **Admin Auth** | Dashboard requires key + IP allowlist. Localhost always allowed. Remote IPs via `WOLVERINE_ADMIN_IPS` env var or `POST /api/admin/add-ip` at runtime. Timing-safe comparison, lockout after 10 failures |
| **Rate Limiter** | Sliding window, min gap, hourly budget, exponential backoff on error loops |
| **MCP Security** | Per-server tool allowlists, arg sanitization, result injection scanning |
| **SQL Skill** | `sqlGuard()` blocks 15 injection pattern families; `idempotencyGuard()` prevents double-fire in cluster mode |

---

## Brain (Semantic Memory)

High-performance vector database that grows without slowing down:

- **Function Map** — scans `server/` on startup, indexes all routes, functions, classes, exports
- **Error History** — past errors with context for loop prevention
- **Fix History** — successful and failed repairs with "DO NOT REPEAT" tags
- **Learnings** — research findings, admin commands, patterns discovered
- **Skill Knowledge** — 55+ embedded docs for all skills, best practices, framework knowledge

**Search performance** (scales gracefully):

| Entries | Semantic Search | Keyword (BM25) | Clusters |
|---------|----------------|----------------|----------|
| 100 | 0.2ms | 0.005ms | 10 |
| 1,000 | 0.4ms | 0.01ms | 32 |
| 10,000 | 4.4ms | 0.1ms | 100 |
| 50,000 | 23.7ms | 0.5ms | 224 |

**4 optimization techniques:**
1. **Pre-normalized vectors** — cosine similarity = dot product (no sqrt per query)
2. **IVF index** — k-means++ clustering into √N buckets, probes nearest 20% only
3. **BM25 inverted index** — proper TF-IDF scoring, O(query tokens) not O(N)
4. **Binary persistence** — Float32Array buffers, 10x faster load than JSON

---

## Process Manager

Wolverine acts as a PM2-like process manager with AI-powered diagnostics:

| Feature | What it does |
|---------|-------------|
| **Heartbeat** | Checks if the process is alive every 10 seconds |
| **Memory monitoring** | Tracks RSS/heap, detects leaks (N consecutive growth samples → restart) |
| **Memory limit** | Auto-restart when RSS exceeds threshold (default 512MB, configurable) |
| **CPU tracking** | Samples CPU% with color-coded charting (green/yellow/red) |
| **Route probing** | Auto-discovers ALL routes from function map, probes every 30s |
| **Response time trends** | Per-route avg/min/max + trend detection (stable/degrading/improving) |
| **Frozen detection** | Health check failures trigger force-kill and heal cycle |
| **Auto-adaptation** | When you add new routes, the prober discovers and monitors them |

The `📊 Analytics` dashboard panel shows memory/CPU charts, route health status, and response time breakdowns — all updating in real-time.

---

## Cluster Mode

The server handles its own clustering. Wolverine is the single process manager — it spawns your server, which forks workers internally.

```bash
# Enable cluster mode
WOLVERINE_CLUSTER=true wolverine server/index.js

# System info (cores, RAM, recommended workers)
wolverine --info
```

**How it works:**
```
Wolverine (single process manager)
  └── spawns server/index.js
        ├── WOLVERINE_CLUSTER=false → single server (default)
        └── WOLVERINE_CLUSTER=true  → master forks N workers
             ├── Worker 1 (port 3000, reusePort)
             ├── Worker 2 (port 3000, reusePort)
             └── Worker N (port 3000, reusePort)
```

- **`WOLVERINE_RECOMMENDED_WORKERS`** auto-set based on CPU cores/RAM
- Workers share port 3000 via `reusePort` — OS handles load balancing
- Dead workers auto-respawn by the master process
- Wolverine kills the **entire process tree** on restart (no orphaned workers)
- **Idempotency protection** prevents double-fire across workers (see below)

**System detection:**
- CPU cores, model, speed
- Total/free RAM, disk space
- Platform (Linux, macOS, Windows)
- Container environment (Docker, Kubernetes)
- Cloud provider (AWS, GCP, Azure, Railway, Fly, Render, Heroku)

---

## Token Protection

Three layers prevent token waste:

| Layer | What it catches | Cost |
|-------|----------------|------|
| **Empty stderr guard** | Signal kills, clean shutdowns with no error | $0.00 |
| **Loop guard** | Same error failing 3+ times in 10min → files bug report, stops healing | $0.00 after detection |
| **Global rate limit** | Max 5 heals per 5 minutes regardless of error | Caps total spend |
| **Per-API-call timeout** | 45s timeout on each AI call — prevents indefinite agent hangs | Saves time + tokens |
| **Heal timeout** | 5-minute overall heal timeout via Promise.race | Prevents stuck heals |
| **SIGTERM grace period** | 3s startup grace ignores SIGTERM — prevents restart scripts killing new process | Prevents shutdown loops |

**Process dedup:** PID file ensures only one wolverine instance runs. Kills old process on startup. Exit handler only deletes PID file if it still belongs to current process (prevents race condition on restart).

**Bug reports:** When loop guard triggers, generates a security-scanned report (no secrets/injection patterns) and sends to the platform backend for human review.

---

## Agent Efficiency (claw-code patterns)

| Technique | What it does | Cost |
|-----------|-------------|------|
| **Dynamic system prompt** | Simple errors get 400-token prompt with 7 tools. Complex get 1200 with 18 + fast-fix strategy table | 50% on 70% of heals |
| **Brain namespace isolation** | Seed docs (20K tokens) excluded from error heals — only searched for wolverine queries | 50% context reduction |
| **Prompt caching** | Anthropic system prompt cached server-side — 90% cheaper on repeat calls | 12-16K tokens saved per heal |
| **Tool result truncation** | Tool output capped at 4K chars — prevents context blowup from large reads | Up to 30K saved per turn |
| **Zero-cost compaction** | Extracts structural signals (tools, files, errors) from history — no LLM call | $0.00 |
| **Token estimation** | `text.length / 4` approximation — fast budget checks without tokenizer | 0ms |
| **Error-graceful tools** | Tool errors returned as `[ERROR]` results, not thrown — agent decides next step | More resilient |
| **Pre/post tool hooks** | Shell commands in `.wolverine/hooks.json` — exit 0=allow, 2=deny | Extensible |

**Hook configuration** (`.wolverine/hooks.json`):
```json
{
  "pre_tool_use": ["bash -c 'if [ \"$HOOK_TOOL_NAME\" = \"bash_exec\" ]; then exit 2; fi'"],
  "post_tool_use": ["bash -c 'echo \"Tool: $HOOK_TOOL_NAME\" >> /tmp/audit.log'"]
}
```

---

## Cost Optimization

Wolverine minimizes AI spend through 7 techniques:

| Technique | What it does | Savings |
|-----------|-------------|---------|
| **Smart verification** | Simple errors (TypeError, ReferenceError) skip route probe — trusts syntax+boot, ErrorMonitor is safety net | Prevents $0.29 cascade |
| **Haiku triage** | Sub-agents (explore/plan/verify/research) use cheap classifier model, only fixer uses Sonnet/Opus | 90% on sub-agent cost |
| **Context compacting** | Every 3 agent turns, summarize history to prevent token blowup (95K→20K) | 70-80% on later turns |
| **Cached fix patterns** | Check repair history for identical past fix before calling AI | 100% on repeat errors |
| **Token budget caps** | Simple: 20K, moderate: 50K, complex: 100K agent budget | Caps runaway spend |
| **Prior attempt summaries** | Pass concise "do NOT repeat" directives between iterations, not full context | Reduces baseline tokens |
| **Backup diff context** | AI sees last known good version to revert broken code instead of patching around it | Better fix quality, fewer retries |

**Result:** Simple TypeError heal drops from **$0.31 → $0.02** (15x cheaper).

---

## Configuration

```
.env.local                     ← Secrets only (API keys, admin key)
server/config/settings.json    ← Everything else (models, port, clustering, telemetry, limits)
```

`settings.json` is inside `server/` so the agent can read and edit it. Config loader priority: **env vars > settings.json > defaults**.

---

## Auto-Update

Wolverine checks npm for new versions hourly and upgrades itself automatically. Config files are protected — backed up before update, restored after.

```json
// server/config/settings.json
{
  "autoUpdate": {
    "enabled": true,       // set false to disable
    "intervalMs": 3600000  // check interval (default: 1 hour)
  }
}
```

```bash
# Manual safe update
wolverine --update              # check + upgrade safely
wolverine --update --dry-run    # check only, no changes
wolverine --backups             # list safe backups
wolverine --restore 2026-04-02  # restore from safe backup
```

**How it works:**
1. Creates safe backup in `~/.wolverine-safe-backups/` (outside project, survives everything)
2. Backs up `server/`, `.wolverine/`, `.env` to memory
3. Selectively updates ONLY `src/`, `bin/`, `package.json` (git checkout or npm install)
4. Restores all user files (server code, brain, backups, events, config)
5. Signals brain to merge new seed docs on next boot (append, not replace)
6. Auto-check: 30s after startup, then every 5 minutes (configurable)

**Never run raw `npm install` or `git pull`** — they overwrite server code and brain memories. Always use `wolverine --update` or let auto-update handle it.

- **Disable:** `"autoUpdate": { "enabled": false }` or `WOLVERINE_AUTO_UPDATE=false`

---

## Platform Telemetry

Every wolverine instance automatically broadcasts health data to the analytics platform. **Zero config** — telemetry is on by default.

```
Startup:
  📡 Registering with https://api.wolverinenode.xyz...
  📡 Registered: wlv_a8f3e9b1c4d7
  📡 https://api.wolverinenode.xyz (60s)
```

**How it works:**
- Auto-registers on first run, retries every 60s until platform responds
- Saves key to `.wolverine/platform-key` (survives restarts)
- Sends one ~2KB JSON POST every 60 seconds (5s timeout, non-blocking)
- Payload: `instanceId`, `server`, `process`, `routes`, `repairs`, `usage` (tokens/cost/calls + `byCategory` + `byModel` + `byTool`), `brain`, `backups`
- Platform aggregates across all servers: total tokens/cost by category, model, tool
- Secrets redacted before sending
- Offline-resilient: queues up to 1440 heartbeats locally, drains on reconnect

**Lightweight:** 4 files, ~250 lines. No external dependencies. Key/version cached in memory. Response bodies drained immediately. No blocking, no delays.

**Override:** `WOLVERINE_PLATFORM_URL=https://your-own-platform.com`
**Opt out:** `WOLVERINE_TELEMETRY=false`

Telemetry payload includes: `instanceId`, `server`, `process`, `routes`, `repairs`, `usage` (by category/model/tool), `brain`, `backups`.

---

## Demos

All demos use the `server/` directory pattern. Each demo:
1. Backs up your current `server/`
2. Copies a buggy Express server into `server/`
3. Runs wolverine — you watch it fix the bug in real-time
4. Restores your original `server/` on Ctrl+C

| Demo | Bug | What it tests |
|------|-----|--------------|
| `01-basic-typo` | `userz` → `users` | Fast path, error parser, backup |
| `02-multi-file` | Import name mismatch across files | Agent multi-file understanding |
| `03-syntax-error` | Extra closing paren | Syntax check in verifier |
| `04-secret-leak` | Env var in error output | Secret redaction before AI |
| `05-expired-key` | External service 503 | Human notification system |
| `06-json-config` | Typo in JSON key | Agent edits non-JS files |
| `07-null-crash` | `null.toString()` | Fast path basic repair |

---

## Backup System

All backups stored in **`~/.wolverine-safe-backups/`** — outside the project directory. Survives `git pull`, `npm install`, `rm -rf .wolverine`, even deleting the project entirely.

```
~/.wolverine-safe-backups/
  manifest.json        ← backup registry
  snapshots/           ← heal snapshots (per fix attempt)
  updates/             ← pre-update snapshots (before framework upgrades)
```

- Created before every repair attempt and every framework update (with reason string)
- Created on graceful shutdown (`createShutdownBackup()`)
- Includes all files: `.js`, `.json`, `.sql`, `.db`, `.yaml`, configs
- Old `.wolverine/backups/` auto-migrated to safe location on first run
- **Status lifecycle**: UNSTABLE → VERIFIED (fix passed) → STABLE (30min+ uptime)
- **Retention**: unstable/verified pruned after 7 days, stable keeps 1/day after 7 days
- Protected files never overwritten during rollback: `settings.json`, `db.js`, `.env.local`

```bash
# CLI commands
wolverine --backup "before auth changes"  # create snapshot
wolverine --list-backups                  # show all with status/age
wolverine --rollback mngt8mwb-v0sm        # restore specific backup
wolverine --rollback-latest               # restore most recent
wolverine --undo-rollback                 # undo last rollback
```

**Rollback & Recovery:**

| Action | What it does |
|--------|-------------|
| **Rollback** | Restore any backup — creates a pre-rollback safety backup first, restarts server |
| **Undo Rollback** | Restore the pre-rollback state if the rollback made things worse |
| **Hot-load** | Load any backup as the current server state from the dashboard |
| **Rollback Log** | Full audit trail: timestamp, action, target backup, success/failure |

**Dashboard endpoints** (admin auth required):
- `POST /api/backups/:id/rollback` — rollback to specific backup
- `POST /api/backups/:id/hotload` — hot-load backup as current state
- `POST /api/backups/undo` — undo the last rollback

---

## Skills

Auto-discovered from `src/skills/`. Each skill exports metadata for the registry:

### SQL Skill (`src/skills/sql.js`)
- **sqlGuard()** — Fastify/Express middleware blocking SQL injection (UNION, stacked queries, tautologies, timing attacks, 15 pattern families)
- **SafeDB** — Cluster-safe database with split read/write connections, FIFO write queue, WAL mode
- **idempotencyGuard()** — Prevents double-fire of write requests in cluster mode (see below)
- **db.idempotent(key, fn)** — Database-level dedup for critical writes (payments, orders)
- Auto-injected into agent prompts when building database features

### Dependency Manager (`src/skills/deps.js`)
- **diagnose()** — structured diagnosis of dependency errors before AI runs (zero tokens)
- **healthReport()** — full audit: vulnerabilities, outdated, peer conflicts, unused packages, lock file, health score
- **getMigration()** — known upgrade paths with code transformation patterns:

| From | To | Why |
|------|----|-----|
| `express` | `fastify` | 5.6x faster, async-first, built-in validation |
| `moment` | `dayjs` | Maintenance mode, 70KB → 2KB |
| `request` | `node-fetch` | Deprecated since 2020 |
| `body-parser` | built-in | Included in Express 4.16+ / Fastify |
| callbacks | `async/await` | Cleaner error handling, no callback hell |

Add new skills by creating a file in `src/skills/` with `SKILL_NAME`, `SKILL_DESCRIPTION`, `SKILL_KEYWORDS`, `SKILL_USAGE` exports.

---

## Idempotency (Double-Fire Protection)

In cluster mode, a retry or duplicate request can land on a different worker and execute twice. Two layers prevent this:

### Layer 1: HTTP Middleware

```javascript
const { idempotencyGuard, idempotencyAfterHook } = require("wolverine-ai");

fastify.addHook("preHandler", idempotencyGuard({ db, logger }));
fastify.addHook("onSend", idempotencyAfterHook(db));
```

- Client sends `X-Idempotency-Key: order-abc-123` header
- Without header: auto-generates key from `sha256(method + url + body)`
- First request: executes handler, caches response in shared SQLite table
- Duplicate: returns cached response with `X-Idempotency-Cached: true` header
- Safe methods (GET/HEAD/OPTIONS) always pass through
- Keys expire after 24h (configurable)

### Layer 2: Database-Level

```javascript
const result = await db.idempotent("charge-abc-123", (tx) => {
  tx.run("INSERT INTO charges (id, amount) VALUES (?, ?)", ["abc-123", 99.99]);
  tx.run("UPDATE balance SET amount = amount - ? WHERE user_id = ?", [99.99, 1]);
  return { charged: true };
});
// result.executed = true (first time) or false (duplicate)
```

- Wraps `fn` in a transaction with idempotency key check
- All workers share the `_idempotency` table via WAL mode — globally consistent
- Auto-created on `db.connect()`, pruned via `db.pruneIdempotency()`

---

## MCP Integration

Connect external tools via [Model Context Protocol](https://modelcontextprotocol.io):

```json
// .wolverine/mcp.json
{
  "servers": {
    "datadog": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@datadog/mcp-server"],
      "allowedTools": ["get_metrics", "list_monitors"],
      "enabled": true
    }
  }
}
```

Tools appear as `mcp__datadog__get_metrics` in the agent. All MCP data passes through the security stack (redaction, injection scan, rate limiting).

---

## Usage Tracking

Every API call tracked with input/output tokens + USD cost:

- **By Category**: heal, develop, chat, security, classify, research, brain
- **By Model**: which model costs the most
- **By Tool**: call_endpoint, search_brain, etc.
- **Timeline chart**: color-coded SVG bar chart
- **Persisted**: `.wolverine/usage-history.jsonl` survives restarts
- **Custom pricing**: override in `.wolverine/pricing.json`

---

## Notifications

Errors the AI can't fix trigger human alerts:

| Category | Examples |
|----------|---------|
| **auth** | 401 Unauthorized, expired API key, invalid credentials |
| **billing** | 429 rate limit, quota exceeded, credits depleted |
| **service** | ECONNREFUSED, ENOTFOUND, ETIMEDOUT, 503 |
| **cert** | SSL/TLS errors, self-signed certificate |
| **permission** | EACCES, EPERM |
| **disk** | ENOSPC, ENOMEM |

AI summary generated with CHAT_MODEL, secrets redacted, optional webhook delivery.

---

## License

MIT
