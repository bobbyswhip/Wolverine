const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// BUG: extra closing paren on the route handler
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
}));

app.get("/", (req, res) => {
  res.json({ name: "Demo 03 — Syntax Error", status: "running" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
