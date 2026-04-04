const https = require("https");
const http = require("http");
const crypto = require("crypto");

/**
 * Wolverine Inference API
 *
 * Credit system: $1 = 100 credits. 1 credit = $0.01 of compute.
 * Token pricing (in credits per million tokens):
 *   wolverine-test-1: 1 credit input / 4 credits output per 1M tokens
 *   (= $0.01/$0.04 per 1M — 15x cheaper than gpt-4o-mini, 80x cheaper than haiku)
 *
 * Rate limiting: per API key, configurable per tier.
 * Queue: when GPU is at capacity, requests queue with timeout.
 */

// GPU backend URLs
const INFERENCE_URL = process.env.WOLVERINE_GPU_URL || process.env.WOLVERINE_INFERENCE_URL || "http://ssh8.vast.ai:24233";
const EMBEDDING_URL = process.env.WOLVERINE_EMBEDDING_URL || INFERENCE_URL.replace(/:\d+$/, ":8081");
const GPU_KEY = process.env.WOLVERINE_GPU_KEY || "";

// Pricing in CREDITS per million tokens ($1 = 100 credits)
const MODEL_PRICING = {
  "wolverine-test-1":  { input: 1.0, output: 4.0 },   // $0.01/$0.04 per 1M
  "wolverine-coding":  { input: 1.0, output: 4.0 },
  "wolverine-reasoning": { input: 2.5, output: 10.0 },
  "wolverine-embedding-1-test": { input: 0.2, output: 0 }, // embeddings: input only, 5x cheaper than LLM
};

const MODEL_MAP = {
  "wolverine-test-1": "wolverine-test-1",
  "wolverine-coding": "wolverine-test-1",
  "wolverine-reasoning": "wolverine-test-1",
  "wolverine-embedding-1-test": "google/embeddinggemma-300m",
};

// VRAM safety — track GPU memory to prevent OOM
let _lastVramMB = 0;
const VRAM_LIMIT_SOFT = 10000; // 10GB — queue embeddings above this
const VRAM_LIMIT_HARD = 11000; // 11GB — queue everything above this

const TIER_LIMITS = {
  free: { rpm: 10, maxTokens: 1024 },
  starter: { rpm: 60, maxTokens: 4096 },
  pro: { rpm: 300, maxTokens: 4096 },
  admin: { rpm: 9999, maxTokens: 4096 },
};

function tokenCost(model, inputTokens, outputTokens) {
  const p = MODEL_PRICING[model] || MODEL_PRICING["wolverine-test-1"];
  return ((inputTokens / 1_000_000) * p.input) + ((outputTokens / 1_000_000) * p.output);
}

// ── Request Queue (handles GPU saturation) ──
const queue = [];
let activeRequests = 0;
const MAX_CONCURRENT = 8; // vLLM max-num-seqs
const QUEUE_TIMEOUT_MS = 30000;

function enqueue() {
  return new Promise((resolve, reject) => {
    if (activeRequests < MAX_CONCURRENT) {
      activeRequests++;
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      const idx = queue.indexOf(entry);
      if (idx >= 0) queue.splice(idx, 1);
      reject(new Error("Queue timeout — GPU at capacity. Try again in a few seconds."));
    }, QUEUE_TIMEOUT_MS);
    const entry = { resolve: () => { clearTimeout(timer); activeRequests++; resolve(); }, reject };
    queue.push(entry);
  });
}

function dequeue() {
  activeRequests = Math.max(0, activeRequests - 1);
  if (queue.length > 0) {
    const next = queue.shift();
    next.resolve();
  }
}

