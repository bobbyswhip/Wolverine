const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
const healthRoutes = require("./routes/health");
const apiRoutes = require("./routes/api");
const timeRoutes = require("./routes/time");

app.use("/health", healthRoutes);
app.use("/api", apiRoutes);
app.use("/time", timeRoutes);

// Root
app.get("/", (req, res) => {
  res.json({
    name: "Wolverine Server",
    version: "1.0.0",
    status: "running",
    uptime: process.uptime(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`API:    http://localhost:${PORT}/api`);
});
