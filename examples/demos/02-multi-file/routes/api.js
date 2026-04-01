const express = require("express");
const router = express.Router();

const users = [
  { id: 1, name: "Alice", role: "admin" },
  { id: 2, name: "Bob", role: "user" },
];

// Exports getUsers, but index.js imports fetchUsers — name mismatch
function getUsers() { return { users, count: users.length }; }

router.get("/users", (req, res) => { res.json(getUsers()); });
module.exports = { getUsers };
