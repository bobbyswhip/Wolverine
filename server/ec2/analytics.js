const { pool } = require("../lib/db");
const fs = require("fs");
const path = require("path");

/**
 * Read local usage.json — this server IS the analytics backend,
 * so it doesn't send heartbeats to itself. Its own usage data
 * lives in .wolverine/usage.json and must be included directly.
 */
function getLocalUsage() {
  try {
    const usagePath = path.join(process.cwd(), ".wolverine", "usage.json");
    return JSON.parse(fs.readFileSync(usagePath, "utf-8"));
  } catch { return null; }
}

function detectProvider(model) {
  if (!model) return "openai";
  if (/^wolverine|^gemma/i.test(model)) return "wolverine";
  if (/^claude|^anthropic/i.test(model)) return "anthropic";
  if (/^gemini|^google/i.test(model)) return "google";
  if (/^mistral/i.test(model)) return "mistral";
  return "openai";
}

const PERIOD_MAP = {
  "1h": "1 hour",
  "6h": "6 hours",
  "24h": "24 hours",
  "1d": "1 day",
  "7d": "7 days",
  "30d": "30 days",
};

async function routes(fastify) {
  // ── GET / — main analytics dashboard ──
  fastify.get("/", async (request) => {
    const period = PERIOD_MAP[request.query.period] || "24 hours";

    // Server counts
    const serverRes = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE last_heartbeat > NOW() - INTERVAL '3 minutes') AS active,
         COUNT(*) FILTER (WHERE last_heartbeat <= NOW() - INTERVAL '3 minutes') AS down
       FROM servers`
    );
    const srv = serverRes.rows[0];

    // Repair stats within period
    const repairRes = await pool.query(
      `SELECT
         COUNT(*) AS total,
         ROUND(AVG(CASE WHEN success THEN 1 ELSE 0 END) * 100, 2) AS success_rate,
         COALESCE(SUM(cost), 0) AS cost,
         CASE WHEN COUNT(*) > 0
           THEN ROUND(COALESCE(SUM(cost), 0) / COUNT(*), 4)
           ELSE 0 END AS cost_per_repair
       FROM repairs WHERE timestamp > NOW() - $1::interval`,
      [period]
    );
    const rep = repairRes.rows[0];

    // Usage totals from usage_hourly within period
    const usageRes = await pool.query(
      `SELECT
         COALESCE(SUM(tokens_total), 0) AS tokens,
         COALESCE(SUM(cost_total), 0) AS cost,
         COALESCE(SUM(calls_total), 0) AS calls
       FROM usage_hourly WHERE hour > NOW() - $1::interval`,
      [period]
    );
    const usg = usageRes.rows[0];

    // byProvider: from heartbeat with richest data per server (not latest — restarts clear counters)
    const providerRes = await pool.query(
      `SELECT DISTINCT ON (server_id) payload->'byProvider' AS by_provider
       FROM heartbeats
       WHERE timestamp > NOW() - $1::interval
         AND payload->'byProvider' IS NOT NULL
         AND payload->'byProvider' != '{}'::jsonb
       ORDER BY server_id, timestamp DESC`,
      [period]
    );
    const byProvider = {};
    for (const row of providerRes.rows) {
      if (!row.by_provider) continue;
      for (const [prov, stats] of Object.entries(row.by_provider)) {
        if (!byProvider[prov]) byProvider[prov] = { tokens: 0, cost: 0, calls: 0 };
        byProvider[prov].tokens += stats.tokens || stats.totalTokens || stats.total || 0;
        byProvider[prov].cost += stats.cost || 0;
        byProvider[prov].calls += stats.calls || 0;
      }
    }

    // Merge wolverine usage from api_usage_log
    const wolverineRes = await pool.query(
      `SELECT COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(cost), 0) AS cost,
              COUNT(*) AS calls
       FROM api_usage_log WHERE timestamp > NOW() - $1::interval`,
      [period]
    );
    const wv = wolverineRes.rows[0];
    if (wv.tokens > 0 || wv.calls > 0) {
      if (!byProvider.wolverine) byProvider.wolverine = { tokens: 0, cost: 0, calls: 0 };
      byProvider.wolverine.tokens += parseInt(wv.tokens, 10);
      byProvider.wolverine.cost += parseFloat(wv.cost);
      byProvider.wolverine.calls += parseInt(wv.calls, 10);
    }

    // byCategory: from heartbeat with richest data per server
    const catRes = await pool.query(
      `SELECT DISTINCT ON (server_id) payload->'byCategory' AS by_category
       FROM heartbeats
       WHERE timestamp > NOW() - $1::interval
         AND payload->'byCategory' IS NOT NULL
         AND payload->'byCategory' != '{}'::jsonb
       ORDER BY server_id, timestamp DESC`,
      [period]
    );
    const byCategory = {};
    for (const row of catRes.rows) {
      if (!row.by_category) continue;
      for (const [cat, val] of Object.entries(row.by_category)) {
        const tokens = typeof val === "object" ? val.tokens || 0 : val || 0;
        const cost = typeof val === "object" ? val.cost || 0 : 0;
        if (!byCategory[cat]) byCategory[cat] = { tokens: 0, cost: 0 };
        byCategory[cat].tokens += tokens;
        byCategory[cat].cost += cost;
      }
    }

    // byModelCategory: framework sends as array [{model, category, calls, cost, tokens, ...}]
    // Merge across servers by model+category composite key, return as array
    const mcRes = await pool.query(
      `SELECT DISTINCT ON (server_id)
         payload->'byModelCategory' AS by_model_category
       FROM heartbeats
       WHERE timestamp > NOW() - $1::interval
         AND payload->'byModelCategory' IS NOT NULL
       ORDER BY server_id, timestamp DESC`,
      [period]
    );
    const mcMerged = {};
    for (const row of mcRes.rows) {
      if (!row.by_model_category) continue;
      // Handle both array format (framework v3.7+) and object format (legacy)
      const items = Array.isArray(row.by_model_category)
        ? row.by_model_category
        : Object.values(row.by_model_category);
      for (const item of items) {
        if (!item || !item.model || !item.category) continue;
        const key = `${item.model}|${item.category}`;
        if (!mcMerged[key]) {
          mcMerged[key] = { ...item };
        } else {
          const e = mcMerged[key];
          const prevCalls = e.calls || 0;
          const newCalls = item.calls || 0;
          const totalCalls = prevCalls + newCalls;
          e.calls = totalCalls;
          e.cost = (e.cost || 0) + (item.cost || 0);
          e.tokens = (e.tokens || 0) + (item.tokens || 0);
          e.input = (e.input || 0) + (item.input || 0);
          e.output = (e.output || 0) + (item.output || 0);
          // Weighted averages for rates and latency
          if (totalCalls > 0) {
            e.successRate = ((e.successRate || 0) * prevCalls + (item.successRate || 0) * newCalls) / totalCalls;
            e.avgLatencyMs = Math.round(((e.avgLatencyMs || 0) * prevCalls + (item.avgLatencyMs || 0) * newCalls) / totalCalls);
            e.tokensPerSecond = ((e.tokensPerSecond || 0) * prevCalls + (item.tokensPerSecond || 0) * newCalls) / totalCalls;
          }
        }
      }
    }
    // Merge local server's own usage (this server doesn't heartbeat to itself)
    const local = getLocalUsage();
    if (local) {
      // Local byProvider
      if (local.byProvider) {
        for (const [prov, stats] of Object.entries(local.byProvider)) {
          if (!byProvider[prov]) byProvider[prov] = { tokens: 0, cost: 0, calls: 0 };
          byProvider[prov].tokens += stats.tokens || stats.total || 0;
          byProvider[prov].cost += stats.cost || 0;
          byProvider[prov].calls += stats.calls || 0;
        }
      }
      // Local byCategory
      if (local.byCategory) {
        for (const [cat, val] of Object.entries(local.byCategory)) {
          const tokens = typeof val === "object" ? val.total || val.tokens || 0 : val || 0;
          const cost = typeof val === "object" ? val.cost || 0 : 0;
          const calls = typeof val === "object" ? val.calls || 0 : 0;
          if (!byCategory[cat]) byCategory[cat] = { tokens: 0, cost: 0, calls: 0 };
          byCategory[cat].tokens += tokens;
          byCategory[cat].cost += cost;
          byCategory[cat].calls += calls;
        }
      }
      // Local byModelCategory — the key data for per-task analytics
      if (local.byModelCategory) {
        const items = Array.isArray(local.byModelCategory)
          ? local.byModelCategory
          : Object.values(local.byModelCategory);
        for (const item of items) {
          if (!item || !item.model || !item.category) continue;
          const key = `${item.model}|${item.category}`;
          const calls = item.calls || 0;
          const successes = item.successes || 0;
          const failures = item.failures || 0;
          const successRate = calls > 0 ? parseFloat((((calls - failures) / calls) * 100).toFixed(2)) : 100;
          const avgLatencyMs = calls > 0 && item.totalLatencyMs ? Math.round(item.totalLatencyMs / calls) : 0;
          const tps = item.totalLatencyMs > 0 ? Math.round((item.total || 0) / (item.totalLatencyMs / 1000) * 10) / 10 : 0;
          const entry = { model: item.model, category: item.category, calls, cost: item.cost || 0, tokens: item.total || 0, input: item.input || 0, output: item.output || 0, successRate, avgLatencyMs, tokensPerSecond: tps };
          if (!mcMerged[key]) {
            mcMerged[key] = entry;
          } else {
            const e = mcMerged[key];
            const prevCalls = e.calls || 0;
            const totalCalls = prevCalls + calls;
            e.calls = totalCalls;
            e.cost = (e.cost || 0) + entry.cost;
            e.tokens = (e.tokens || 0) + entry.tokens;
            e.input = (e.input || 0) + entry.input;
            e.output = (e.output || 0) + entry.output;
            if (totalCalls > 0) {
              e.successRate = ((e.successRate || 0) * prevCalls + entry.successRate * calls) / totalCalls;
              e.avgLatencyMs = Math.round(((e.avgLatencyMs || 0) * prevCalls + entry.avgLatencyMs * calls) / totalCalls);
              e.tokensPerSecond = ((e.tokensPerSecond || 0) * prevCalls + entry.tokensPerSecond * calls) / totalCalls;
            }
          }
        }
      }
      // Add local tokens/cost to totals
      const localTokens = local.totalTokens || 0;
      const localCost = local.totalCostUsd || 0;
      const localCalls = local.totalCalls || 0;
    }
    const byModelCategory = Object.values(mcMerged);

    return {
      totalServers: parseInt(srv.total, 10),
      activeServers: Math.max(parseInt(srv.active, 10), 1), // This server is always active
      downServers: parseInt(srv.down, 10),
      totalRepairs: parseInt(rep.total, 10),
      successRate: parseFloat(rep.success_rate) || 0,
      repairCost: parseFloat(rep.cost),
      costPerRepair: parseFloat(rep.cost_per_repair),
      totalCost: parseFloat(usg.cost) + (local?.totalCostUsd || 0),
      totalTokens: parseInt(usg.tokens, 10) + (local?.totalTokens || 0),
      totalCalls: parseInt(usg.calls, 10) + (local?.totalCalls || 0),
      byProvider,
      byCategory,
      byModelCategory,
    };
  });

  // ── GET /cost — cost analytics with groupBy modes ──
  fastify.get("/cost", async (request) => {
    const groupBy = request.query.groupBy || "timeseries";
    const period = PERIOD_MAP[request.query.period] || "24 hours";

    if (groupBy === "timeseries") {
      // Hourly/daily cost buckets from usage_hourly
      const isLong = period === "7 days" || period === "30 days";
      const bucketExpr = isLong ? "date_trunc('day', hour)" : "hour";

      const timeRes = await pool.query(
        `SELECT ${bucketExpr} AS bucket,
                SUM(tokens_total) AS tokens,
                SUM(cost_total) AS cost,
                SUM(calls_total) AS calls
         FROM usage_hourly WHERE hour > NOW() - $1::interval
         GROUP BY bucket ORDER BY bucket`,
        [period]
      );

      // Per-model overlay from usage_by_model
      const modelRes = await pool.query(
        `SELECT ${isLong ? "date_trunc('day', hour)" : "hour"} AS bucket,
                model, provider,
                SUM(total_tokens) AS tokens,
                SUM(cost) AS cost,
                SUM(calls) AS calls
         FROM usage_by_model WHERE hour > NOW() - $1::interval
         GROUP BY bucket, model, provider ORDER BY bucket`,
        [period]
      );

      // Merge wolverine from api_usage_log
      const wvRes = await pool.query(
        `SELECT ${isLong ? "date_trunc('day', timestamp)" : "date_trunc('hour', timestamp)"} AS bucket,
                model,
                SUM(total_tokens) AS tokens,
                SUM(cost) AS cost,
                COUNT(*) AS calls
         FROM api_usage_log WHERE timestamp > NOW() - $1::interval
         GROUP BY bucket, model ORDER BY bucket`,
        [period]
      );

      // Build breakdown: merge model costs into each time bucket
      // Frontend expects: [{ bucket, models: { "model-name": cost } }]
      // Use ISO string keys so Date objects from different queries match
      const toKey = (d) => new Date(d).toISOString();
      const bucketMap = {};
      for (const row of timeRes.rows) {
        const key = toKey(row.bucket);
        bucketMap[key] = { bucket: row.bucket, tokens: parseInt(row.tokens, 10), cost: parseFloat(row.cost), calls: parseInt(row.calls, 10), models: {} };
      }
      // Add model costs per bucket
      for (const row of modelRes.rows) {
        const key = toKey(row.bucket);
        if (!bucketMap[key]) bucketMap[key] = { bucket: row.bucket, tokens: 0, cost: 0, calls: 0, models: {} };
        bucketMap[key].models[row.model] = (bucketMap[key].models[row.model] || 0) + parseFloat(row.cost || 0);
      }
      // Add wolverine model costs
      for (const row of wvRes.rows) {
        const key = toKey(row.bucket);
        if (!bucketMap[key]) bucketMap[key] = { bucket: row.bucket, tokens: 0, cost: 0, calls: 0, models: {} };
        const modelName = row.model || "wolverine-test-1";
        bucketMap[key].models[modelName] = (bucketMap[key].models[modelName] || 0) + parseFloat(row.cost || 0);
      }

      const breakdown = Object.values(bucketMap).sort((a, b) => new Date(a.bucket) - new Date(b.bucket));

      return {
        groupBy: "timeseries",
        bucket: isLong ? "day" : "hour",
        breakdown,
      };
    }

    if (groupBy === "performance") {
      // Full model stats from heartbeat with MOST byModel data (not just latest — restarts clear counters)
      const hbRes = await pool.query(
        `SELECT DISTINCT ON (server_id) payload->'byModel' AS by_model
         FROM heartbeats
         WHERE timestamp > NOW() - $1::interval
           AND payload->'byModel' IS NOT NULL
           AND payload->'byModel' != '{}'::jsonb
         ORDER BY server_id, timestamp DESC`,
        [period]
      );
      const models = {};
      for (const row of hbRes.rows) {
        if (!row.by_model) continue;
        for (const [model, stats] of Object.entries(row.by_model)) {
          if (!models[model]) {
            models[model] = {
              model,
              provider: detectProvider(model),
              input: 0,
              output: 0,
              total_tokens: 0,
              total_cost: 0,
              calls: 0,
              avgLatencyMs: 0,
              successRate: 0,
              cacheSavings: 0,
              tokensPerSecond: 0,
              outputTokPerSecond: 0,
              _count: 0,
            };
          }
          const m = models[model];
          m.input += stats.inputTokens || stats.input || 0;
          m.output += stats.outputTokens || stats.output || 0;
          m.total_tokens += stats.totalTokens || stats.total || stats.tokens || 0;
          m.total_cost += stats.cost || 0;
          m.calls += stats.calls || 0;
          m.cacheSavings += stats.cacheSavings || 0;
          m.avgLatencyMs += stats.avgLatencyMs || stats.latencyMs || 0;
          m.successRate += stats.successRate != null ? stats.successRate : 1;
          // Use pre-computed tps from heartbeat, or compute from latency
          if (stats.tokensPerSecond > 0) {
            m.tokensPerSecond += stats.tokensPerSecond;
            m.outputTokPerSecond += stats.outputTokPerSecond || 0;
          } else if (stats.avgLatencyMs > 0) {
            const tok = stats.totalTokens || stats.total || stats.tokens || 0;
            if (tok > 0) m.tokensPerSecond += tok / (stats.avgLatencyMs / 1000);
            const outTok = stats.outputTokens || stats.output || 0;
            if (outTok > 0) m.outputTokPerSecond += outTok / (stats.avgLatencyMs / 1000);
          }
          m._count += 1;
        }
      }
      // Average the averages
      const breakdown = Object.values(models).map((m) => {
        if (m._count > 0) {
          m.avgLatencyMs = Math.round(m.avgLatencyMs / m._count);
          m.successRate = parseFloat((m.successRate / m._count).toFixed(4));
          m.tokensPerSecond = Math.round(m.tokensPerSecond / m._count);
          m.outputTokPerSecond = Math.round(m.outputTokPerSecond / m._count);
        }
        m.costPerCall = m.calls > 0 ? m.total_cost / m.calls : 0;
        delete m._count;
        return m;
      });
      return { groupBy: "performance", breakdown };
    }

    if (groupBy === "server") {
      const res = await pool.query(
        `SELECT u.server_id, s.name,
                SUM(u.tokens_total) AS total_tokens,
                SUM(u.cost_total) AS total_cost,
                SUM(u.calls_total) AS calls
         FROM usage_hourly u
         LEFT JOIN servers s ON s.id = u.server_id
         WHERE u.hour > NOW() - $1::interval
         GROUP BY u.server_id, s.name ORDER BY total_cost DESC`,
        [period]
      );
      // Add repair counts per server
      const repairRes = await pool.query(
        `SELECT server_id, COUNT(*) AS repair_count
         FROM repairs WHERE timestamp > NOW() - $1::interval
         GROUP BY server_id`,
        [period]
      );
      const repairMap = {};
      for (const r of repairRes.rows) repairMap[r.server_id] = parseInt(r.repair_count, 10);

      const breakdown = res.rows.map(r => ({
        server_id: r.server_id,
        name: r.name,
        total_cost: parseFloat(r.total_cost) || 0,
        total_tokens: parseInt(r.total_tokens, 10) || 0,
        calls: parseInt(r.calls, 10) || 0,
        repair_count: repairMap[r.server_id] || 0,
      }));
      return { groupBy: "server", breakdown };
    }

    if (groupBy === "model") {
      const hbRes = await pool.query(
        `SELECT DISTINCT ON (server_id) payload->'byModel' AS by_model
         FROM heartbeats
         WHERE timestamp > NOW() - $1::interval
           AND payload->'byModel' IS NOT NULL
           AND payload->'byModel' != '{}'::jsonb
         ORDER BY server_id, timestamp DESC`,
        [period]
      );
      const models = {};
      for (const row of hbRes.rows) {
        if (!row.by_model) continue;
        for (const [model, stats] of Object.entries(row.by_model)) {
          if (!models[model]) {
            models[model] = { model, provider: detectProvider(model), total_tokens: 0, total_cost: 0, calls: 0 };
          }
          models[model].total_tokens += stats.totalTokens || stats.total || stats.tokens || 0;
          models[model].total_cost += stats.cost || 0;
          models[model].calls += stats.calls || 0;
        }
      }
      // Add repair counts by model
      const repairRes = await pool.query(
        `SELECT model, COUNT(*) AS repair_count
         FROM repairs WHERE timestamp > NOW() - $1::interval
         GROUP BY model`,
        [period]
      );
      for (const r of repairRes.rows) {
        if (models[r.model]) models[r.model].repair_count = parseInt(r.repair_count, 10);
      }
      const breakdown = Object.values(models).map(m => ({ ...m, repair_count: m.repair_count || 0 }));
      return { groupBy: "model", breakdown };
    }

    if (groupBy === "time") {
      const res = await pool.query(
        `SELECT date_trunc('day', hour) AS day,
                SUM(cost_total) AS total_cost,
                SUM(tokens_total) AS total_tokens,
                SUM(calls_total) AS calls
         FROM usage_hourly WHERE hour > NOW() - $1::interval
         GROUP BY day ORDER BY day`,
        [period]
      );
      const breakdown = res.rows.map(r => ({
        day: r.day,
        total_cost: parseFloat(r.total_cost) || 0,
        total_tokens: parseInt(r.total_tokens, 10) || 0,
        calls: parseInt(r.calls, 10) || 0,
      }));
      return { groupBy: "time", breakdown };
    }

    return { error: "unknown groupBy: " + groupBy };
  });

  // ── GET /repairs — repair log with model attribution ──
  fastify.get("/repairs", async (request) => {
    const period = PERIOD_MAP[request.query.period] || "24 hours";
    const limit = Math.min(parseInt(request.query.limit, 10) || 100, 500);
    const offset = parseInt(request.query.offset, 10) || 0;

    // Full repair list
    const repairsRes = await pool.query(
      `SELECT r.*, s.name AS server_name
       FROM repairs r
       LEFT JOIN servers s ON s.id = r.server_id
       WHERE r.timestamp > NOW() - $1::interval
       ORDER BY r.timestamp DESC
       LIMIT $2 OFFSET $3`,
      [period, limit, offset]
    );

    // Failures only
    const failRes = await pool.query(
      `SELECT r.*, s.name AS server_name
       FROM repairs r
       LEFT JOIN servers s ON s.id = r.server_id
       WHERE r.timestamp > NOW() - $1::interval AND r.success = false
       ORDER BY r.timestamp DESC`,
      [period]
    );

    // By model
    const byModelRes = await pool.query(
      `SELECT model,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE success) AS successes,
              COUNT(*) FILTER (WHERE NOT success) AS failures,
              COALESCE(SUM(tokens), 0) AS tokens,
              COALESCE(SUM(cost), 0) AS cost,
              ROUND(AVG(duration_ms)) AS avg_duration_ms
       FROM repairs WHERE timestamp > NOW() - $1::interval
       GROUP BY model ORDER BY total DESC`,
      [period]
    );

    // By mode
    const byModeRes = await pool.query(
      `SELECT mode,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE success) AS successes,
              COUNT(*) FILTER (WHERE NOT success) AS failures,
              COALESCE(SUM(cost), 0) AS cost
       FROM repairs WHERE timestamp > NOW() - $1::interval
       GROUP BY mode ORDER BY total DESC`,
      [period]
    );

    return {
      repairs: repairsRes.rows,
      failures: failRes.rows,
      byModel: byModelRes.rows,
      byMode: byModeRes.rows,
    };
  });
}

module.exports = routes;
