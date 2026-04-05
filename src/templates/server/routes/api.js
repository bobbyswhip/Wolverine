/**
 * Demo API routes — free endpoints and x402 paid APIs.
 *
 * x402 Setup (one-time):
 *   1. wolverine --init-vault          Create encrypted wallet
 *   2. Set CDP_API_KEY_ID + CDP_API_KEY_SECRET in .env.local
 *      (free at https://cdp.coinbase.com)
 *   3. Add { config: { x402: { price: "$0.01" } } } to any route
 *
 * That's it — the route now requires USDC payment on Base.
 * The middleware handles 402 responses, wallet signing, facilitator
 * verification, and on-chain settlement automatically.
 *
 * Protocol: https://docs.cdp.coinbase.com/x402/welcome
 * Network:  Base mainnet — USDC payments
 * Wallet:   Auto-detected from vault
 * Node:     22+ required
 */

async function routes(fastify) {
  // ── Free endpoints (no x402 config = no payment required) ──

  fastify.get("/", async () => ({ message: "Hello from Wolverine API" }));

  fastify.get("/users", async () => ({
    users: [
      { id: 1, name: "Alice", role: "admin" },
      { id: 2, name: "Bob", role: "user" },
    ],
  }));

  // ── Paid endpoint — fixed price ──
  // Just add x402 config. Handler only runs after USDC settles on-chain.
  fastify.get("/premium", {
    config: { x402: { price: "$0.01", description: "Premium data endpoint" } },
  }, async (req) => ({
    data: "This response cost $0.01 in USDC on Base",
    paid: req.x402.amount,
    from: req.x402.from,
    txHash: req.x402.txHash,
  }));

  // ── Paid endpoint — variable price ──
  // Caller specifies amount in request body. Good for credit purchases.
  // POST /api/purchase { "dollars": "5.00" }
  fastify.post("/purchase", {
    config: {
      x402: {
        variable: true,
        min: "$1",
        max: "$1000",
        priceField: "dollars",
        description: "Purchase API credits with USDC",
      },
    },
  }, async (req) => ({
    message: `Received ${req.x402.amount} USDC payment`,
    from: req.x402.from,
    txHash: req.x402.txHash,
    settled: req.x402.settled,
  }));
}

module.exports = routes;
