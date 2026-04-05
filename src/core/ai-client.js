const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const chalk = require("chalk");
const { getModel, detectProvider } = require("./models");

let _openaiClient = null;
let _anthropicClient = null;
let _wolverineClient = null;
let _tracker = null;

function setTokenTracker(tracker) { _tracker = tracker; }
function getTrackerSnapshot() {
  if (!_tracker) return { tokens: 0, cost: 0, calls: 0 };
  return { tokens: _tracker._totalTokens || 0, cost: _tracker._totalCostUsd || 0, calls: _tracker._totalCalls || 0 };
}

function _extractTokens(usage) {
  if (!usage) return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  return {
    input: usage.prompt_tokens || usage.input_tokens || 0,
    output: usage.completion_tokens || usage.output_tokens || 0,
    // Anthropic cache fields
    cacheCreation: usage.cache_creation_input_tokens || usage.cache_write_tokens || 0,
    // OpenAI prompt_tokens_details.cached_tokens + Anthropic cache_read_input_tokens
    cacheRead: usage.cache_read_input_tokens || usage.cache_read_tokens
      || usage.prompt_tokens_details?.cached_tokens || 0,
  };
}

function _track(model, category, usage, tool, latencyMs, success) {
  if (!_tracker) return;
  const { input, output, cacheCreation, cacheRead } = _extractTokens(usage);
  _tracker.record(model, category, input, output, tool, latencyMs, success, cacheCreation, cacheRead);
}

function _trackEmbedding(model, usage, latencyMs, success) {
  if (!_tracker) return;
  const input = usage?.prompt_tokens || usage?.total_tokens || 0;
  _tracker.record(model, "embedding", input, 0, null, latencyMs, success, 0, 0);
}

function _trackOp(model, category, inputTokens, outputTokens, tool, latencyMs, success) {
  if (!_tracker) return;
  _tracker.record(model, category, inputTokens || 0, outputTokens || 0, tool || null, latencyMs || 0, success, 0, 0);
}

// ── Client Management ──

function getClient(provider) {
  if (provider === "anthropic") return _getAnthropicClient();
  if (provider === "wolverine") return _getWolverineClient();
  return _getOpenAIClient();
}

let _wolverineDirectClient = null;

function _getWolverineClient() {
  if (!_wolverineClient) {
    const apiKey = process.env.WOLVERINE_API_KEY || process.env.WOLVERINE_GPU_KEY || "none";
    const baseURL = process.env.WOLVERINE_INFERENCE_URL
      ? process.env.WOLVERINE_INFERENCE_URL + "/v1"
      : "https://api.wolverinenode.xyz/v1";
    _wolverineClient = new OpenAI({ apiKey, baseURL });
  }
  return _wolverineClient;
}

// Direct GPU client — bypasses billing proxy. Used as fallback when proxy is down.
function _getWolverineDirectClient() {
  if (!_wolverineDirectClient && process.env.WOLVERINE_GPU_URL && process.env.WOLVERINE_GPU_KEY) {
    _wolverineDirectClient = new OpenAI({
      apiKey: process.env.WOLVERINE_GPU_KEY,
      baseURL: process.env.WOLVERINE_GPU_URL + "/v1",
    });
  }
  return _wolverineDirectClient;
}

function _getOpenAIClient() {
  if (!_openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Add it to .env.local");
    _openaiClient = new OpenAI({ apiKey });
  }
  return _openaiClient;
}

function _getAnthropicClient() {
  if (!_anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local");
    _anthropicClient = new Anthropic({ apiKey });
  }
  return _anthropicClient;
}

// ── Model Detection Helpers ──

function isResponsesModel(model) { return /codex/i.test(model); }

function isReasoningModel(model) {
  return /^o[1-9]|^gpt-5-nano|^gpt-5\.4-nano/.test(model);
}

function isAnthropicModel(model) { return detectProvider(model) === "anthropic"; }
function isWolverineModel(model) { return detectProvider(model) === "wolverine"; }

