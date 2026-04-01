const express = require("express");
const router = express.Router();

router.get("/", (req, res) => {
  const now = new Date();
  res.json({
    time: now.toISOString(),
    unix: now.getTime(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

module.exports = router;
