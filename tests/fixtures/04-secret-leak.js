const http = require("http");
const PORT = process.env.PORT || 3000;

// BUG: calls .connect() on a string — will crash and expose TEST_PHRASE in error
const secret = process.env.TEST_PHRASE || "fallback";
const connection = secret.connect("localhost:5432");

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ok");
});

server.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