/**
 * Per-model max output token limits (with 10% overestimation buffer).
 * These are the actual API limits — requesting more than this fails.
 */
const MODEL_OUTPUT_LIMITS = {
  // OpenAI — generous output limits
  "gpt-4o":              17600,  // 16384 + 10%
  "gpt-4o-mini":         17600,
  "gpt-5":               17600,
  "gpt-5.4":             17600,
  "gpt-5.4-mini":        17600,
  "gpt-5.4-nano":        17600,
  "gpt-5-nano":          17600,
  "o1":                  110000, // 100k + 10% (reasoning model, huge output)
  "o1-mini":             72600,  // 66k + 10%
  "o3":                  110000,
  "o3-mini":             72600,
  "o4-mini":             72600,
  "gpt-5.1-codex":       17600,
  "gpt-5.3-codex":       17600,
  "codex-mini":          17600,
  // Anthropic — each tier has different output limits
  "claude-opus-4":       32000,  // 32k max output (no buffer needed, already generous)
  "claude-sonnet-4":     17600,  // 16k + 10%
  "claude-haiku-4":      8800,   // 8k + 10%
  "claude-3-5-sonnet":   8800,
  "claude-3-5-haiku":    8800,
  "claude-3-opus":       4400,   // 4k + 10%
  "claude-3-sonnet":     4400,
  "claude-3-haiku":      4400,
};

/**
 * Get the max output tokens for a model (with 10% buffer).
 * Falls back to sensible defaults if model not in table.
 */
function _getOutputLimit(model) {
  // Exact match
  if (MODEL_OUTPUT_LIMITS[model]) return MODEL_OUTPUT_LIMITS[model];
  // Prefix match (handles dated versions like claude-sonnet-4-6, claude-haiku-4-5-20250414)
  for (const [prefix, limit] of Object.entries(MODEL_OUTPUT_LIMITS)) {
    if (model.startsWith(prefix)) return limit;
  }
  // Defaults with 10% buffer
  if (isAnthropicModel(model)) return 8800;   // 8k + 10% (safe Anthropic default)
  return 17600;                                // 16k + 10% (safe OpenAI default)
}

/**
 * Build token limit params for the API call.
 * Respects per-model output limits and adds reasoning headroom.
 */
function tokenParam(model, limit) {
  const maxOutput = _getOutputLimit(model);

  // Reasoning models get 4x to accommodate chain-of-thought, but capped at model max
  let effectiveLimit = isReasoningModel(model) ? Math.max(limit * 4, 4096) : limit;
  effectiveLimit = Math.min(effectiveLimit, maxOutput);

  // Anthropic uses max_tokens directly (handled in _anthropicCall)
  if (isAnthropicModel(model)) return { max_tokens: effectiveLimit };
  if (isResponsesModel(model)) return { max_output_tokens: effectiveLimit };
  // All modern OpenAI models use max_completion_tokens (max_tokens is deprecated)
  return { max_completion_tokens: effectiveLimit };
}

/**
 * Build OpenAI-specific params for reasoning models (o-series).
 * - reasoning_effort: controls compute allocation (low/medium/high)
 * - No temperature/top_p (forbidden on o-series)
 */
function _reasoningParams(model) {
  if (!isReasoningModel(model)) return {};
  // Default to medium effort — balances cost vs quality
  // High effort for complex multi-file debugging, low for classification
  return { reasoning_effort: process.env.WOLVERINE_REASONING_EFFORT || "medium" };
}

/**
 * Retry with exponential backoff + jitter for rate limits.
 */