async function routes(fastify) {
  const { pool } = require("../lib/db");

  // Rate limit state (in-memory)
  const rateWindows = new Map();

  async function authenticate(request, reply) {
    const apiKey = request.headers.authorization?.replace("Bearer ", "") || request.headers["x-api-key"];
    if (!apiKey) return reply.code(401).send({ error: { message: "API key required. Pass via Authorization: Bearer <key>", type: "auth_error" } });

    // Platform key bypass
    let settings = {};
    try { settings = require("../config/settings.json"); } catch {}
    if (apiKey === settings.platform?.apiKey) {
      request.account = { api_key: apiKey, owner: "platform", tier: "admin", credits_remaining: 999999, rate_limit_rpm: 9999 };
      return;
    }

    // Check api_credits first, then fall back to credit_accounts (Privy billing)
    let result = await pool.query("SELECT * FROM api_credits WHERE api_key = $1", [apiKey]);
    if (result.rows.length === 0) {
      // Try credit_accounts (Privy-created accounts)
      const caResult = await pool.query("SELECT * FROM credit_accounts WHERE api_key = $1", [apiKey]);
      if (caResult.rows.length === 0) return reply.code(401).send({ error: { message: "Invalid API key", type: "auth_error" } });

      // Bridge: create api_credits entry from credit_accounts so billing works
      const ca = caResult.rows[0];
      await pool.query(
        `INSERT INTO api_credits (api_key, owner, email, credits_remaining, credits_used, tier, plan_name, rate_limit_rpm, account_id)
         VALUES ($1, $2, $3, $4, 0, 'starter', 'starter', 60, $5)
         ON CONFLICT (api_key) DO NOTHING`,
        [ca.api_key, ca.id, ca.email, parseFloat(ca.balance_credits) || 0, ca.id]
      );
      result = await pool.query("SELECT * FROM api_credits WHERE api_key = $1", [apiKey]);
    }

    const account = result.rows[0];

    // Credit check
    if (parseFloat(account.credits_remaining) <= 0) {
      return reply.code(402).send({ error: { message: "Insufficient credits. Add credits at wolverinenode.xyz", type: "billing_error", credits_remaining: 0 } });
    }

    // Rate limit
    const now = Date.now();
    const window = rateWindows.get(apiKey) || { count: 0, resetAt: now + 60000 };
    if (now > window.resetAt) { window.count = 0; window.resetAt = now + 60000; }
    const limit = account.rate_limit_rpm || TIER_LIMITS[account.tier]?.rpm || 10;
    if (window.count >= limit) {
      const retryAfter = Math.ceil((window.resetAt - now) / 1000);
      return reply.code(429).send({ error: { message: `Rate limit: ${limit} requests/min. Retry in ${retryAfter}s`, type: "rate_limit", retry_after: retryAfter } });
    }
    window.count++;
    rateWindows.set(apiKey, window);

    request.account = account;
  }

  // ── POST /chat/completions ──
  fastify.post("/chat/completions", { preHandler: authenticate }, async (request, reply) => {
    const body = request.body || {};
    const requestedModel = body.model || "wolverine-test-1";
    const account = request.account;
    const tier = TIER_LIMITS[account.tier] || TIER_LIMITS.free;
    const startMs = Date.now();

    // Enforce max tokens per tier
    if (body.max_tokens && body.max_tokens > tier.maxTokens) {
      body.max_tokens = tier.maxTokens;
    }

    // Map model name for backend
    const backendBody = { ...body, model: MODEL_MAP[requestedModel] || requestedModel };

    // Queue if GPU saturated
    try {
      await enqueue();
    } catch (err) {
      return reply.code(503).send({ error: { message: err.message, type: "capacity_error", queue_length: queue.length } });
    }

    try {
      const result = await proxyToInference("/v1/chat/completions", backendBody);
      const latencyMs = Date.now() - startMs;

      const usage = result.usage || {};
      const inputTokens = usage.prompt_tokens || 0;
      const outputTokens = usage.completion_tokens || 0;
      const cost = tokenCost(requestedModel, inputTokens, outputTokens);

      // Bill credits (skip for platform)
      if (account.owner !== "platform") {
        await pool.query(
          "UPDATE api_credits SET credits_remaining = credits_remaining - $1, credits_used = credits_used + $1, last_used = NOW() WHERE api_key = $2",
          [cost, account.api_key]
        );
        // Sync to credit_accounts (Privy billing dashboard) if linked
        if (account.account_id) {
          await pool.query(
            "UPDATE credit_accounts SET balance_credits = balance_credits - $1, lifetime_used = lifetime_used + $1, updated_at = NOW() WHERE id = $2 AND balance_credits >= $1",
            [cost, account.account_id]
          ).catch(() => {});
        }
        await pool.query(
          "INSERT INTO api_usage_log (api_key, model, input_tokens, output_tokens, total_tokens, cost, latency_ms, success, endpoint) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)",
          [account.api_key, requestedModel, inputTokens, outputTokens, inputTokens + outputTokens, cost, latencyMs, "/v1/chat/completions"]
        );
      }

      // Rewrite response
      if (result.model) result.model = requestedModel;
      result.x_wolverine = {
        credits_used: Math.round(cost * 1000000) / 1000000,
        credits_remaining: Math.max(0, parseFloat(account.credits_remaining) - cost),
        latency_ms: latencyMs,
        queued: activeRequests > MAX_CONCURRENT,
      };

      return result;
    } catch (err) {
      if (account.owner !== "platform") {
        await pool.query(
          "INSERT INTO api_usage_log (api_key, model, input_tokens, output_tokens, total_tokens, cost, latency_ms, success, endpoint) VALUES ($1, $2, 0, 0, 0, 0, $3, false, $4)",
          [account.api_key, requestedModel, Date.now() - startMs, "/v1/chat/completions"]
        ).catch(() => {});
      }
      return reply.code(502).send({ error: { message: `Inference error: ${err.message}`, type: "inference_error" } });
    } finally {
      dequeue();
    }
  });

  // ── POST /embeddings — proxy to OpenAI, billed at 2x through wolverine credits ──
  fastify.post("/embeddings", { preHandler: authenticate }, async (request, reply) => {
    const body = request.body || {};
    const requestedModel = body.model || "wolverine-embedding-1";
    const account = request.account;
    const startMs = Date.now();

    try {
      // Forward to OpenAI text-embedding-3-small
      const OpenAI = require("openai");
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: body.input,
      });

      const latencyMs = Date.now() - startMs;
      const totalTokens = response.usage?.total_tokens || 0;
      // 2x markup: OpenAI charges $0.02/1M, we charge $0.04/1M = 0.4 credits/1M
      const cost = (totalTokens / 1_000_000) * 0.4;

      // Bill credits
      if (account.owner !== "platform") {
        await pool.query(
          "UPDATE api_credits SET credits_remaining = credits_remaining - $1, credits_used = credits_used + $1, last_used = NOW() WHERE api_key = $2",
          [cost, account.api_key]
        );
        if (account.account_id) {
          await pool.query(
            "UPDATE credit_accounts SET balance_credits = balance_credits - $1, lifetime_used = lifetime_used + $1, updated_at = NOW() WHERE id = $2 AND balance_credits >= $1",
            [cost, account.account_id]
          ).catch(() => {});
        }
        await pool.query(
          "INSERT INTO api_usage_log (api_key, model, input_tokens, output_tokens, total_tokens, cost, latency_ms, success, endpoint) VALUES ($1, $2, $3, 0, $3, $4, $5, true, $6)",
          [account.api_key, requestedModel, totalTokens, cost, latencyMs, "/v1/embeddings"]
        );
      }

      // Rewrite model name in response
      response.model = requestedModel;
      response.x_wolverine = {
        credits_used: Math.round(cost * 1000000) / 1000000,
        credits_remaining: Math.max(0, parseFloat(account.credits_remaining) - cost),
        latency_ms: latencyMs,
        backend: "text-embedding-3-small",
      };

      return response;
    } catch (err) {
      return reply.code(502).send({ error: { message: `Embedding error: ${err.message}`, type: "embedding_error" } });
    }
  });

  // ── GET /models ──
  fastify.get("/models", async () => ({
    object: "list",
    data: Object.entries(MODEL_PRICING).map(([id, p]) => ({
      id, object: "model", owned_by: "wolverine",
      created: Math.floor(Date.now() / 1000),
      pricing: { input_credits_per_million: p.input, output_credits_per_million: p.output, usd_per_credit: 0.01 },
    })),
  }));

  // ── POST /keys/create — generate new API key ──
  fastify.post("/keys/create", { preHandler: authenticate }, async (request, reply) => {
    const account = request.account;
    if (account.tier !== "admin") return reply.code(403).send({ error: { message: "Only admins can create API keys", type: "auth_error" } });

    const { owner, email, credits, tier, rpm } = request.body || {};
    if (!owner) return reply.code(400).send({ error: { message: "owner required", type: "validation_error" } });

    const newKey = "wlv_" + crypto.randomBytes(24).toString("hex");
    const keyTier = tier || "free";
    const keyCredits = credits || (keyTier === "free" ? 10 : 0);
    const keyRpm = rpm || TIER_LIMITS[keyTier]?.rpm || 10;

    await pool.query(
      "INSERT INTO api_credits (api_key, owner, email, credits_remaining, tier, plan_name, rate_limit_rpm) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [newKey, owner, email || null, keyCredits, keyTier, keyTier, keyRpm]
    );

    return { api_key: newKey, owner, tier: keyTier, credits: keyCredits, rate_limit_rpm: keyRpm };
  });

  // ── POST /keys/add-credits — add credits to a key ──
  fastify.post("/keys/add-credits", { preHandler: authenticate }, async (request, reply) => {
    const account = request.account;
    if (account.tier !== "admin") return reply.code(403).send({ error: { message: "Only admins can add credits", type: "auth_error" } });

    const { api_key, credits } = request.body || {};
    if (!api_key || !credits) return reply.code(400).send({ error: { message: "api_key and credits required" } });

    await pool.query("UPDATE api_credits SET credits_remaining = credits_remaining + $1 WHERE api_key = $2", [credits, api_key]);
    const updated = await pool.query("SELECT credits_remaining FROM api_credits WHERE api_key = $1", [api_key]);
    return { api_key, credits_added: credits, credits_remaining: parseFloat(updated.rows[0]?.credits_remaining || 0) };
  });

  // ── GET /keys — list all keys (admin only) ──
  fastify.get("/keys", { preHandler: authenticate }, async (request, reply) => {
    if (request.account.tier !== "admin") return reply.code(403).send({ error: { message: "Admin only" } });
    const { rows } = await pool.query("SELECT api_key, owner, email, tier, credits_remaining, credits_used, rate_limit_rpm, created_at, last_used FROM api_credits ORDER BY created_at DESC");
    return { keys: rows };
  });

  // ── GET /credits ──
  fastify.get("/credits", { preHandler: authenticate }, async (request, reply) => {
    const a = request.account;
    return {
      credits_remaining: parseFloat(a.credits_remaining),
      credits_used: parseFloat(a.credits_used || 0),
      usd_remaining: parseFloat(a.credits_remaining) * 0.01,
      usd_used: parseFloat(a.credits_used || 0) * 0.01,
      tier: a.tier, rate_limit_rpm: a.rate_limit_rpm, owner: a.owner,
    };
  });

  // ── GET /usage ──
  fastify.get("/usage", { preHandler: authenticate }, async (request, reply) => {
    const apiKey = request.account.api_key;
    const period = request.query.period || "7d";
    const interval = { "1h": "1 hour", "1d": "1 day", "7d": "7 days", "30d": "30 days" }[period] || "7 days";

    const summary = await pool.query(
      `SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
              SUM(total_tokens) AS tokens, SUM(cost) AS credits_spent, AVG(latency_ms) AS avg_latency,
              COUNT(*) FILTER (WHERE success) AS successes
       FROM api_usage_log WHERE api_key = $1 AND timestamp > NOW() - $2::interval
       GROUP BY model ORDER BY credits_spent DESC`, [apiKey, interval]
    );

    const timeline = await pool.query(
      `SELECT date_trunc('hour', timestamp) AS hour, SUM(cost) AS credits, SUM(total_tokens) AS tokens, COUNT(*) AS calls
       FROM api_usage_log WHERE api_key = $1 AND timestamp > NOW() - $2::interval
       GROUP BY hour ORDER BY hour`, [apiKey, interval]
    );

    const totalCredits = summary.rows.reduce((s, r) => s + parseFloat(r.credits_spent || 0), 0);

    return {
      period,
      total_credits_spent: Math.round(totalCredits * 1000000) / 1000000,
      total_usd_spent: Math.round(totalCredits * 0.01 * 1000000) / 1000000,
      byModel: summary.rows.map(r => ({
        model: r.model, calls: parseInt(r.calls), input: parseInt(r.input || 0), output: parseInt(r.output || 0),
        tokens: parseInt(r.tokens || 0), credits_spent: parseFloat(r.credits_spent || 0),
        usd_spent: parseFloat(r.credits_spent || 0) * 0.01,
        avgLatencyMs: Math.round(parseFloat(r.avg_latency || 0)),
        successRate: parseInt(r.calls) > 0 ? parseFloat(((parseInt(r.successes) / parseInt(r.calls)) * 100).toFixed(2)) : 0,
      })),
      timeline: timeline.rows.map(r => ({
        hour: r.hour, credits: parseFloat(r.credits), tokens: parseInt(r.tokens), calls: parseInt(r.calls),
      })),
      queue: { active: activeRequests, waiting: queue.length, max: MAX_CONCURRENT },
    };
  });

  // ── GET /health ──
  fastify.get("/health", async () => {
    try {
      const result = await proxyToInference("/health", null, "GET");
      return { status: "ok", inference: result, queue: { active: activeRequests, waiting: queue.length, max: MAX_CONCURRENT } };
    } catch (err) {
      return { status: "down", error: err.message, queue: { active: activeRequests, waiting: queue.length, max: MAX_CONCURRENT } };
    }
  });
}

function proxyToInference(path, body, method = "POST") {
  return new Promise((resolve, reject) => {
    const url = new (require("url").URL)(INFERENCE_URL + path);
    const client = url.protocol === "https:" ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;

    const req = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method,
      timeout: 120000,
      headers: {
        "Content-Type": "application/json",
        ...(GPU_KEY ? { "Authorization": `Bearer ${GPU_KEY}` } : {}),
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Inference timeout")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = routes;
