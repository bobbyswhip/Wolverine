const http = require("http");
const PORT = process.env.PORT || 3000;

// BUG: null.toString() crashes at startup
const config = null;
const appName = config?.toString() || "app";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", app: appName }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`${appName} server on http://localhost:${PORT}`);
});
