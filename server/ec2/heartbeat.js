async function routes(fastify) {
  const { pool } = require("../lib/db");

  function detectProvider(model) {
    if (!model) return "openai";
    if (/^wolverine|^gemma/i.test(model)) return "wolverine";
    if (/^claude|^anthropic/i.test(model)) return "anthropic";
    if (/^gemini|^google/i.test(model)) return "google";
    if (/^mistral|^codestral|^pixtral/i.test(model)) return "mistral";
    if (/^llama|^meta/i.test(model)) return "meta";
    if (/^deepseek/i.test(model)) return "deepseek";
    if (/^command|^cohere/i.test(model)) return "cohere";
    return "openai";
  }

  // ── Anti-abuse ──
  const KNOWN_PROVIDERS = new Set(["openai", "anthropic", "wolverine", "google", "mistral", "meta", "deepseek", "cohere"]);
  const _rateMap = new Map();
  const MIN_INTERVAL_MS = 25000;

  function validateHeartbeat(b, prev) {
    const issues = [];
    const curTokens = b.usage?.totalTokens || 0;
    const curCost = b.usage?.totalCost || 0;
    const prevTokens = parseInt(prev?.tokens_total) || 0;
    const prevCost = parseFloat(prev?.cost_total) || 0;

    if (prevTokens > 0 && curTokens > prevTokens * 10 && curTokens - prevTokens > 100000) {
      issues.push("token_spike");
    }
    if (prevCost > 0 && curCost - prevCost > 10) {
      issues.push("cost_spike");
    }
    const byModel = b.usage?.byModel || {};
    for (const model of Object.keys(byModel)) {
      if (!KNOWN_PROVIDERS.has(detectProvider(model)) && !/^wolverine|^gpt|^claude|^gemma|^o[1-9]/.test(model)) {
        issues.push("unknown_model:" + model);
      }
    }
    const mcArr = Array.isArray(b.usage?.byModelCategory) ? b.usage.byModelCategory : Object.values(b.usage?.byModelCategory || {});
    for (const mc of mcArr) {
      if (mc.successRate != null && (mc.successRate < 0 || mc.successRate > 100)) {
        issues.push("invalid_success_rate");
      }
    }
    if (b.process?.memoryMB > 65536) issues.push("memory_impossible");
    if (b.process?.cpuPercent > 10000) issues.push("cpu_impossible");
    return issues;
  }

  let _hbCount = 0;
  async function cleanupStale() {
    try {
      await pool.query("UPDATE servers SET status = 'down' WHERE status = 'healthy' AND last_heartbeat < NOW() - INTERVAL '5 minutes'");
      await pool.query("DELETE FROM servers WHERE id IN (SELECT s.id FROM servers s LEFT JOIN heartbeats h ON h.server_id = s.id WHERE h.id IS NULL AND s.first_seen < NOW() - INTERVAL '1 hour')");
      await pool.query("DELETE FROM servers WHERE last_heartbeat < NOW() - INTERVAL '7 days'");
    } catch {}
  }

  // ── POST / — receive heartbeat ──
  fastify.post("/", async (request, reply) => {
    const serverId = request.authenticatedServerId || request.body?.instanceId;
    if (!serverId) return reply.code(400).send({ error: "No server identified" });

    // Rate limit: 1 heartbeat per 25s per server
    const now = Date.now();
    const lastHb = _rateMap.get(serverId) || 0;
    if (now - lastHb < MIN_INTERVAL_MS) {
      return reply.code(429).send({ error: "Rate limited", retry_after_ms: MIN_INTERVAL_MS - (now - lastHb) });
    }
    _rateMap.set(serverId, now);

    const b = request.body || {};
    const nowDate = new Date();
    const hour = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), nowDate.getHours());

    try {
      const prev = await pool.query(
        "SELECT tokens_total, cost_total, repairs_total, payload FROM heartbeats WHERE server_id = $1 ORDER BY timestamp DESC LIMIT 1",
        [serverId]
      );
      const p = prev.rows[0] || { tokens_total: 0, cost_total: 0, repairs_total: 0 };

      // Validate
      const issues = validateHeartbeat(b, p);
      if (issues.length > 0) {
        console.error("[HB-REJECTED]", serverId, issues.join(", "));
        await pool.query("UPDATE servers SET status = 'flagged' WHERE id = $1", [serverId]);
        return reply.code(422).send({ error: "Heartbeat rejected", issues });
      }

      const prevTokens = parseInt(p.tokens_total) || 0;
      const prevCost = parseFloat(p.cost_total) || 0;
      const prevModels = p.payload?.byModel || {};
      const curTokens = b.usage?.totalTokens || 0;
      const curCost = b.usage?.totalCost || 0;
      const isRestart = curTokens < prevTokens * 0.5;
      const incTokens = isRestart ? 0 : Math.max(0, curTokens - prevTokens);
      const incCost = isRestart ? 0 : Math.max(0, curCost - prevCost);

      await pool.query(
        `UPDATE servers SET last_heartbeat = NOW(), status = 'healthy',
          version = COALESCE($2, version), config = COALESCE($3, config)
         WHERE id = $1`,
        [serverId, b.version || null, JSON.stringify({
          port: b.server?.port,
          provider: b.usage?.byProvider ? Object.keys(b.usage.byProvider).join("+") : null,
        })]
      );

      await pool.query(
        `INSERT INTO heartbeats (server_id, timestamp, uptime, memory_mb, cpu_percent,
          routes_total, routes_healthy, routes_unhealthy,
          tokens_total, cost_total, repairs_total, repairs_successes, payload)
         VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [serverId, b.server?.uptime || 0, b.process?.memoryMB || 0, b.process?.cpuPercent || 0,
         b.routes?.total || 0, b.routes?.healthy || 0, b.routes?.unhealthy || 0,
         curTokens, curCost, b.repairs?.total || 0, b.repairs?.successes || 0,
         JSON.stringify({
           brain: b.brain, backups: b.backups,
           byCategory: b.usage?.byCategory, byModel: b.usage?.byModel,
           byTool: b.usage?.byTool, byProvider: b.usage?.byProvider, byModelCategory: b.usage?.byModelCategory,
         })]
      );

      if (incTokens > 0 || incCost > 0) {
        await pool.query(
          `INSERT INTO usage_hourly (server_id, hour, tokens_total, cost_total, calls_total, tokens_by_category)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (server_id, hour) DO UPDATE SET
             tokens_total = usage_hourly.tokens_total + $3,
             cost_total = usage_hourly.cost_total + $4,
             calls_total = usage_hourly.calls_total + $5,
             tokens_by_category = COALESCE($6, usage_hourly.tokens_by_category)`,
          [serverId, hour, incTokens, incCost, Math.max(1, Math.round(incTokens / 1200)),
           JSON.stringify(b.usage?.byCategory || {})]
        );
      }

      const byModel = b.usage?.byModel || {};
      for (const [model, stats] of Object.entries(byModel)) {
        if (!stats || !model) continue;
        const pm = prevModels[model] || {};
        const provider = detectProvider(model);
        const di = isRestart ? 0 : Math.max(0, (stats.input || 0) - (pm.input || 0));
        const do_ = isRestart ? 0 : Math.max(0, (stats.output || 0) - (pm.output || 0));
        const dt = isRestart ? 0 : Math.max(0, (stats.total || 0) - (pm.total || 0));
        const dc = isRestart ? 0 : Math.max(0, (stats.calls || 0) - (pm.calls || 0));
        const dco = isRestart ? 0 : Math.max(0, (stats.cost || 0) - (pm.cost || 0));
        if (dt === 0 && dco === 0) continue;

        await pool.query(
          `INSERT INTO usage_by_model (server_id, hour, model, provider, input_tokens, output_tokens, total_tokens, calls, cost, avg_latency_ms, success_rate, cache_savings)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (server_id, hour, model) DO UPDATE SET
             input_tokens = usage_by_model.input_tokens + $5,
             output_tokens = usage_by_model.output_tokens + $6,
             total_tokens = usage_by_model.total_tokens + $7,
             calls = usage_by_model.calls + $8,
             cost = usage_by_model.cost + $9,
             avg_latency_ms = COALESCE($10, usage_by_model.avg_latency_ms),
             success_rate = COALESCE($11, usage_by_model.success_rate),
             cache_savings = usage_by_model.cache_savings + COALESCE($12, 0)`,
          [serverId, hour, model, provider, di, do_, dt, dc, dco,
           stats.avgLatencyMs || null,
           stats.successRate != null ? stats.successRate / 100 : null,
           Math.max(0, (stats.cacheSavings || 0) - (pm.cacheSavings || 0))]
        );
      }

      if (b.repairs?.lastRepair && b.repairs.lastRepair.timestamp) {
        const lr = b.repairs.lastRepair;
        const repairTs = new Date(lr.timestamp);
        const exists = await pool.query(
          "SELECT 1 FROM repairs WHERE server_id = $1 AND timestamp = $2 LIMIT 1",
          [serverId, repairTs]
        );
        if (exists.rows.length === 0) {
          await pool.query(
            `INSERT INTO repairs (server_id, timestamp, error, resolution, success, mode, model, tokens, cost, duration_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [serverId, repairTs, (lr.error || "").slice(0, 500), (lr.resolution || "").slice(0, 500),
             lr.success, lr.mode, lr.model, lr.tokens || 0, lr.cost || 0, lr.duration || 0]
          );
        }
      }

      if (b.alerts && Array.isArray(b.alerts)) {
        for (const alert of b.alerts) {
          const msg = (alert.error || alert.message || "").slice(0, 500);
          const type = alert.type || "unknown";
          // Dedup: skip if same server + type + message already exists in last 24h
          const dupe = await pool.query(
            "SELECT 1 FROM alerts WHERE server_id = $1 AND type = $2 AND message = $3 AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1",
            [serverId, type, msg]
          );
          if (dupe.rows.length === 0) {
            await pool.query(
              "INSERT INTO alerts (server_id, type, message, severity) VALUES ($1, $2, $3, $4)",
              [serverId, type, msg, alert.severity || "medium"]
            );
          }
        }
      }

      _hbCount++;
      if (_hbCount % 100 === 0) cleanupStale();

      return { status: "ok", timestamp: nowDate.toISOString() };
    } catch (err) {
      console.error("[HB-ROUTE-ERR]", err.message);
      return reply.code(500).send({ error: "Heartbeat processing failed" });
    }
  });

  // ── DELETE /purge/:serverId — admin: dump a bad server and ALL its data ──
  fastify.delete("/purge/:serverId", async (request, reply) => {
    const token = request.headers.authorization?.replace("Bearer ", "");
    let settings = {};
    try { settings = require("../config/settings.json"); } catch {}
    if (token !== settings.platform?.apiKey) {
      return reply.code(403).send({ error: "Admin only" });
    }

    const { serverId } = request.params;
    const counts = {};
    for (const [table, col] of [["heartbeats","server_id"],["usage_hourly","server_id"],["usage_by_model","server_id"],["repairs","server_id"],["alerts","server_id"]]) {
      const r = await pool.query(`DELETE FROM ${table} WHERE ${col} = $1`, [serverId]);
      counts[table] = r.rowCount;
    }
    try {
      await pool.query("DELETE FROM servers WHERE id = $1", [serverId]);
      counts.server = 1;
    } catch (e) { counts.server_error = e.message; }

    console.log("[PURGE]", serverId, counts);
    return { purged: serverId, counts };
  });
}

module.exports = routes;
