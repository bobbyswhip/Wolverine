/**
 * Example: A deliberately buggy HTTP server.
 * Wolverine will detect the crash on startup and fix it automatically.
 *
 * BUG: `parseConfig` calls `settings.toUpperCase()` but settings is an object, not a string.
 */

const http = require("http");

const PORT = process.env.PORT || 3000;

const settings = { mode: "production", debug: false };

// BUG: settings is an object, calling .toUpperCase() on it will throw
const configMode = settings.mode.toUpperCase();

const users = [
  { id: 1, name: "Alice", role: configMode },
  { id: 2, name: "Bob", role: "user" },
];

const server = http.createServer((req, res) => {
  if (req.url === "/api/users" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ users }));
  } else if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Users:  http://localhost:${PORT}/api/users`);
});
