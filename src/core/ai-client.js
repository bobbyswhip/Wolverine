const OpenAI = require("openai");
const { getModel } = require("./models");

let client = null;
let _tracker = null;

/**
 * Set the global token tracker. Called once from runner on startup.
 */
function setTokenTracker(tracker) { _tracker = tracker; }

/**
 * Extract token counts from any OpenAI response usage object.
 */
function _extractTokens(usage) {
  if (!usage) return { input: 0, output: 0 };
  return {
    input: usage.prompt_tokens || usage.input_tokens || 0,
    output: usage.completion_tokens || usage.output_tokens || 0,
  };
}

/**
 * Track a call if tracker is set.
 */
function _track(model, category, usage, tool) {
  if (!_tracker) return;
  const { input, output } = _extractTokens(usage);
  _tracker.record(model, category, input, output, tool);
}

function getClient() {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Add it to .env.local or set it as an environment variable."
      );
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

/**
 * Detect if a model uses the Responses API vs Chat Completions.
 * Codex models and some newer models use /v1/responses.
 */
function isResponsesModel(model) {
  return /codex/i.test(model);
}

/**
 * Detect if a model uses internal reasoning tokens (o-series, gpt-5-nano, etc.)
 * These models need higher token limits because reasoning consumes most of the budget.
 */
function isReasoningModel(model) {
  return /^o[1-9]|^gpt-5-nano|^gpt-5\.4-nano/.test(model);
}

/**
 * Build the token limit param for Chat Completions API.
 * Reasoning models get 4x the limit to accommodate thinking tokens.
 */
function tokenParam(model, limit) {
  // Reasoning models need headroom for chain-of-thought
  const effectiveLimit = isReasoningModel(model) ? Math.max(limit * 4, 4096) : limit;

  if (isResponsesModel(model)) {
    return { max_output_tokens: effectiveLimit };
  }
  const usesNewParam = /^(o[1-9]|gpt-5|gpt-4o)/.test(model) || model.includes("nano");
  if (usesNewParam) {
    return { max_completion_tokens: effectiveLimit };
  }
  return { max_tokens: limit };
}

/**
 * Unified AI call — automatically routes to Responses API or Chat Completions
 * based on the model name.
 *
 * @param {object} params
 * @param {string} params.model - Model name
 * @param {string} params.systemPrompt - System/instructions prompt
 * @param {string} params.userPrompt - User message
 * @param {number} params.maxTokens - Max response tokens
 * @param {Array}  params.tools - Tool definitions (optional)
 * @param {string} params.toolChoice - Tool choice strategy (optional)
 * @returns {{ content: string, toolCalls: Array|null, usage: object }}
 */
async function aiCall({ model, systemPrompt, userPrompt, maxTokens = 2048, tools, toolChoice, category = "chat", tool }) {
  const openai = getClient();

  let result;
  if (isResponsesModel(model)) {
    result = await _responsesCall(openai, { model, systemPrompt, userPrompt, maxTokens, tools });
  } else {
    result = await _chatCall(openai, { model, systemPrompt, userPrompt, maxTokens, tools, toolChoice });
  }

  _track(model, category, result.usage, tool);
  return result;
}

/**
 * Responses API call — for codex and responses-only models.
 */
async function _responsesCall(openai, { model, systemPrompt, userPrompt, maxTokens, tools }) {
  const params = {
    model,
    input: [
      ...(systemPrompt ? [{ role: "developer", content: systemPrompt }] : []),
      { role: "user", content: userPrompt },
    ],
    max_output_tokens: maxTokens,
  };

  // Convert chat-style tools to responses-style tools
  if (tools && tools.length > 0) {
    params.tools = tools.map(t => {
      if (t.type === "function" && t.function) {
        // Chat Completions style → Responses style
        return {
          type: "function",
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
          strict: true,
        };
      }
      return t;
    });
  }

  const response = await openai.responses.create(params);

  // Extract text content and tool calls from response output
  let content = "";
  let toolCalls = null;

  if (response.output) {
    for (const item of response.output) {
      if (item.type === "message" && item.content) {
        for (const block of item.content) {
          if (block.type === "output_text") {
            content += block.text;
          }
        }
      } else if (item.type === "function_call") {
        if (!toolCalls) toolCalls = [];
        toolCalls.push({
          id: item.call_id || item.id,
          type: "function",
          function: {
            name: item.name,
            arguments: item.arguments,
          },
        });
      }
    }
  }

  // Fallback: some responses have output_text directly
  if (!content && response.output_text) {
    content = response.output_text;
  }

  return {
    content: content.trim(),
    toolCalls,
    usage: response.usage || {},
    _raw: response,
  };
}

