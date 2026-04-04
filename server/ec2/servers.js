const { pool } = require("../lib/db");

async function routes(fastify) {
  // ── GET / — list all servers with latest heartbeat as live data ──
  fastify.get("/", async (request) => {
    const limit = Math.min(parseInt(request.query.limit, 10) || 50, 200);
    const offset = parseInt(request.query.offset, 10) || 0;

    const res = await pool.query(
      `SELECT s.id, s.name, s.version, s.first_seen, s.last_heartbeat, s.status, s.config,
              h.uptime, h.memory_mb, h.cpu_percent,
              h.routes_total, h.routes_healthy, h.routes_unhealthy,
              h.tokens_total, h.cost_total,
              h.repairs_total, h.repairs_successes,
              h.payload
       FROM servers s
       LEFT JOIN LATERAL (
         SELECT * FROM heartbeats WHERE server_id = s.id
         ORDER BY timestamp DESC LIMIT 1
       ) h ON true
       ORDER BY s.last_heartbeat DESC NULLS LAST
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM servers`);

    const servers = res.rows.map((r) => {
      const isDown =
        !r.last_heartbeat ||
        new Date() - new Date(r.last_heartbeat) > 3 * 60 * 1000;

      return {
        id: r.id,
        name: r.name,
        version: r.version,
        first_seen: r.first_seen,
        last_heartbeat: r.last_heartbeat,
        status: isDown ? "down" : "healthy",
        config: r.config,
        live: {
          process: {
            memoryMB: r.memory_mb || 0,
            cpuPercent: r.cpu_percent || 0,
          },
          server: {
            uptime: r.uptime || 0,
          },
          routes: {
            total: r.routes_total || 0,
            healthy: r.routes_healthy || 0,
            unhealthy: r.routes_unhealthy || 0,
          },
          repairs: {
            total: r.repairs_total || 0,
            successes: r.repairs_successes || 0,
          },
          usage: {
            totalTokens: r.tokens_total || 0,
            totalCost: parseFloat(r.cost_total) || 0,
            byModel: (r.payload && r.payload.byModel) || {},
            byProvider: (r.payload && r.payload.byProvider) || {},
            byCategory: (r.payload && r.payload.byCategory) || {},
          },
        },
      };
    });

    return {
      servers,
      total: parseInt(countRes.rows[0].total, 10),
      page: 1,
    };
  });

  // ── GET /:id — single server with heartbeats, repairs, alerts ──
  fastify.get("/:id", async (request, reply) => {
    const { id } = request.params;

    const srvRes = await pool.query(
      `SELECT * FROM servers WHERE id = $1`,
      [id]
    );
    if (srvRes.rows.length === 0) {
      return reply.code(404).send({ error: "server not found" });
    }
    const server = srvRes.rows[0];
    const isDown =
      !server.last_heartbeat ||
      new Date() - new Date(server.last_heartbeat) > 3 * 60 * 1000;
    server.status = isDown ? "down" : server.status;

    // Recent heartbeats
    const hbRes = await pool.query(
      `SELECT * FROM heartbeats WHERE server_id = $1
       ORDER BY timestamp DESC LIMIT 50`,
      [id]
    );

    // Recent repairs
    const repRes = await pool.query(
      `SELECT * FROM repairs WHERE server_id = $1
       ORDER BY timestamp DESC LIMIT 50`,
      [id]
    );

    // Active alerts
    const alertRes = await pool.query(
      `SELECT * FROM alerts WHERE server_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [id]
    );

    return {
      server,
      heartbeats: hbRes.rows,
      repairs: repRes.rows,
      alerts: alertRes.rows,
    };
  });

  // ── GET /:id/heartbeats — paginated heartbeat history ──
  fastify.get("/:id/heartbeats", async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit, 10) || 50, 200);
    const offset = parseInt(request.query.offset, 10) || 0;

    const srvRes = await pool.query(
      `SELECT id FROM servers WHERE id = $1`,
      [id]
    );
    if (srvRes.rows.length === 0) {
      return reply.code(404).send({ error: "server not found" });
    }

    const res = await pool.query(
      `SELECT * FROM heartbeats WHERE server_id = $1
       ORDER BY timestamp DESC LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    const countRes = await pool.query(
      `SELECT COUNT(*) AS total FROM heartbeats WHERE server_id = $1`,
      [id]
    );

    return {
      heartbeats: res.rows,
      total: parseInt(countRes.rows[0].total, 10),
      limit,
      offset,
    };
  });

  // ── GET /:id/repairs — paginated repair history with stats ──
  fastify.get("/:id/repairs", async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit, 10) || 50, 200);
    const offset = parseInt(request.query.offset, 10) || 0;

    const srvRes = await pool.query(
      `SELECT id FROM servers WHERE id = $1`,
      [id]
    );
    if (srvRes.rows.length === 0) {
      return reply.code(404).send({ error: "server not found" });
    }

    const res = await pool.query(
      `SELECT * FROM repairs WHERE server_id = $1
       ORDER BY timestamp DESC LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    const statsRes = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE success) AS successes,
         COUNT(*) FILTER (WHERE NOT success) AS failures,
         ROUND(AVG(CASE WHEN success THEN 1 ELSE 0 END) * 100, 2) AS success_rate,
         COALESCE(SUM(cost), 0) AS total_cost,
         COALESCE(SUM(tokens), 0) AS total_tokens,
         ROUND(AVG(duration_ms)) AS avg_duration_ms
       FROM repairs WHERE server_id = $1`,
      [id]
    );

    return {
      repairs: res.rows,
      stats: statsRes.rows[0],
      limit,
      offset,
    };
  });
}

module.exports = routes;
