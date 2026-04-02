async function routes(fastify) {
  fastify.get("/", async () => {
    const mem = process.memoryUsage();
    return {
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      memory: {
        rss: Math.round(mem.rss / 1048576) + "MB",
        heap: Math.round(mem.heapUsed / 1048576) + "MB",
      },
    };
  });
}

module.exports = routes;
