const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

// BUG: config.json has "databse" not "database"
const dbHost = config.databse.host;
const dbPort = config.databse.port;

console.log(`Connecting to database at ${dbHost}:${dbPort}`);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", db: `${dbHost}:${dbPort}` }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
