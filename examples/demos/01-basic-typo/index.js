const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// BUG: routes/api.js references `userz` instead of `users` — crashes on require
app.use(express.json());

const healthRoutes = require("./routes/health");
const apiRoutes = require("./routes/api");

app.use("/health", healthRoutes);
app.use("/api", apiRoutes);

app.get("/", (req, res) => {
  res.json({ name: "Demo 01 — Basic Typo", status: "running" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