async function _withRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = (err.message || "").toLowerCase();
      const code = (err.code || "").toLowerCase();

      // Permanent billing/quota errors — never retry, surface immediately
      const isBillingError = err.status === 402
        || /insufficient.*(quota|credits|funds)/i.test(msg)
        || /billing_hard_limit|insufficient_quota|quota_exceeded/i.test(msg)
        || /billing_hard_limit|insufficient_quota|quota_exceeded/i.test(code);
      if (isBillingError) {
        console.log(chalk.red(`  💳 Billing error (not retrying): ${err.message}`));
        throw err;
      }

      const isRateLimit = err.status === 429 || code === "rate_limit_exceeded";
      const isServerError = err.status >= 500;
      if ((isRateLimit || isServerError) && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 30000);
        console.log(chalk.yellow(`  ⏱️ API ${isRateLimit ? "rate limited" : "error"} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})`));
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ── Unified AI Call ──
// Routes to OpenAI or Anthropic based on model name. Returns same shape regardless.

async function aiCall({ model, systemPrompt, userPrompt, maxTokens = 2048, tools, toolChoice, category = "chat", tool }) {
  const provider = detectProvider(model);
  const startMs = Date.now();
  let result;

  try {
    if (provider === "anthropic") {
      result = await _anthropicCall({ model, systemPrompt, userPrompt, maxTokens, tools, toolChoice });
    } else if (provider === "wolverine") {
      try {
        result = await _chatCall(_getWolverineClient(), { model, systemPrompt, userPrompt, maxTokens, tools, toolChoice });
      } catch (proxyErr) {
        // If billing proxy is down (server crashing), fall back to direct GPU
        const isConnErr = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|Connection error/i.test(proxyErr.message || "");
        const directClient = _getWolverineDirectClient();
        if (isConnErr && directClient) {
          console.log(chalk.yellow("  ⚠️  Billing proxy down — using direct GPU (unbilled)"));
          result = await _chatCall(directClient, { model, systemPrompt, userPrompt, maxTokens, tools, toolChoice });
        } else {
          throw proxyErr;
        }
      }
    } else if (isResponsesModel(model)) {
      result = await _responsesCall(_getOpenAIClient(), { model, systemPrompt, userPrompt, maxTokens, tools });
    } else {
      result = await _chatCall(_getOpenAIClient(), { model, systemPrompt, userPrompt, maxTokens, tools, toolChoice });
    }

    const latencyMs = Date.now() - startMs;
    _track(model, category, result.usage, tool, latencyMs, true);
    return result;
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    _track(model, category, {}, tool, latencyMs, false);
    throw err;
  }
}

async function aiCallWithHistory({ model, messages, tools, maxTokens = 4096, category = "chat", tool }) {
  const provider = detectProvider(model);
  const startMs = Date.now();
  let result;

  try {
    if (provider === "anthropic") {
      result = await _anthropicCallWithHistory({ model, messages, tools, maxTokens });
    } else if (provider === "wolverine") {
      try {
        result = await _chatCallWithHistory(_getWolverineClient(), { model, messages, tools, maxTokens });
      } catch (proxyErr) {
        const isConnErr = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|Connection error/i.test(proxyErr.message || "");
        const directClient = _getWolverineDirectClient();
        if (isConnErr && directClient) {
          console.log(chalk.yellow("  ⚠️  Billing proxy down — using direct GPU (unbilled)"));
          result = await _chatCallWithHistory(directClient, { model, messages, tools, maxTokens });
        } else {
          throw proxyErr;
        }
      }
    } else if (isResponsesModel(model)) {
      result = await _responsesCallWithHistory(_getOpenAIClient(), { model, messages, tools, maxTokens });
    } else {
      result = await _chatCallWithHistory(_getOpenAIClient(), { model, messages, tools, maxTokens });
    }

    const latencyMs = Date.now() - startMs;
    _track(model, category, result.usage, tool, latencyMs, true);
    return result;
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    _track(model, category, {}, tool, latencyMs, false);
    throw err;
  }
}

// ── Anthropic Implementation ──
// Normalizes Anthropic's response format to match our {content, toolCalls, usage} interface.

