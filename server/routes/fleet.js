/**
 * GPU Fleet Management API — admin routes for controlling inference GPUs.
 *
 * Endpoints:
 *   GET  /status          — fleet overview (all GPUs, health, queue)
 *   POST /start/:id       — start a stopped GPU
 *   POST /stop/:id        — stop a running GPU
 *   POST /register        — add a new GPU to the fleet
 *   POST /remove/:id      — remove a GPU from the fleet
 *   POST /scale           — trigger auto-scale check
 *   GET  /benchmark/:id   — run inference benchmark on a GPU
 */

async function routes(fastify) {
  const { pool } = require("../lib/db");

  // Fleet instance is attached to fastify by index.js
  function getFleet() {
    return fastify.gpuFleet;
  }

  // Admin auth
  async function requireAdmin(request, reply) {
    const settings = require("../config/settings.json");
    const token = request.headers.authorization?.replace("Bearer ", "") || request.headers["x-api-key"];
    if (token !== settings.platform?.apiKey) {
      return reply.code(401).send({ error: "Admin access required" });
    }
  }

  // GET /status — fleet overview
  fastify.get("/status", { preHandler: requireAdmin }, async (request, reply) => {
    const fleet = getFleet();
    return fleet.getStatus();
  });

  // POST /start/:id — start a GPU
  fastify.post("/start/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const fleet = getFleet();
    const { id } = request.params;
    try {
      const gpu = await fleet.startGpu(id);
      // Update DB
      await pool.query("UPDATE gpu_fleet SET status = 'healthy' WHERE instance_id = $1", [id]).catch(() => {});
      return { status: "started", instanceId: id, coldStartMs: gpu.coldStartMs };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /stop/:id — stop a GPU
  fastify.post("/stop/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const fleet = getFleet();
    const { id } = request.params;
    try {
      await fleet.stopGpu(id);
      await pool.query("UPDATE gpu_fleet SET status = 'stopped' WHERE instance_id = $1", [id]).catch(() => {});
      return { status: "stopped", instanceId: id };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /register — add a GPU to the fleet
  fastify.post("/register", { preHandler: requireAdmin }, async (request, reply) => {
    const fleet = getFleet();
    const { instanceId, vastId, host, port, key, model, role, gpuName, autoStop } = request.body || {};
    if (!instanceId || !host || !key) {
      return reply.code(400).send({ error: "instanceId, host, and key required" });
    }

    fleet.register(instanceId, { host, port: port || 8080, key, model, role, autoStop: autoStop !== false });
    const gpu = fleet.gpus.get(instanceId);
    if (vastId) gpu.vastId = vastId;
    if (gpuName) gpu.gpuName = gpuName;

    // Save to DB
    await pool.query(
      `INSERT INTO gpu_fleet (instance_id, vast_id, host, port, internal_key, model, role, auto_stop, gpu_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (instance_id) DO UPDATE SET
         host = $3, port = $4, internal_key = $5, model = $6, role = $7, auto_stop = $8, gpu_name = $9, vast_id = $2`,
      [instanceId, vastId || null, host, port || 8080, key, model || "wolverine-test-1", role || "general", autoStop !== false, gpuName || null]
    );

    return { registered: instanceId, fleet: fleet.getStatus() };
  });

  // POST /remove/:id — remove a GPU from the fleet
  fastify.post("/remove/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const fleet = getFleet();
    const { id } = request.params;
    fleet.gpus.delete(id);
    await pool.query("DELETE FROM gpu_fleet WHERE instance_id = $1", [id]).catch(() => {});
    return { removed: id };
  });

  // POST /scale — trigger auto-scale
  fastify.post("/scale", { preHandler: requireAdmin }, async (request, reply) => {
    const fleet = getFleet();
    const queueLength = request.body?.queueLength || 0;
    await fleet.autoScale(queueLength);
    return fleet.getStatus();
  });

  // GET /benchmark/:id — quick benchmark
  fastify.get("/benchmark/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const fleet = getFleet();
    const gpu = fleet.gpus.get(request.params.id);
    if (!gpu || gpu.status !== "healthy") {
      return reply.code(400).send({ error: "GPU not available" });
    }

    const http = require("http");
    const results = [];

    for (const prompt of ["2+2?", "Write isPrime in JS.", "Explain TCP in 1 sentence."]) {
      const start = Date.now();
      try {
        const body = JSON.stringify({
          model: gpu.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 50, temperature: 0,
        });
        const res = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: gpu.host, port: gpu.port, path: "/v1/chat/completions",
            method: "POST", timeout: 30000,
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${gpu.key}`, "Content-Length": Buffer.byteLength(body) },
          }, (res) => {
            let data = "";
            res.on("data", c => { data += c; });
            res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
          });
          req.on("error", reject);
          req.write(body);
          req.end();
        });

        const elapsed = Date.now() - start;
        const usage = res?.usage || {};
        const tokOut = usage.completion_tokens || 0;
        results.push({
          prompt: prompt.slice(0, 30),
          latencyMs: elapsed,
          tokensOut: tokOut,
          tokPerSec: tokOut > 0 ? Math.round(tokOut / (elapsed / 1000)) : 0,
          response: res?.choices?.[0]?.message?.content?.slice(0, 60),
        });
      } catch (err) {
        results.push({ prompt: prompt.slice(0, 30), error: err.message });
      }
    }

    const avgTokPerSec = results.filter(r => r.tokPerSec).reduce((s, r) => s + r.tokPerSec, 0) / Math.max(results.filter(r => r.tokPerSec).length, 1);

    return {
      instanceId: request.params.id,
      gpu: gpu.gpuName,
      model: gpu.model,
      results,
      avgTokPerSec: Math.round(avgTokPerSec),
    };
  });
}

module.exports = routes;
