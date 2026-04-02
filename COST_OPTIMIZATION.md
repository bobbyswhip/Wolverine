# Cost Optimization — Wolverine Heal Pipeline

## The Problem

A single demo heal (fix `user.name` on `undefined`) cost **$0.31** across 16 Sonnet calls. The bug was actually fixed on iteration 1 in 4 seconds, but the verifier rejected it, triggering an expensive cascade that burned ~400K tokens accomplishing nothing.

```
Iteration 1: Fast path (Sonnet)     →  Patched correctly  →  Verifier failed  →  $0.02
Iteration 2: Agent (Sonnet, 6 turns) →  119K tokens burned →  Budget exhausted →  $0.15
Iteration 3: Sub-agents (Sonnet x3)  →  200K tokens burned →  Budget exhausted →  $0.12
Research x2: (Sonnet)                →  4K tokens          →  Completed        →  $0.01
Audit x2: (Haiku)                    →  2 calls            →  Completed        →  $0.001
Total: ~$0.31 for a bug that was fixed in iteration 1
```

### Why It Escalated

1. **Fast path patched the file correctly** — syntax OK, boot probe passed
2. **Route probe failed** — the verifier spawns a test process to hit `/breakable`, but that process crashes on `require("@fastify/cors")` because the test env doesn't have all deps loaded
3. **Working fix rolled back** — iteration 1 marked as failed
4. **Agent path triggered** — 6 turns of Sonnet conversation, each turn the context grows (15K → 30K → 49K → 71K → 95K → 119K per turn)
5. **Sub-agents triggered** — 3 separate Sonnet sessions, each starting fresh but burning 50-100K tokens exploring/planning/fixing the same simple bug
6. **All 3 iterations failed** — not because the fix was wrong, but because the verifier can't test it

## Recommended Fixes

### 1. Fix the Route Verifier (Eliminates 95% of Wasted Cost)

The route probe spawns a bare `node server/index.js` to test the route. This fails when `index.js` has deps that aren't available in the test context.

**Fix:** The verifier should test ONLY the changed file in isolation, not boot the entire server.

```js
// Current: boots full server to test route
// Fails when index.js has complex deps
const testProc = spawn("node", ["server/index.js"]);
await hit(`http://localhost:${port}/breakable`);