async function _anthropicCall({ model, systemPrompt, userPrompt, maxTokens, tools, toolChoice }) {
  const client = _getAnthropicClient();
  const outputLimit = Math.min(maxTokens, _getOutputLimit(model));

  const params = {
    model,
    max_tokens: outputLimit,
    messages: [{ role: "user", content: userPrompt }],
  };

  // Prompt caching: mark system prompt for Anthropic's server-side cache.
  // Same system prompt across agent turns gets cached after first call — 90% cheaper.
  if (systemPrompt) {
    params.system = [{
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral" },
    }];
  }

  if (tools && tools.length > 0) {
    params.tools = tools.map(_toAnthropicTool).filter(Boolean);
    if (toolChoice === "required") params.tool_choice = { type: "any" };
    else if (toolChoice && toolChoice !== "auto") params.tool_choice = { type: "auto" };
  }

  const response = await _withRetry(() => client.messages.create(params));
  return _normalizeAnthropicResponse(response);
}

async function _anthropicCallWithHistory({ model, messages, tools, maxTokens }) {
  const client = _getAnthropicClient();

  // Extract system message and convert rest to Anthropic format
  let systemPrompt = "";
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt += (systemPrompt ? "\n" : "") + msg.content;
      continue;
    }
    if (msg.role === "user") {
      anthropicMessages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant message with tool calls
        const content = [];
        if (msg.content) content.push({ type: "text", text: msg.content });
        for (const tc of msg.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || "{}"),
          });
        }
        anthropicMessages.push({ role: "assistant", content });
      } else {
        anthropicMessages.push({ role: "assistant", content: msg.content || "" });
      }
    } else if (msg.role === "tool") {
      // Tool result → Anthropic tool_result block
      anthropicMessages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: msg.content,
        }],
      });
    }
  }

  // Merge consecutive same-role messages (Anthropic requires alternating roles)
  const merged = [];
  for (const msg of anthropicMessages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      const prev = merged[merged.length - 1];
      if (typeof prev.content === "string" && typeof msg.content === "string") {
        prev.content += "\n" + msg.content;
      } else {
        // Convert to array format and merge
        const prevArr = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: prev.content }];
        const msgArr = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
        prev.content = [...prevArr, ...msgArr];
      }
    } else {
      merged.push({ ...msg });
    }
  }

  const outputLimit = Math.min(maxTokens, _getOutputLimit(model));
  const params = {
    model,
    max_tokens: outputLimit,
    messages: merged,
  };

  // Prompt caching for multi-turn: system prompt cached across all turns
  if (systemPrompt) {
    params.system = [{
      type: "text",
      text: systemPrompt,
      cache_control: { type: "ephemeral" },
    }];
  }

  if (tools && tools.length > 0) {
    params.tools = tools.map(_toAnthropicTool).filter(Boolean);
  }

  const response = await _withRetry(() => client.messages.create(params));

  // Return in chat-compatible format
  const normalized = _normalizeAnthropicResponse(response);
  const message = { role: "assistant", content: normalized.content || null };
  if (normalized.toolCalls) message.tool_calls = normalized.toolCalls;

  return {
    choices: [{ message }],
    usage: normalized.usage,
  };
}

/**
 * Convert OpenAI tool definition to Anthropic format.
 */
function _toAnthropicTool(tool) {
  if (tool.type === "function" && tool.function) {
    return {
      name: tool.function.name,
      description: tool.function.description || "",
      input_schema: tool.function.parameters || { type: "object", properties: {} },
      // strict: true guarantees Claude's output always matches schema — no malformed JSON
    };
  }
  return null;
}

/**
 * Normalize Anthropic response to our standard {content, toolCalls, usage} shape.
 */
function _normalizeAnthropicResponse(response) {
  let content = "";
  let toolCalls = null;

  for (const block of (response.content || [])) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "tool_use") {
      if (!toolCalls) toolCalls = [];
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  return {
    content: content.trim(),
    toolCalls,
    usage: {
      input_tokens: response.usage?.input_tokens || 0,
      output_tokens: response.usage?.output_tokens || 0,
      prompt_tokens: response.usage?.input_tokens || 0,
      completion_tokens: response.usage?.output_tokens || 0,
    },
    _raw: response,
  };
}

