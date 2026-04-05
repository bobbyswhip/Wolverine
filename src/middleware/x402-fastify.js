const path = require("path");
const fs = require("fs");

/**
 * x402 Payment Middleware for Fastify — monetize any API route with USDC on Base.
 *
 * Implements the x402 protocol (HTTP 402 Payment Required) for Fastify.
 * No official @x402/fastify exists, so we build directly on @x402/core.
 *
 * Usage in server/index.js:
 *   fastify.register(require('wolverine-ai/src/middleware/x402-fastify'), {
 *     payTo: '0xYourAddress',  // or auto from vault
 *     network: 'eip155:8453',  // Base mainnet
 *   });
 *
 * Route pricing in settings.json:
 *   "x402": {
 *     "enabled": true,
 *     "routes": {
 *       "POST /v1/chat/completions": { "price": "$0.001" },
 *       "GET /api/premium": { "price": "$0.01" }
 *     }
 *   }
 *
 * Live price updates:
 *   PUT /x402/price { route: "POST /v1/chat/completions", price: "$0.002" }
 *   wolverine --x402-price "POST /v1/chat/completions" "$0.002"
 */

// In-memory route pricing — survives hot updates without restart
let _routePricing = {};
let _payTo = null;
let _network = "eip155:8453"; // Base mainnet default
let _facilitatorUrl = "https://x402.org/facilitator";
let _initialized = false;

/**
 * Get current route pricing (for external access).
 */
function getPricing() { return { ..._routePricing }; }

/**
 * Update a single route's price live — no restart needed.
 */
function setPrice(routeKey, price) {
  if (!price.startsWith("$")) price = "$" + price;
  _routePricing[routeKey] = { price };
  // Persist to settings.json
  _persistPricing();
  return { route: routeKey, price };
}

/**
 * Remove pricing from a route (make it free).
 */
function removePrice(routeKey) {
  delete _routePricing[routeKey];
  _persistPricing();
  return { route: routeKey, price: "free" };
}

function _persistPricing() {
  try {
    const settingsPath = path.join(process.cwd(), "server", "config", "settings.json");
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (!settings.x402) settings.x402 = {};
      settings.x402.routes = {};
      for (const [route, cfg] of Object.entries(_routePricing)) {
        settings.x402.routes[route] = { price: cfg.price };
      }
      const tmp = settingsPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf-8");
      fs.renameSync(tmp, settingsPath);
    }
  } catch {}
}

/**
 * Fastify plugin — registers x402 payment middleware.
 */
