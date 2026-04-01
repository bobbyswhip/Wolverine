const http = require("http");
const https = require("https");
const PORT = process.env.PORT || 3000;

const options = {
  hostname: "api.example-that-does-not-exist.com",
  path: "/v1/data",
  headers: { "Authorization": "Bearer expired_token_12345" },
};

// BUG: throws on ENOTFOUND — should be caught, not thrown
const req = https.get(options, (res) => {
  console.log("Status:", res.statusCode);
});

req.on("error", (err) => {
  throw new Error(`503 Service Unavailable: External API down - ${err.message}`);
});

const server = http.createServer((reqIn, res) => {
  res.writeHead(200);
  res.end("ok");
});

server.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
