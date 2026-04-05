const fs = require("fs");
const path = require("path");

/**
 * x402 Fastify Plugin — add crypto payments to any route with one flag.
 *
 * Implements the x402 v2 protocol with CDP facilitator for on-chain settlement.
 * Compatible with @x402/fetch, @x402/evm client SDKs and x402 Bazaar.
 *
 * Two modes:
 *   Fixed price:    { x402: { price: "$0.01" } }
 *   Variable price: { x402: { variable: true, min: "$1", max: "$10000" } }
 */

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

let _payTo = null;
let _network = "eip155:8453";
let _facilitatorUrl = "https://x402.org/facilitator";

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

  // Auto-select facilitator based on network
  if (!opts.facilitator) {
    const isTestnet = _network.includes("84532") || _network.includes("11155");
    _facilitatorUrl = isTestnet
      ? "https://x402.org/facilitator"
      : "https://x402.org/facilitator"; // CDP production requires auth — use x402.org for both
  }

  if (_payTo) {
    console.log(`  💰 x402: payments to ${_payTo.slice(0, 6)}...${_payTo.slice(-4)} on ${_network}`);
    console.log(`  💰 x402: facilitator ${_facilitatorUrl}`);
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

    // USDC amount in atomic units (6 decimals)
    const usdcAmount = String(Math.round(dollarAmount * 1e6));
    const price = "$" + dollarAmount.toFixed(2);

    const paymentHeader = request.headers["payment-signature"] || request.headers["x-payment"];

    // No payment — return 402 with x402 v2 payment requirements
    if (!paymentHeader) {
      const paymentRequirements = {
        scheme: "exact",
        network: _network,
        amount: usdcAmount,
        asset: USDC_BASE,
        payTo: _payTo,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" }, // EIP-712 domain params for USDC
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

    // Payment present — decode, verify via facilitator, then settle
    const paymentRequirements = {
      scheme: "exact",
      network: _network,
      amount: usdcAmount,
      asset: USDC_BASE,
      payTo: _payTo,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    };

    // Decode the payment payload
    let paymentPayload;
    try {
      const decoded = Buffer.from(paymentHeader, "base64").toString();
      paymentPayload = JSON.parse(decoded);
    } catch {
      reply.code(400).send({ error: "Invalid payment encoding" });
      return;
    }

    // Ensure x402Version is set
    if (!paymentPayload.x402Version) {
      paymentPayload.x402Version = 2;
    }

    // Ensure the accepted requirements are included (x402 v2 spec)
    if (!paymentPayload.accepted) {
      paymentPayload.accepted = paymentRequirements;
    }

    // Step 1: Verify via facilitator
    const verifyResult = await _facilitatorCall("/verify", paymentPayload, paymentRequirements);
    if (!verifyResult.ok) {
      reply.code(402).send({
        error: "Payment verification failed",
        reason: verifyResult.reason,
        price,
        payTo: _payTo,
      });
      return;
    }

    // Step 2: Settle via facilitator (executes on-chain transfer)
    const settleResult = await _facilitatorCall("/settle", paymentPayload, paymentRequirements);
    if (!settleResult.ok) {
      reply.code(402).send({
        error: "Payment settlement failed",
        reason: settleResult.reason,
        price,
        payTo: _payTo,
      });
      return;
    }

    // Payment verified AND settled on-chain
    const txHash = settleResult.data?.transaction || settleResult.data?.txHash || null;
    const payer = settleResult.data?.payer || verifyResult.data?.payer || paymentPayload.payload?.authorization?.from || null;

    reply.header("Payment-Response", JSON.stringify(settleResult.data || {}));
    request.x402 = { paid: true, amount: price, receipt: settleResult.data, txHash, from: payer };
    _logPayment({ route: request.url, method: request.method, amount: price, from: payer, txHash, verified: true, settled: "facilitator", timestamp: Date.now() });
  });

  // ── Public pricing endpoint ──
  fastify.get("/x402/info", async () => ({
    payTo: _payTo,
    network: _network,
    facilitator: _facilitatorUrl,
    protocol: "x402",
    x402Version: 2,
    docs: "https://docs.cdp.coinbase.com/x402/welcome",
  }));
}

/**
 * Call the x402 facilitator — matches the exact format from @x402/core HTTPFacilitatorClient.
 *
 * POST {facilitatorUrl}/verify or /settle
 * Body: { x402Version, paymentPayload, paymentRequirements }
 */
async function _facilitatorCall(endpoint, paymentPayload, paymentRequirements) {
  try {
    const https = require("https");
    const http = require("http");
    const url = new (require("url").URL)(_facilitatorUrl + endpoint);
    const body = JSON.stringify({
      x402Version: paymentPayload.x402Version || 2,
      paymentPayload,
      paymentRequirements,
    });

    return new Promise((resolve) => {
      const client = url.protocol === "https:" ? https : http;
      const req = client.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 30000,
      }, (res) => {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              // Verify: check isValid. Settle: check success.
              if (endpoint === "/verify" && parsed.isValid === false) {
                resolve({ ok: false, reason: parsed.invalidReason || "verification_rejected", data: parsed });
              } else if (endpoint === "/settle" && parsed.success === false) {
                resolve({ ok: false, reason: parsed.errorReason || "settlement_rejected", data: parsed });
              } else {
                resolve({ ok: true, data: parsed });
              }
            } else {
              // Error response
              const reason = parsed.invalidReason || parsed.errorReason || parsed.error || `facilitator_${res.statusCode}`;
              console.log(`  ⚠️ x402 facilitator ${endpoint} ${res.statusCode}: ${reason}`);
              resolve({ ok: false, reason, data: parsed });
            }
          } catch {
            resolve({ ok: false, reason: `facilitator_parse_error_${res.statusCode}` });
          }
        });
      });
      req.on("error", (err) => {
        console.log(`  ⚠️ x402 facilitator ${endpoint} error: ${err.message}`);
        resolve({ ok: false, reason: "facilitator_unavailable: " + err.message });
      });
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, reason: "facilitator_timeout" }); });
      req.write(body);
      req.end();
    });
  } catch (err) {
    return { ok: false, reason: "facilitator_error: " + err.message };
  }
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
