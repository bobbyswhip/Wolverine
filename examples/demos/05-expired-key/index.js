const express = require("express");
const https = require("https");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// BUG: calls a non-existent API, then throws on the error
const req = https.get({ hostname: "api.example-that-does-not-exist.com", path: "/v1/data" }, (res) => {
  console.log("Status:", res.statusCode);
});
req.on("error", (err) => {
  throw new Error(`503 Service Unavailable: External API down - ${err.message}`);
});

app.get("/health", (req, res) => { res.json({ status: "ok" }); });
app.get("/", (req, res) => { res.json({ name: "Demo 05 — Expired Key" }); });

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