/**
 * Chat Completions API call — for standard chat models.
 */
async function _chatCall(openai, { model, systemPrompt, userPrompt, maxTokens, tools, toolChoice }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  // Some models (gpt-5-nano, o-series) don't support temperature
  const noTemp = /^(o[1-9]|gpt-5)/.test(model);

  const params = {
    model,
    messages,
    ...(!noTemp ? { temperature: 0 } : {}),
    ...tokenParam(model, maxTokens),
  };

  if (tools && tools.length > 0) {
    params.tools = tools;
    params.tool_choice = toolChoice || "auto";
  }

  const response = await openai.chat.completions.create(params);
  const choice = response.choices[0];

  return {
    content: (choice.message.content || "").trim(),
    toolCalls: choice.message.tool_calls || null,
    usage: response.usage || {},
    _raw: response,
    _message: choice.message,
  };
}

/**
 * Build a Responses API conversation continuation with tool results.
 * For multi-turn agent loops with codex models.
 */
async function aiCallWithHistory({ model, messages, tools, maxTokens = 4096, category = "chat", tool }) {
  const openai = getClient();

  let result;
  if (isResponsesModel(model)) {
    result = await _responsesCallWithHistory(openai, { model, messages, tools, maxTokens });
  } else {
    result = await _chatCallWithHistory(openai, { model, messages, tools, maxTokens });
  }

  _track(model, category, result.usage, tool);
  return result;
}

async function _responsesCallWithHistory(openai, { model, messages, tools, maxTokens }) {
  // Convert chat-style messages to responses input format
  const input = messages.map(msg => {
    if (msg.role === "system") {
      return { role: "developer", content: msg.content };
    }
    if (msg.role === "tool") {
      return {
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: msg.content,
      };
    }
    if (msg.role === "assistant" && msg.tool_calls) {
      // Emit function_call items for each tool call
      return msg.tool_calls.map(tc => ({
        type: "function_call",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
    }
    if (msg.role === "assistant") {
      return { role: "assistant", content: msg.content || "" };
    }
    return { role: msg.role, content: msg.content };
  }).flat();

  const params = {
    model,
    input,
    max_output_tokens: maxTokens,
  };

  if (tools && tools.length > 0) {
    params.tools = tools.map(t => {
      if (t.type === "function" && t.function) {
        return {
          type: "function",
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
          strict: true,
        };
      }
      return t;
    });
  }

  const response = await openai.responses.create(params);

  // Build a chat-compatible response
  let content = "";
  let toolCalls = null;

  if (response.output) {
    for (const item of response.output) {
      if (item.type === "message" && item.content) {
        for (const block of item.content) {
          if (block.type === "output_text") content += block.text;
        }
      } else if (item.type === "function_call") {
        if (!toolCalls) toolCalls = [];
        toolCalls.push({
          id: item.call_id || item.id,
          type: "function",
          function: {
            name: item.name,
            arguments: item.arguments,
          },
        });
      }
    }
  }

  if (!content && response.output_text) content = response.output_text;

  // Return in chat-compatible format so the agent engine doesn't need to change
  const message = { role: "assistant", content: content.trim() || null };
  if (toolCalls) message.tool_calls = toolCalls;

  return {
    choices: [{ message }],
    usage: response.usage || {},
  };
}

async function _chatCallWithHistory(openai, { model, messages, tools, maxTokens }) {
  const noTemp = /^(o[1-9]|gpt-5)/.test(model);
  const params = {
    model,
    messages,
    ...(!noTemp ? { temperature: 0 } : {}),
    ...tokenParam(model, maxTokens),
  };

  if (tools && tools.length > 0) {
    params.tools = tools;
    params.tool_choice = "auto";
  }

  return openai.chat.completions.create(params);
}

/**
 * Send an error context to OpenAI and get a repair patch back.
 * Uses CODING_MODEL — routes to correct API automatically.
 */
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

  const result = await aiCall({ model, systemPrompt, userPrompt, maxTokens: 2048, category: "heal" });
  const content = result.content;
  const cleaned = content.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    throw new Error(`Failed to parse AI response as JSON.\nRaw response:\n${content}`);
  }
}

module.exports = { requestRepair, getClient, tokenParam, aiCall, aiCallWithHistory, isResponsesModel, setTokenTracker };
