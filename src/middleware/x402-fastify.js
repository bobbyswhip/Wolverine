const fs = require("fs");
const path = require("path");

/**
 * x402 Fastify Plugin — add crypto payments to any route with one flag.
 *
 * Uses the official @x402/core SDK for payment verification and settlement
 * via the CDP facilitator. Compatible with x402 Bazaar for API discovery.
 *
 * Two modes:
 *   Fixed price:    { x402: { price: "$0.01" } }
 *   Variable price: { x402: { variable: true, min: "$1", max: "$10000" } }
 */

// Node 18 needs globalThis.crypto for @x402/evm
if (!globalThis.crypto) {
  globalThis.crypto = require("crypto").webcrypto;
}

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

let _payTo = null;
let _network = "eip155:8453";
let _facilitatorUrl = "https://api.cdp.coinbase.com/platform/v2/x402";
let _x402Server = null; // x402ResourceServer instance

async function x402Plugin(fastify, opts) {
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
    console.log(`  💰 x402: facilitator ${_facilitatorUrl}`);
  }

  // Initialize x402 SDK server with CDP facilitator
  try {
    const { x402ResourceServer, HTTPFacilitatorClient } = require("@x402/core/server");
    const { ExactEvmScheme } = require("@x402/evm/exact/server");

    const facilitatorConfig = { url: _facilitatorUrl };

    // Add CDP auth if keys are available
    if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
      facilitatorConfig.createAuthHeaders = async () => {
        const { getAuthHeaders } = await import("@coinbase/cdp-sdk/auth");
        const endpoints = ["verify", "settle", "supported"];
        const result = {};
        for (const ep of endpoints) {
          const headers = await getAuthHeaders({
            apiKeyId: process.env.CDP_API_KEY_ID,
            apiKeySecret: process.env.CDP_API_KEY_SECRET,
            requestMethod: "POST",
            requestHost: `https://${new URL(_facilitatorUrl).host}`,
            requestPath: `${new URL(_facilitatorUrl).pathname}/${ep}`,
          });
          result[ep] = headers;
        }
        return result;
      };
    }

    const client = new HTTPFacilitatorClient(facilitatorConfig);
    _x402Server = new x402ResourceServer(client);
    _x402Server.register("eip155:*", new ExactEvmScheme());
    console.log(`  💰 x402: SDK initialized (ExactEvmScheme)`);
  } catch (err) {
    console.log(`  ⚠️ x402: SDK init failed (${err.message}) — using direct verification`);
  }

  // ── Route-level x402 hook ──
  fastify.addHook("preHandler", async (request, reply) => {
    const routeConfig = request.routeOptions?.config?.x402 || request.routeConfig?.x402 || request.context?.config?.x402;
    if (!routeConfig) return;
    if (!_payTo) {
      reply.code(500).send({ error: "x402 not configured — no wallet address" });
      return;
    }

    // Determine the price
    let dollarAmount;
    if (routeConfig.variable) {
      const field = routeConfig.priceField || "dollars";
      const raw = request.body?.[field] || request.query?.[field];
      if (!raw) {
        reply.code(400).send({
          error: `${field} required`,
          x402: { variable: true, min: routeConfig.min || "$1", max: routeConfig.max || "$10000" },
        });
        return;
      }
      dollarAmount = parseFloat(String(raw).replace("$", ""));
      const min = parseFloat((routeConfig.min || "$1").replace("$", ""));
      const max = parseFloat((routeConfig.max || "$10000").replace("$", ""));
      if (isNaN(dollarAmount) || dollarAmount < min || dollarAmount > max) {
        reply.code(400).send({ error: `Amount must be $${min}-$${max}` });
        return;
      }
    } else {
      dollarAmount = parseFloat((routeConfig.price || "0").replace("$", ""));
      if (!dollarAmount) { reply.code(500).send({ error: "x402 route missing price config" }); return; }
    }

    const usdcAmount = String(Math.round(dollarAmount * 1e6));
    const price = "$" + dollarAmount.toFixed(2);
    const paymentHeader = request.headers["payment-signature"] || request.headers["x-payment"];

    // No payment — return 402 with payment requirements
    if (!paymentHeader) {
      const paymentRequirements = {
        scheme: "exact",
        network: _network,
        amount: usdcAmount,
        asset: USDC_BASE,
        payTo: _payTo,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      };
      const paymentRequired = {
        x402Version: 2,
        error: "Payment Required",
        resource: {
          url: `${request.method} ${request.url}`,
          description: routeConfig.description || `Payment for ${request.method} ${request.url}`,
          mimeType: "application/json",
        },
        accepts: [paymentRequirements],
      };

      const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
      reply
        .code(402)
        .header("Payment-Required", encoded)
        .send({
          error: "Payment Required",
          price,
          network: _network,
          payTo: _payTo,
          protocol: "x402",
          x402Version: 2,
          ...(routeConfig.variable ? { variable: true, min: routeConfig.min, max: routeConfig.max, priceField: routeConfig.priceField || "dollars" } : {}),
        });
      return;
    }

    // Payment present — decode
    let paymentPayload;
    try {
      paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString());
    } catch {
      reply.code(400).send({ error: "Invalid payment encoding" });
      return;
    }

    if (!paymentPayload.x402Version) paymentPayload.x402Version = 2;

    const paymentRequirements = {
      scheme: "exact",
      network: _network,
      amount: usdcAmount,
      asset: USDC_BASE,
      payTo: _payTo,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    };

    if (!paymentPayload.accepted) paymentPayload.accepted = paymentRequirements;

    // Use x402 SDK if available
    if (_x402Server) {
      try {
        // Verify via facilitator
        const verifyResult = await _x402Server.verifyPayment(paymentPayload, paymentRequirements);
        if (!verifyResult.isValid) {
          reply.code(402).send({ error: "Payment verification failed", reason: verifyResult.invalidReason, price, payTo: _payTo });
          return;
        }

        // Settle via facilitator (executes on-chain transfer)
        const settleResult = await _x402Server.settlePayment(paymentPayload, paymentRequirements);
        if (!settleResult.success) {
          reply.code(402).send({ error: "Payment settlement failed", reason: settleResult.errorReason, price, payTo: _payTo });
          return;
        }

        const txHash = settleResult.transaction || null;
        const payer = settleResult.payer || verifyResult.payer || paymentPayload.payload?.authorization?.from || null;

        request.x402 = { paid: true, amount: price, receipt: settleResult, txHash, from: payer };
        _logPayment({ route: request.url, method: request.method, amount: price, from: payer, txHash, verified: true, settled: "facilitator", timestamp: Date.now() });
        return;
      } catch (err) {
        console.log(`  ⚠️ x402 SDK error: ${err.message}`);
        reply.code(402).send({ error: "Payment processing failed", reason: err.message, price, payTo: _payTo });
        return;
      }
    }

    // Fallback: direct verification (no on-chain settlement)
    reply.code(500).send({ error: "x402 SDK not available — install @x402/core @x402/evm" });
  });

  // ── Public pricing endpoint ──
  fastify.get("/x402/info", async () => ({
    payTo: _payTo,
    network: _network,
    facilitator: _facilitatorUrl,
    protocol: "x402",
    x402Version: 2,
    sdkLoaded: !!_x402Server,
    docs: "https://docs.cdp.coinbase.com/x402/welcome",
  }));
}

function _logPayment(entry) {
  try {
    const logPath = path.join(process.cwd(), ".wolverine", "x402-payments.json");
    let payments = [];
    try { payments = JSON.parse(fs.readFileSync(logPath, "utf-8")); } catch {}
    payments.push(entry);
    if (payments.length > 1000) payments = payments.slice(-1000);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(payments, null, 2));
  } catch {}
}

x402Plugin[Symbol.for("skip-override")] = true;
module.exports = x402Plugin;
