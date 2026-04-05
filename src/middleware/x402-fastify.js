const fs = require("fs");
const path = require("path");

/**
 * x402 Fastify Plugin — add crypto payments to any route with one flag.
 *
 * Makes it dead simple to accept USDC payments on Base network.
 * The developer marks a route with x402 config, and the middleware
 * handles the 402 → payment → verification → callback flow.
 *
 * Two modes:
 *   Fixed price:    { x402: { price: "$0.01" } }
 *   Variable price: { x402: { variable: true, min: "$1", max: "$10000" } }
 *
 * Example — fixed price route:
 *   fastify.get("/premium-data", { config: { x402: { price: "$0.10" } } }, handler)
 *
 * Example — variable price (credit purchase):
 *   fastify.post("/buy-credits", {
 *     config: {
 *       x402: {
 *         variable: true,
 *         min: "$1",
 *         max: "$10000",
 *         priceField: "dollars",  // reads amount from request body
 *       }
 *     }
 *   }, async (req, reply) => {
 *     // req.x402.paid === true, req.x402.amount === "$5.00"
 *     addCredits(req.x402.amount);
 *     return { credits: newBalance };
 *   })
 *
 * The payment receipt is in req.x402 after verification:
 *   { paid: true, amount: "$5.00", receipt: {...}, txHash: "0x..." }
 */

let _payTo = null;
let _network = "eip155:8453";
let _facilitatorUrl = "https://x402.org/facilitator";

async function x402Plugin(fastify, opts) {
  // Config
  _network = opts.network || _network;
  _facilitatorUrl = opts.facilitator || _facilitatorUrl;
  _payTo = opts.payTo || null;

  // Load from settings.json
  try {
    const settingsPath = path.join(process.cwd(), "server", "config", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    if (settings.x402?.network) _network = settings.x402.network;
    if (settings.x402?.facilitator) _facilitatorUrl = settings.x402.facilitator;
    if (settings.x402?.payTo) _payTo = settings.x402.payTo;
  } catch {}

  // Auto-detect payTo from vault
  if (!_payTo) {
    try {
      const { getWalletAddress } = require("../vault/wallet-ops");
      _payTo = await getWalletAddress();
    } catch {}
  }

  if (_payTo) {
    console.log(`  💰 x402: payments to ${_payTo.slice(0, 6)}...${_payTo.slice(-4)} on ${_network}`);
  }

  // ── Route-level x402 hook ──
  fastify.addHook("onRequest", async (request, reply) => {
    // Check if this route has x402 config
    const routeConfig = request.routeOptions?.config?.x402 || request.context?.config?.x402;
    if (!routeConfig) return; // Not an x402 route
    if (!_payTo) {
      reply.code(500).send({ error: "x402 not configured — no wallet address" });
      return;
    }

    // Determine the price
    let price;
    if (routeConfig.variable) {
      // Variable pricing — read amount from request body or query
      const field = routeConfig.priceField || "dollars";
      const raw = request.body?.[field] || request.query?.[field];
      if (!raw) {
        reply.code(400).send({
          error: `${field} required`,
          x402: { variable: true, min: routeConfig.min || "$1", max: routeConfig.max || "$10000" },
        });
        return;
      }
      const amount = parseFloat(String(raw).replace("$", ""));
      const min = parseFloat((routeConfig.min || "$1").replace("$", ""));
      const max = parseFloat((routeConfig.max || "$10000").replace("$", ""));
      if (isNaN(amount) || amount < min || amount > max) {
        reply.code(400).send({ error: `Amount must be $${min}-$${max}` });
        return;
      }
      price = "$" + amount.toFixed(2);
    } else {
      price = routeConfig.price;
      if (!price) { reply.code(500).send({ error: "x402 route missing price config" }); return; }
    }

    const paymentSig = request.headers["payment-signature"];

    // No payment — return 402 with payment instructions
    if (!paymentSig) {
      const instructions = {
        accepts: [{
          scheme: "exact",
          price,
          network: _network,
          payTo: _payTo,
        }],
        description: routeConfig.description || `Payment for ${request.method} ${request.url}`,
        mimeType: "application/json",
      };
      reply
        .code(402)
        .header("Payment-Required", JSON.stringify(instructions))
        .send({
          error: "Payment Required",
          price,
          network: _network,
          payTo: _payTo,
          protocol: "x402",
          ...(routeConfig.variable ? { variable: true, min: routeConfig.min, max: routeConfig.max, priceField: routeConfig.priceField || "dollars" } : {}),
        });
      return;
    }

    // Payment present — verify
    const verified = await _verifyPayment(paymentSig, price);
    if (verified.valid) {
      reply.header("Payment-Response", JSON.stringify(verified.receipt || {}));
      request.x402 = { paid: true, amount: price, receipt: verified.receipt, txHash: verified.txHash };
      return; // continue to route handler
    }

    reply.code(402).send({ error: "Payment verification failed", price, payTo: _payTo });
  });

  // ── Public pricing endpoint ──
  fastify.get("/x402/info", async () => ({
    payTo: _payTo,
    network: _network,
    facilitator: _facilitatorUrl,
    protocol: "x402",
    docs: "https://docs.cdp.coinbase.com/x402/welcome",
  }));
}

async function _verifyPayment(paymentSig, price) {
  try {
    // Try @x402/core if available
    const { HTTPFacilitatorClient } = require("@x402/core/server");
    const facilitator = new HTTPFacilitatorClient({ url: _facilitatorUrl });
    const result = await facilitator.verify({
      paymentSignature: paymentSig,
      routeConfig: { accepts: [{ scheme: "exact", price, network: _network, payTo: _payTo }] },
    });
    return { valid: result.valid, receipt: result.receipt, txHash: result.txHash };
  } catch {
    // Fallback: raw HTTP to facilitator
    try {
      const https = require("https");
      const http = require("http");
      const url = new (require("url").URL)(_facilitatorUrl + "/verify");
      const body = JSON.stringify({
        paymentSignature: paymentSig,
        routeConfig: { accepts: [{ scheme: "exact", price, network: _network, payTo: _payTo }] },
      });
      return new Promise((resolve) => {
        const client = url.protocol === "https:" ? https : http;
        const req = client.request({
          hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: 10000,
        }, (res) => {
          let data = "";
          res.on("data", (c) => data += c);
          res.on("end", () => {
            try { const p = JSON.parse(data); resolve({ valid: p.valid || p.success, receipt: p, txHash: p.txHash }); }
            catch { resolve({ valid: false }); }
          });
        });
        req.on("error", () => resolve({ valid: false }));
        req.write(body);
        req.end();
      });
    } catch { return { valid: false }; }
  }
}

x402Plugin[Symbol.for("skip-override")] = true;
module.exports = x402Plugin;
