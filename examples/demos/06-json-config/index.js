const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// BUG: config.json has "databse" not "database"
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));
const dbHost = config.database.host;
const dbPort = config.database.port;
console.log(`Connecting to database at ${dbHost}:${dbPort}`);

app.get("/health", (req, res) => { res.json({ status: "ok", db: `${dbHost}:${dbPort}` }); });
app.get("/", (req, res) => { res.json({ name: "Demo 06 — JSON Config" }); });

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