// ── OpenAI: Responses API ──

async function _responsesCall(openai, { model, systemPrompt, userPrompt, maxTokens, tools }) {
  const params = {
    model,
    input: [
      ...(systemPrompt ? [{ role: "developer", content: systemPrompt }] : []),
      { role: "user", content: userPrompt },
    ],
    max_output_tokens: maxTokens,
  };

  if (tools && tools.length > 0) {
    params.tools = tools.map(t => {
      if (t.type === "function" && t.function) {
        return { type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: true };
      }
      return t;
    });
  }

  const response = await _withRetry(() => openai.responses.create(params));
  let content = "";
  let toolCalls = null;

  if (response.output) {
    for (const item of response.output) {
      if (item.type === "message" && item.content) {
        for (const block of item.content) { if (block.type === "output_text") content += block.text; }
      } else if (item.type === "function_call") {
        if (!toolCalls) toolCalls = [];
        toolCalls.push({ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: item.arguments } });
      }
    }
  }
  if (!content && response.output_text) content = response.output_text;

  return { content: content.trim(), toolCalls, usage: response.usage || {}, _raw: response };
}

// ── OpenAI: Chat Completions ──

async function _chatCall(openai, { model, systemPrompt, userPrompt, maxTokens, tools, toolChoice }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  const noTemp = /^(o[1-9]|gpt-5)/.test(model);
  const isWolverine = detectProvider(model) === "wolverine";
  const params = {
    model, messages,
    ...(!noTemp ? { temperature: 0 } : {}),
    ...tokenParam(model, maxTokens),
    ..._reasoningParams(model),
    // Prompt caching: llama.cpp reuses KV cache for identical prefixes
    ...(isWolverine ? { cache_prompt: true } : {}),
  };

  if (tools && tools.length > 0) {
    params.tools = tools;
    params.tool_choice = toolChoice || "auto";
    params.parallel_tool_calls = false;
  }

  const response = await _withRetry(() => openai.chat.completions.create(params));
  const choice = response.choices[0];
  return {
    content: (choice.message.content || "").trim(),
    toolCalls: choice.message.tool_calls || null,
    usage: response.usage || {},
    _raw: response,
    _message: choice.message,
  };
}

// ── OpenAI: Multi-turn (Responses + Chat) ──

