const http = require("http");
const { fetchUsers } = require("./routes/users");

const PORT = process.env.PORT || 3000;

// BUG: fetchUsers is undefined because users.js exports getUsers
const initialData = fetchUsers();
console.log(`Loaded ${initialData.count} users`);

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/users" && req.method === "GET") {
    const data = fetchUsers();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Multi-file server on http://localhost:${PORT}`);
});