// Better: test the changed file directly
// For a module that exports a function:
const testCode = `
  try {
    delete require.cache[require.resolve("${changedFile}")];
    const mod = require("${changedFile}");
    if (typeof mod === "function") { mod(); console.log("OK"); }
    else { console.log("OK — module loaded"); }
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
`;
const result = execSync(`node -e '${testCode}'`, { cwd });
```

If this had worked, iteration 1 would have succeeded and the heal would have cost **$0.02 instead of $0.31**.

### 2. Compact Context Between Agent Turns

The agent's context grows linearly with each turn. By turn 6, Sonnet is processing 95K tokens of history to generate a 5K response. Most of that history is redundant — tool results from earlier turns that are no longer relevant.

**Fix:** After every 3 turns, compact the conversation:

```js
// In agent-engine.js, before sending to AI:
if (turnCount > 0 && turnCount % 3 === 0) {
  // Summarize prior turns into a single message
  const summary = await compact(messages.slice(0, -2), compactingModel);
  messages = [
    { role: "system", content: systemPrompt },
    { role: "assistant", content: `Previous work summary:\n${summary}` },
    ...messages.slice(-2), // keep last exchange
  ];
}
```

**Impact:** Instead of 95K→119K on turns 5-6, the context would be ~20K. Each turn costs roughly `tokens × $/1K`, so compacting saves 70-80% on later turns.

**Use Haiku for compacting** — it's $0.0005/call vs $0.01+ for Sonnet. The summary doesn't need to be creative, just accurate.

### 3. Clear Context Between Iterations

When iteration 1 fails and iteration 2 starts, the agent gets a fresh conversation but carries forward the full error context + brain context + research context. This baseline is already 10-15K tokens before the agent does anything.

**Fix:** Between iterations, summarize what was tried and why it failed into a single paragraph:

```js
// Before starting iteration N+1:
const priorAttemptSummary = `
  Attempt ${n}: Tried ${mode} fix on ${file}:${line}.
  Fix applied: ${patchDescription}.
  Failed because: ${failureReason}.
  Do NOT repeat this approach.
`;
// Pass only this summary, not the full prior context
```

### 4. Use Haiku for Triage, Sonnet for Fixing

Most of the 16 Sonnet calls were not fixing code — they were reading files, exploring the codebase, planning, and researching. These don't need Sonnet.

**Recommended model assignment by task:**

| Task | Current | Recommended | Why |
|------|---------|-------------|-----|
| Audit/injection scan | Haiku | Haiku | Pattern matching, cheap |
| Classifier | Haiku | Haiku | Routing decision, cheap |
| File reading/exploration | Sonnet | **Haiku** | Just reading, no reasoning needed |
| Research | Sonnet | **Haiku** | Summarization task |
| Compacting | Haiku | Haiku | Summarization task |
| Planning | Sonnet | **Haiku** | Simple plan for simple bugs |
| **Code generation** | Sonnet | **Sonnet** | Needs reasoning for correct fix |
| **Complex multi-file** | Sonnet | **Sonnet** | Needs deep understanding |

This means the `explore` and `plan` sub-agents should use Haiku, not Sonnet. Only the `fix` sub-agent needs Sonnet.

```js
// sub-agents.js
explore:  { model: "classifier", maxTurns: 5,  maxTokens: 15000 },  // Haiku
plan:     { model: "classifier", maxTurns: 3,  maxTokens: 10000 },  // Haiku
fix:      { model: "coding",    maxTurns: 5,  maxTokens: 50000 },  // Sonnet
verify:   { model: "classifier", maxTurns: 3,  maxTokens: 8000 },   // Haiku
research: { model: "classifier", maxTurns: 3,  maxTokens: 10000 },  // Haiku
```

**Impact:** explore + plan + research = 6 calls × Haiku ($0.001/call) instead of 6 calls × Sonnet ($0.02/call) = **$0.006 vs $0.12**.

### 5. Early Exit on Simple Fixes

If the fast path patches a file and syntax check passes, and the error was a simple TypeError/ReferenceError (not a logic bug), skip the route probe and just restart.

```js
// In wolverine.js, after fast path patch:
const isSimpleError = /TypeError|ReferenceError|SyntaxError/.test(errorMessage);
if (isSimpleError && verification.syntaxOk && verification.bootOk) {
  // Trust the fix — skip route probe
  // If it's still broken, the ErrorMonitor will catch it again
  return { healed: true, mode: "fast", trusted: true };
}
```

The ErrorMonitor is already watching — if the fix doesn't work, it'll trigger another heal in 30 seconds. This is cheaper than running the route probe (which is what's failing anyway).

### 6. Token Budget Caps by Error Complexity

Not every error needs 100K+ tokens. A simple `undefined.name` TypeError should cap at 20K total. A complex multi-file logic bug can get more.

```js
function getTokenBudget(error) {
  const simple = /TypeError|ReferenceError|SyntaxError|Cannot find module/.test(error);
  const moderate = /ECONNREFUSED|timeout|ENOENT/.test(error);

  if (simple) return { fast: 5000, agent: 20000, subAgent: 10000 };
  if (moderate) return { fast: 10000, agent: 50000, subAgent: 30000 };
  return { fast: 15000, agent: 100000, subAgent: 50000 }; // complex
}
```

### 7. Cache Fix Patterns

The brain already stores past fixes. But the agent doesn't check if an identical error was already fixed before burning tokens on exploration.

**Fix:** Before starting ANY iteration, check if this exact error signature has a recorded successful fix:

```js
const cachedFix = await brain.search("fixes", errorSignature);
if (cachedFix && cachedFix.success) {
  // Try applying the same fix directly — no AI call needed
  const patch = cachedFix.patch;
  applyPatch(patch);
  const verified = await verifyFix();
  if (verified) return { healed: true, mode: "cached", cost: 0 };
}
```

**Impact:** Second occurrence of the same bug = $0.00 instead of $0.31.

---

## Projected Cost After Fixes

| Scenario | Current | After Fixes |
|----------|---------|-------------|
| Simple TypeError (first time) | $0.31 | **$0.02** (fast path succeeds) |
| Simple TypeError (repeat) | $0.31 | **$0.00** (cached fix) |
| Multi-file logic bug | $0.31+ | **$0.08** (Haiku triage + Sonnet fix) |
| Module not found | $0.05 | **$0.00** (operational fix, no AI) |

### Priority Order

1. **Fix route verifier** — biggest bang, eliminates the cascade entirely
2. **Early exit on simple fixes** — fast path already works, just trust it
3. **Haiku for triage** — 90% cost reduction on explore/plan/research
4. **Context compacting** — prevents token blowup on agent turns
5. **Cache fix patterns** — eliminates repeat costs
6. **Token caps by complexity** — prevents simple bugs from burning complex budgets
7. **Clear context between iterations** — reduces baseline token load