async function _responsesCallWithHistory(openai, { model, messages, tools, maxTokens }) {
  const input = messages.map(msg => {
    if (msg.role === "system") return { role: "developer", content: msg.content };
    if (msg.role === "tool") return { type: "function_call_output", call_id: msg.tool_call_id, output: msg.content };
    if (msg.role === "assistant" && msg.tool_calls) {
      return msg.tool_calls.map(tc => ({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
    }
    if (msg.role === "assistant") return { role: "assistant", content: msg.content || "" };
    return { role: msg.role, content: msg.content };
  }).flat();

  const params = { model, input, max_output_tokens: maxTokens };
  if (tools && tools.length > 0) {
    params.tools = tools.map(t => {
      if (t.type === "function" && t.function) {
        return { type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: true };
      }
      return t;
    });
  }

  const response = await _withRetry(() => openai.responses.create(params));
  let content = "";
  let toolCalls = null;

  if (response.output) {
    for (const item of response.output) {
      if (item.type === "message" && item.content) { for (const block of item.content) { if (block.type === "output_text") content += block.text; } }
      else if (item.type === "function_call") { if (!toolCalls) toolCalls = []; toolCalls.push({ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: item.arguments } }); }
    }
  }
  if (!content && response.output_text) content = response.output_text;

  const message = { role: "assistant", content: content.trim() || null };
  if (toolCalls) message.tool_calls = toolCalls;
  return { choices: [{ message }], usage: response.usage || {} };
}

async function _chatCallWithHistory(openai, { model, messages, tools, maxTokens }) {
  const noTemp = /^(o[1-9]|gpt-5)/.test(model);
  const isWolverine = detectProvider(model) === "wolverine";
  const params = {
    model, messages,
    ...(!noTemp ? { temperature: 0 } : {}),
    ...tokenParam(model, maxTokens),
    ..._reasoningParams(model),
    // Prompt caching: llama.cpp KV cache reuse for multi-turn agent conversations
    ...(isWolverine ? { cache_prompt: true } : {}),
  };
  if (tools && tools.length > 0) {
    params.tools = tools;
    params.tool_choice = "auto";
    params.parallel_tool_calls = false;
  }
  return _withRetry(() => openai.chat.completions.create(params));
}

// ── Fast Path Repair ──

async function requestRepair({ filePath, sourceCode, backupSourceCode, errorMessage, stackTrace, extraContext }) {
  const model = getModel("coding");
  const systemPrompt = "You are a Node.js debugging expert. Respond with ONLY valid JSON, no markdown fences.";
  const userPrompt = `A server crashed with the following error. Analyze and produce a fix.

## File: ${filePath}

\`\`\`javascript
${sourceCode}
\`\`\`

## Error Message
\`\`\`
${errorMessage}
\`\`\`

## Stack Trace
\`\`\`
${stackTrace}
\`\`\`

${backupSourceCode ? `## Last Known Working Version\n\`\`\`javascript\n${backupSourceCode}\n\`\`\`\n\nCompare the current broken code with this working version. If the broken code added something that doesn't work, REVERT that addition rather than patching around it.\n` : ""}${extraContext || ""}## Instructions
1. Identify the root cause of the error.
2. Not all errors are code bugs. Choose the correct fix type:
   - "Cannot find module 'X'" (not starting with ./ or ../) = missing npm package → use "commands" to npm install
   - "Cannot find module './X'" = wrong import path → use "changes" to fix the require/import
   - "ENOENT" = missing file → use "commands" to create it, or "changes" to fix the path
   - SyntaxError/TypeError/ReferenceError = code bug → use "changes" to fix the code
3. Respond with ONLY valid JSON in this exact format:

{
  "explanation": "Brief explanation of what went wrong and what the fix does",
  "changes": [
    {
      "file": "the file path",
      "old": "the exact lines to replace (copy verbatim from the source)",
      "new": "the replacement lines"
    }
  ],
  "commands": ["npm install cors", "mkdir -p server/config"]
}

"commands" is an array of shell commands to run (optional, use for npm install, file creation, etc).
"changes" is for code edits (optional, use for actual code fixes).
Include both if needed, or just one.`;

  const result = await aiCall({ model, systemPrompt, userPrompt, maxTokens: 2048, category: "reasoning" });
  const content = (result.content || "").trim();

  // Guard: cap length before regex extraction to prevent catastrophic backtracking
  if (content.length > 50000) {
    throw new Error("AI response too large for regex extraction (>50K chars)");
  }

  // Strip thinking tags (Gemma), markdown fences, and any prefix text
  let cleaned = content
    .replace(/<\|channel>.*?<channel\|>/gs, "")
    .replace(/<\|think\|>[\s\S]*?<\|\/think\|>/g, "")
    .replace(/^```(?:json)?\s*/gm, "")
    .replace(/```\s*$/gm, "")
    .trim();

  // Extract JSON object from response
  const jsonMatch = cleaned.match(/\{[\s\S]*"(?:explanation|changes|commands)"[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];

  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: try to find any JSON object
    const anyJson = cleaned.match(/\{[\s\S]*\}/);
    if (anyJson) try { return JSON.parse(anyJson[0]); } catch {}
    throw new Error(`AI response was not valid JSON`);
  }
}

module.exports = { requestRepair, getClient, tokenParam, aiCall, aiCallWithHistory, isResponsesModel, isAnthropicModel, setTokenTracker, getTrackerSnapshot, detectProvider, _trackEmbedding, _trackOp };
