const cluster = require("cluster");
const os = require("os");
const PORT = process.env.PORT || 3000;

// Cluster mode: master forks workers, workers run the server.
// Wolverine sets WOLVERINE_RECOMMENDED_WORKERS based on system detection.
// Set cluster.enabled=true in settings.json or WOLVERINE_CLUSTER=true to enable.
const clusterEnabled = process.env.WOLVERINE_CLUSTER === "true";
const workerCount = parseInt(process.env.WOLVERINE_RECOMMENDED_WORKERS, 10) || os.cpus().length;

if (clusterEnabled && cluster.isPrimary && workerCount > 1) {
  console.log(`[CLUSTER] Primary ${process.pid} forking ${workerCount} workers`);
  for (let i = 0; i < workerCount; i++) cluster.fork();

  cluster.on("exit", (worker, code) => {
    if (code !== 0) {
      console.log(`[CLUSTER] Worker ${worker.process.pid} died (code ${code}), respawning...`);
      cluster.fork();
    }
  });
} else {
  // Single worker or cluster worker — run the server
  const fastify = require("fastify")({ logger: false });

  // x402 payment middleware (auto-detects vault, no-op if no vault)
  try { fastify.register(require("wolverine-ai/src/middleware/x402-fastify")); } catch {}

  // Routes
  fastify.register(require("./routes/health"), { prefix: "/health" });
  fastify.register(require("./routes/api"), { prefix: "/api" });
  fastify.register(require("./routes/time"), { prefix: "/time" });

  // Root
  fastify.get("/", async () => ({
    name: "Wolverine Server",
    version: "1.0.0",
    status: "running",
    uptime: process.uptime(),
    pid: process.pid,
    worker: cluster.isWorker ? cluster.worker.id : "primary",
  }));

  // 404
  fastify.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: "Not found", path: req.url });
  });

  // Error handler — reports to Wolverine parent via IPC for auto-healing
  fastify.setErrorHandler((err, req, reply) => {
    console.error(`[ERROR] ${err.message}`);
    reply.code(500).send({ error: err.message });

    // Report to Wolverine via IPC (if running under wolverine)
    if (typeof process.send === "function") {
      try {
        let file = null, line = null;
        if (err.stack) {
          const frames = err.stack.split("\n");
          for (const frame of frames) {
            const m = frame.match(/\(([^)]+):(\d+):(\d+)\)/) || frame.match(/at\s+([^\s(]+):(\d+):(\d+)/);
            if (m && !m[1].includes("node_modules") && !m[1].includes("node:")) {
              file = m[1]; line = parseInt(m[2], 10); break;
            }
          }
        }
        process.send({
          type: "route_error",
          path: req.url,
          method: req.method,
          statusCode: 500,
          message: err.message,
          stack: err.stack,
          file,
          line,
          timestamp: Date.now(),
        });
      } catch (_) { /* IPC send failed — non-fatal */ }
    }
  });

  fastify.listen({ port: PORT, host: "0.0.0.0", reusePort: clusterEnabled }, (err) => {
    if (err) { console.error(err); process.exit(1); }
    const label = cluster.isWorker ? ` (worker ${cluster.worker.id})` : "";
    console.log(`Server running on http://localhost:${PORT}${label}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`API:    http://localhost:${PORT}/api`);
  });
}
