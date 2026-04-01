/**
 * User routes module.
 * Exports `getUsers` but the server imports `fetchUsers` — name mismatch.
 */

const users = [
  { id: 1, name: "Alice", role: "admin" },
  { id: 2, name: "Bob", role: "user" },
];

function getUsers() {
  return { users, count: users.length };
}

module.exports = { getUsers };
