const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const healthRoutes = require("./routes/health");
const apiRoutes = require("./routes/api");

app.use("/health", healthRoutes);
app.use("/api", apiRoutes);

// BUG: fetchUsers doesn't exist — routes/api.js exports getUsers
const { fetchUsers } = require("./routes/api");
const initialData = fetchUsers();
console.log(`Loaded ${initialData.count} users`);

app.get("/", (req, res) => {
  res.json({ name: "Demo 02 — Multi-File", status: "running" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
