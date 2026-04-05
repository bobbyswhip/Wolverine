/**
 * Demo API routes — shows both free endpoints and x402 paid APIs.
 *
 * Wolverine's vault provides an encrypted Ethereum wallet (AES-256-GCM)
 * for each server instance. The wallet is used as the payment receiver
 * for x402 paid APIs on the Base network (USDC).
 *
 * Vault commands:
 *   wolverine --init-vault      Create encrypted wallet
 *   wolverine --x402-info       Show wallet address & config
 *
 * The vault is stored in .wolverine/vault/ and is:
 *   - Auto-backed up in every server snapshot
 *   - Protected from agent access (sandbox-blocked)
 *   - Private keys never exist as JS strings (Buffer only)
 *   - Rollback-protected (never overwritten by restore)
 *
 * Dashboard: localhost:3001 — view wallet balances, x402 revenue,
 * payment history, and all server health metrics in real time.
 */

async function routes(fastify) {
  // ── Free endpoints ──
  fastify.get("/", async () => ({ message: "Hello from Wolverine API" }));

  fastify.get("/users", async () => ({
    users: [
      { id: 1, name: "Alice", role: "admin" },
      { id: 2, name: "Bob", role: "user" },
    ],
  }));

  // ── x402 Paid API ──────────────────────────────────────────────
  // Any route becomes a paid API by adding x402 config.
  // Callers without a valid USDC payment get a 402 with payment instructions.
  // Callers with a valid Payment-Signature header get the response.
  //
  // Protocol: https://docs.cdp.coinbase.com/x402/welcome
  // Network:  Base (eip155:8453) — USDC payments
  // Wallet:   Auto-detected from vault (wolverine --init-vault)
  //
  // To change pricing live without restart:
  //   Update the price in config and the next request picks it up.
  //   Or use the dashboard command: "change /api/premium price to $0.05"

  // Fixed price — charge $0.01 per call:
  fastify.get("/premium", {
    config: { x402: { price: "$0.01", description: "Premium data endpoint" } },
  }, async (req) => ({
    data: "This response cost $0.01 in USDC on Base",
    paid: req.x402?.amount,
    from: req.x402?.from,
  }));

  // Variable price — caller chooses amount (e.g. buying credits):
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
    message: `Received ${req.x402?.amount} USDC payment`,
    from: req.x402?.from,
    receipt: req.x402?.receipt ? "valid" : "none",
  }));
}

module.exports = routes;
