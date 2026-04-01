const http = require("http");
const PORT = process.env.PORT || 3000;

// BUG: requires a module that will never exist — unfixable
const fakeModule = require("./nonexistent-module-that-will-never-exist");

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ok");
});

server.listen(PORT);
