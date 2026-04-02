async function routes(fastify) {
  fastify.get("/", async () => ({ message: "Hello from Wolverine API" }));

  fastify.get("/users", async () => ({
    users: [
      { id: 1, name: "Alice", role: "admin" },
      { id: 2, name: "Bob", role: "user" },
    ],
  }));
}

module.exports = routes;
