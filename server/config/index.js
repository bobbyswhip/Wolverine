/**
 * Server Configuration — loaded by routes and middleware.
 *
 * Non-secret settings for the user's server.
 * Secrets (DB passwords, API keys) stay in .env.local.
 */

module.exports = {
  app: {
    name: "Wolverine Server",
    version: "1.0.0",
  },

  // Add your server-specific config here.
  // Examples:
  // database: {
  //   host: "localhost",
  //   port: 5432,
  //   name: "myapp",
  // },
  // cache: {
  //   enabled: true,
  //   ttlSeconds: 3600,
  // },
};
