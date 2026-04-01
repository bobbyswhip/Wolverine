const http = require("http");
const PORT = process.env.PORT || 3000;

function formatResponse(data) {
  return JSON.stringify({ timestamp: Date.now(), data: data });
}

const server = http.createServer((req, res) => {
  if (req.url === "/api/data") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(formatResponse({ status: "ok" }));
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(formatResponse({ status: "healthy" }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
