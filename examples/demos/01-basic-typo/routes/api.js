const express = require("express");
const router = express.Router();

const users = [
  { id: 1, name: "Alice" },
  { id: 2, name: "Bob" },
];

// BUG: `userz` should be `users` — crashes on startup when building cache
const userCache = JSON.stringify(userz);

router.get("/users", (req, res) => { res.json(JSON.parse(userCache)); });
module.exports = router;
