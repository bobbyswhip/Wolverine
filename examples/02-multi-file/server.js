const http = require("http");
const { getUsers } = require("./routes/users");

const PORT = process.env.PORT || 3000;

const initialData = getUsers();
console.log(`Loaded ${initialData.count} users`);

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/users" && req.method === "GET") {
    const data = getUsers();
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
