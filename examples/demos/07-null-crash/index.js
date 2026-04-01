const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// BUG: null.toString() crashes at startup
const config = null;
const appName = config.toString();

app.get("/health", (req, res) => { res.json({ status: "ok", app: appName }); });
app.get("/", (req, res) => { res.json({ name: appName }); });

app.listen(PORT, () => {
  console.log(`${appName} server on http://localhost:${PORT}`);
});
