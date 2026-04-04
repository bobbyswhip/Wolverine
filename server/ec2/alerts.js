const { pool } = require("../lib/db");

async function routes(fastify) {
  // ── GET / — list active (unresolved) alerts with server name ──
  fastify.get("/", async (request) => {
    const limit = Math.min(parseInt(request.query.limit, 10) || 100, 500);
    const offset = parseInt(request.query.offset, 10) || 0;

    const res = await pool.query(
      `SELECT a.*, s.name AS server_name
       FROM alerts a
       LEFT JOIN servers s ON s.id = a.server_id
       WHERE a.resolved_at IS NULL
       ORDER BY a.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countRes = await pool.query(
      `SELECT COUNT(*) AS total FROM alerts WHERE resolved_at IS NULL`
    );

    return {
      alerts: res.rows,
      total: parseInt(countRes.rows[0].total, 10),
      limit,
      offset,
    };
  });

  // ── POST /:id/acknowledge — mark alert as acknowledged ──
  fastify.post("/:id/acknowledge", async (request, reply) => {
    const { id } = request.params;
    const { acknowledgedBy } = request.body || {};

    const res = await pool.query(
      `UPDATE alerts
       SET acknowledged_at = NOW(),
           acknowledged_by = $2
       WHERE id = $1 AND acknowledged_at IS NULL
       RETURNING *`,
      [id, acknowledgedBy || null]
    );

    if (res.rows.length === 0) {
      return reply.code(404).send({ error: "alert not found or already acknowledged" });
    }

    return { ok: true, alert: res.rows[0] };
  });

  // ── POST /:id/resolve — mark alert as resolved ──
  fastify.post("/:id/resolve", async (request, reply) => {
    const { id } = request.params;

    const res = await pool.query(
      `UPDATE alerts
       SET resolved_at = NOW()
       WHERE id = $1 AND resolved_at IS NULL
       RETURNING *`,
      [id]
    );

    if (res.rows.length === 0) {
      return reply.code(404).send({ error: "alert not found or already resolved" });
    }

    return { ok: true, alert: res.rows[0] };
  });
}

module.exports = routes;
