const crypto = require("crypto");
const { pool } = require("../lib/db");

async function routes(fastify) {
  // ── POST / — register a new wolverine instance ──
  fastify.post("/", async (request, reply) => {
    const { instanceId, name } = request.body || {};

    if (!instanceId) {
      return reply.code(400).send({ error: "instanceId required" });
    }

    const apiKey = "wv_" + crypto.randomBytes(24).toString("hex");
    const now = new Date().toISOString();
    const serverName = name || instanceId;

    await pool.query(
      `INSERT INTO servers (id, name, first_seen, last_heartbeat, status, api_key)
       VALUES ($1, $2, $3, $3, 'registered', $4)
       ON CONFLICT (id) DO UPDATE SET
         name = COALESCE($2, servers.name),
         api_key = COALESCE(servers.api_key, $4)`,
      [instanceId, serverName, now, apiKey]
    );

    // Check if this server already had a key (don't overwrite)
    const res = await pool.query(
      `SELECT api_key FROM servers WHERE id = $1`,
      [instanceId]
    );
    const finalKey = res.rows[0].api_key;

    return {
      key: finalKey,
      instanceId,
      message: "registered",
    };
  });
}

module.exports = routes;