async function x402Plugin(fastify, opts) {
  // Load config
  _payTo = opts.payTo || null;
  _network = opts.network || "eip155:8453";
  _facilitatorUrl = opts.facilitator || "https://x402.org/facilitator";

  // Auto-detect payTo from vault if not provided
  if (!_payTo) {
    try {
      const { getWalletAddress } = require("../vault/wallet-ops");
      _payTo = await getWalletAddress();
    } catch {}
  }

  // Load route pricing from settings.json
  try {
    const settingsPath = path.join(process.cwd(), "server", "config", "settings.json");
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.x402?.routes) {
        for (const [route, cfg] of Object.entries(settings.x402.routes)) {
          _routePricing[route] = { price: cfg.price };
        }
      }
      if (settings.x402?.network) _network = settings.x402.network;
      if (settings.x402?.facilitator) _facilitatorUrl = settings.x402.facilitator;
    }
  } catch {}

  if (!_payTo) {
    console.log("  ⚠️  x402: no payTo address (set in settings.json or init vault)");
    return;
  }

  _initialized = true;
  const routeCount = Object.keys(_routePricing).length;
  if (routeCount > 0) {
    console.log(`  💰 x402: ${routeCount} paid route(s), receiving at ${_payTo.slice(0, 6)}...${_payTo.slice(-4)}`);
  }

  // ── Main payment gate — onRequest hook ──
  fastify.addHook("onRequest", async (request, reply) => {
    if (!_initialized || Object.keys(_routePricing).length === 0) return;

    const routeKey = `${request.method} ${request.url.split("?")[0]}`;
    const routeConfig = _routePricing[routeKey];
    if (!routeConfig) return; // Free route

    const paymentSig = request.headers["payment-signature"];

    // No payment — return 402 with payment instructions
    if (!paymentSig) {
      const paymentRequired = {
        accepts: [{
          scheme: "exact",
          price: routeConfig.price,
          network: _network,
          payTo: _payTo,
        }],
        description: `Payment required for ${routeKey}`,
        mimeType: "application/json",
      };

      reply
        .code(402)
        .header("Payment-Required", JSON.stringify(paymentRequired))
        .header("X-402-Version", "1.0")
        .send({
          error: "Payment Required",
          price: routeConfig.price,
          network: _network,
          payTo: _payTo,
          protocol: "x402",
        });
      return;
    }

    // Payment present — verify via facilitator
    try {
      const verified = await _verifyPayment(paymentSig, routeConfig);
      if (verified.valid) {
        // Payment good — add receipt header and continue
        reply.header("Payment-Response", JSON.stringify(verified.receipt || {}));
        request.x402 = { paid: true, amount: routeConfig.price, txHash: verified.txHash };
        return; // continue to route handler
      }
    } catch {}

    // Verification failed
    reply.code(402).send({
      error: "Payment verification failed",
      price: routeConfig.price,
      network: _network,
      payTo: _payTo,
    });
  });

  // ── Live price management API ──
  fastify.put("/x402/price", async (request, reply) => {
    // Admin only
    const token = request.headers.authorization?.replace("Bearer ", "");
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(path.join(process.cwd(), "server", "config", "settings.json"), "utf-8")); } catch {}
    if (token !== settings.platform?.apiKey) {
      return reply.code(403).send({ error: "Admin only" });
    }

    const { route, price } = request.body || {};
    if (!route || !price) return reply.code(400).send({ error: "route and price required" });
    const result = setPrice(route, price);
    return { updated: true, ...result };
  });

  fastify.delete("/x402/price", async (request, reply) => {
    const token = request.headers.authorization?.replace("Bearer ", "");
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(path.join(process.cwd(), "server", "config", "settings.json"), "utf-8")); } catch {}
    if (token !== settings.platform?.apiKey) {
      return reply.code(403).send({ error: "Admin only" });
    }

    const { route } = request.body || {};
    if (!route) return reply.code(400).send({ error: "route required" });
    return removePrice(route);
  });

  fastify.get("/x402/pricing", async () => {
    return {
      payTo: _payTo,
      network: _network,
      routes: _routePricing,
    };
  });
}

/**
 * Verify a payment signature via the facilitator.
 */
async function _verifyPayment(paymentSig, routeConfig) {
  try {
    // Try @x402/core facilitator client if available
    const { HTTPFacilitatorClient } = require("@x402/core/server");
    const { ExactEvmScheme } = require("@x402/evm/exact/server");

    const facilitator = new HTTPFacilitatorClient({ url: _facilitatorUrl });
    const result = await facilitator.verify({
      paymentSignature: paymentSig,
      routeConfig: {
        accepts: [{
          scheme: "exact",
          price: routeConfig.price,
          network: _network,
          payTo: _payTo,
        }],
      },
    });
    return { valid: result.valid, receipt: result.receipt, txHash: result.txHash };
  } catch {
    // Fallback: manual HTTP verification to facilitator
    try {
      const https = require("https");
      const http = require("http");
      const url = new (require("url").URL)(_facilitatorUrl + "/verify");
      const body = JSON.stringify({
        paymentSignature: paymentSig,
        routeConfig: {
          accepts: [{
            scheme: "exact",
            price: routeConfig.price,
            network: _network,
            payTo: _payTo,
          }],
        },
      });

      return new Promise((resolve) => {
        const client = url.protocol === "https:" ? https : http;
        const req = client.request({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: 10000,
        }, (res) => {
          let data = "";
          res.on("data", (c) => data += c);
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              resolve({ valid: parsed.valid || parsed.success, receipt: parsed, txHash: parsed.txHash });
            } catch { resolve({ valid: false }); }
          });
        });
        req.on("error", () => resolve({ valid: false }));
        req.on("timeout", () => { req.destroy(); resolve({ valid: false }); });
        req.write(body);
        req.end();
      });
    } catch { return { valid: false }; }
  }
}

x402Plugin[Symbol.for("skip-override")] = true; // Fastify plugin compat

module.exports = x402Plugin;
module.exports.getPricing = getPricing;
module.exports.setPrice = setPrice;
module.exports.removePrice = removePrice;
