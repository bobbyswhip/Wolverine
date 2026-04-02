async function routes(fastify) {
  fastify.get("/", async () => {
    const now = new Date();
    return {
      time: now.toISOString(),
      unix: now.getTime(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  });
}

module.exports = routes;
