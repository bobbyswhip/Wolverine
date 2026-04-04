const { pool } = require("../lib/db");

function detectProvider(model) {
  if (!model) return "openai";
  if (/^wolverine|^gemma/i.test(model)) return "wolverine";
  if (/^claude|^anthropic/i.test(model)) return "anthropic";
  if (/^gemini|^google/i.test(model)) return "google";
  if (/^mistral/i.test(model)) return "mistral";
  return "openai";
}

async function routes(fastify) {
  // POST / — receive heartbeat from wolverine instances
  fastify.post("/", async (request, reply) => {
    const b = request.body;
    if (!b || !b.instanceId) {
      return reply.code(400).send({ error: "instanceId required" });
    }

    const serverId = b.instanceId;
    const now = b.timestamp || new Date().toISOString();
    const hourBucket = new Date(now).toISOString().slice(0, 13) + ":00:00Z";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // ── Get previous heartbeat for incremental diffs ──
      const prevRes = await client.query(
        `SELECT tokens_total, cost_total, routes_total, routes_healthy,
                routes_unhealthy, repairs_total, repairs_successes, payload
         FROM heartbeats WHERE server_id = $1
         ORDER BY timestamp DESC LIMIT 1`,
        [serverId]
      );
      const prev = prevRes.rows[0] || null;

      // Current cumulative values
      const curTokens = (b.usage && b.usage.totalTokens) || 0;
      const curCost = (b.usage && b.usage.totalCost) || 0;
      const curCalls = (b.usage && b.usage.totalCalls) || 0;
      const curRepairs = (b.repairs && b.repairs.total) || 0;
      const curSuccesses = (b.repairs && b.repairs.successes) || 0;

      // Detect restart: current < previous * 0.5 means counters reset
      let isRestart = false;
      if (prev && curTokens < (prev.tokens_total || 0) * 0.5) {
        isRestart = true;
      }

      // Compute incremental diffs (skip on restart or first heartbeat)
      let incTokens = 0;
      let incCost = 0;
      let incCalls = 0;
      if (prev && !isRestart) {
        incTokens = Math.max(0, curTokens - (prev.tokens_total || 0));
        incCost = Math.max(0, curCost - (prev.cost_total || 0));
        // calls from previous payload
        const prevCalls =
          (prev.payload && prev.payload.usage && prev.payload.usage.totalCalls) || 0;
        incCalls = Math.max(0, curCalls - prevCalls);
      }

      // ── Update servers table ──
      await client.query(
        `INSERT INTO servers (id, name, version, first_seen, last_heartbeat, status, config)
         VALUES ($1, $2, $3, $4, $4, 'healthy', $5)
         ON CONFLICT (id) DO UPDATE SET
           last_heartbeat = $4,
           status = 'healthy',
           version = COALESCE($3, servers.version),
           config = COALESCE($5, servers.config),
           name = COALESCE($2, servers.name)`,
        [
          serverId,
          (b.server && b.server.name) || serverId,
          b.version || null,
          now,
          b.server ? JSON.stringify(b.server) : null,
        ]
      );

      // ── Insert heartbeat snapshot (cumulative values + full payload) ──
      const payloadJson = {
        byModel: (b.usage && b.usage.byModel) || {},
        byModelCategory: (b.usage && b.usage.byModelCategory) || {},
        byProvider: (b.usage && b.usage.byProvider) || {},
        byCategory: (b.usage && b.usage.byCategory) || {},
        byTool: (b.usage && b.usage.byTool) || {},
        brain: b.brain || null,
        backups: b.backups || null,
        usage: b.usage || {},
      };

      await client.query(
        `INSERT INTO heartbeats
           (server_id, timestamp, uptime, memory_mb, cpu_percent,
            routes_total, routes_healthy, routes_unhealthy,
            tokens_total, cost_total, repairs_total, repairs_successes, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          serverId,
          now,
          (b.server && b.server.uptime) || 0,
          (b.process && b.process.memoryMB) || 0,
          (b.process && b.process.cpuPercent) || 0,
          (b.routes && b.routes.total) || 0,
          (b.routes && b.routes.healthy) || 0,
          (b.routes && b.routes.unhealthy) || 0,
          curTokens,
          curCost,
          curRepairs,
          curSuccesses,
          JSON.stringify(payloadJson),
        ]
      );

      // ── Upsert INCREMENTAL usage_hourly ──
      if (incTokens > 0 || incCost > 0 || incCalls > 0) {
        const incByCategory = {};
        if (!isRestart && prev && b.usage && b.usage.byCategory) {
          const prevCat =
            (prev.payload && prev.payload.byCategory) || {};
          for (const [cat, val] of Object.entries(b.usage.byCategory)) {
            const prevVal =
              (typeof prevCat[cat] === "object" ? prevCat[cat].tokens : prevCat[cat]) || 0;
            const curVal = typeof val === "object" ? val.tokens : val;
            const diff = Math.max(0, (curVal || 0) - prevVal);
            if (diff > 0) incByCategory[cat] = diff;
          }
        }

        await client.query(
          `INSERT INTO usage_hourly (server_id, hour, tokens_total, cost_total, calls_total, tokens_by_category)
           VALUES ($1, $2::timestamptz, $3, $4, $5, $6)
           ON CONFLICT (server_id, hour) DO UPDATE SET
             tokens_total = usage_hourly.tokens_total + $3,
             cost_total = usage_hourly.cost_total + $4,
             calls_total = usage_hourly.calls_total + $5,
             tokens_by_category = (
               SELECT jsonb_object_agg(
                 key,
                 COALESCE((usage_hourly.tokens_by_category->>key)::int, 0) + (value::text)::int
               )
               FROM jsonb_each($6)
             ) || COALESCE(usage_hourly.tokens_by_category, '{}'::jsonb)`,
          [serverId, hourBucket, incTokens, incCost, incCalls, JSON.stringify(incByCategory)]
        );
      }

      // ── Upsert INCREMENTAL usage_by_model ──
      if (!isRestart && prev && b.usage && b.usage.byModel) {
        const prevByModel =
          (prev.payload && prev.payload.byModel) || {};
        for (const [model, cur] of Object.entries(b.usage.byModel)) {
          const p = prevByModel[model] || {};
          const incInput = Math.max(0, (cur.inputTokens || 0) - (p.inputTokens || 0));
          const incOutput = Math.max(0, (cur.outputTokens || 0) - (p.outputTokens || 0));
          const incTotal = Math.max(0, (cur.totalTokens || cur.tokens || 0) - (p.totalTokens || p.tokens || 0));
          const incModelCalls = Math.max(0, (cur.calls || 0) - (p.calls || 0));
          const incModelCost = Math.max(0, (cur.cost || 0) - (p.cost || 0));
          const avgLatency = cur.avgLatencyMs || cur.latencyMs || 0;
          const successRate = cur.successRate != null ? cur.successRate : 1;
          const cacheSavings = cur.cacheSavings || 0;

          if (incTotal > 0 || incModelCalls > 0) {
            await client.query(
              `INSERT INTO usage_by_model
                 (server_id, hour, model, provider, input_tokens, output_tokens,
                  total_tokens, calls, cost, avg_latency_ms, success_rate, cache_savings)
               VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
               ON CONFLICT (server_id, hour, model) DO UPDATE SET
                 input_tokens = usage_by_model.input_tokens + $5,
                 output_tokens = usage_by_model.output_tokens + $6,
                 total_tokens = usage_by_model.total_tokens + $7,
                 calls = usage_by_model.calls + $8,
                 cost = usage_by_model.cost + $9,
                 avg_latency_ms = $10,
                 success_rate = $11,
                 cache_savings = usage_by_model.cache_savings + $12`,
              [
                serverId, hourBucket, model, detectProvider(model),
                incInput, incOutput, incTotal, incModelCalls, incModelCost,
                avgLatency, successRate, cacheSavings,
              ]
            );
          }
        }
      }

      // ── Record new repairs (dedup by server_id + timestamp) ──
      if (b.repairs && b.repairs.lastRepair) {
        const r = b.repairs.lastRepair;
        const repairTs = r.timestamp || now;
        await client.query(
          `INSERT INTO repairs
             (server_id, timestamp, error, resolution, success, mode, model, tokens, cost, duration_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING`,
          [
            serverId, repairTs,
            r.error || null, r.resolution || null,
            r.success != null ? r.success : true,
            r.mode || null, r.model || null,
            r.tokens || 0, r.cost || 0, r.durationMs || r.duration_ms || 0,
          ]
        );
      }

      // ── Record alerts ──
      if (b.alerts && Array.isArray(b.alerts) && b.alerts.length > 0) {
        for (const alert of b.alerts) {
          await client.query(
            `INSERT INTO alerts (server_id, type, message, severity, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              serverId,
              alert.type || "unknown",
              alert.message || "",
              alert.severity || "info",
              alert.timestamp || now,
            ]
          );
        }
      }

      await client.query("COMMIT");
      return { ok: true, restart: isRestart };
    } catch (err) {
      await client.query("ROLLBACK");
      request.log.error(err);
      return reply.code(500).send({ error: "heartbeat processing failed" });
    } finally {
      client.release();
    }
  });
}

module.exports = routes;
