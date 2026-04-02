const fastify = require("fastify")({ logger: false });
const PORT = process.env.PORT || 3000;

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
      // Extract file/line from stack trace
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

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`API:    http://localhost:${PORT}/api`);
});
