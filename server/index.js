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

// Error handler
fastify.setErrorHandler((err, req, reply) => {
  console.error(`[ERROR] ${err.message}`);
  reply.code(500).send({ error: "Internal server error" });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`API:    http://localhost:${PORT}/api`);
});
