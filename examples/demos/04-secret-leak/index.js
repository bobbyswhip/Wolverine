const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// BUG: calls .connect() on a string — crashes and exposes TEST_PHRASE in error
const secret = process.env.TEST_PHRASE || "fallback";
const connection = secret.connect("localhost:5432");

app.get("/health", (req, res) => { res.json({ status: "ok" }); });
app.get("/", (req, res) => { res.json({ name: "Demo 04 — Secret Leak" }); });

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
