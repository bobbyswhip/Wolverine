const express = require("express");
const router = express.Router();

// Hello world
router.get("/", (req, res) => {
  res.json({ message: "Hello from Wolverine API" });
});

// Example: users endpoint
router.get("/users", (req, res) => {
  res.json({
    users: [
      { id: 1, name: "Alice", role: "admin" },
      { id: 2, name: "Bob", role: "user" },
    ],
  });
});

module.exports = router;
