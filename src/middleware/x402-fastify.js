const fs = require("fs");
const path = require("path");

/**
 * x402 Fastify Plugin — add crypto payments to any route with one flag.
 *
 * Uses x402 v2 protocol (@x402/core + @x402/evm) with @coinbase/x402
 * facilitator for CDP authentication. Verify + settle both happen in
 * preHandler — the route handler only runs after USDC moves on-chain.
 *
 * Setup:
 *   1. wolverine --init-vault
 *   2. Set CDP_API_KEY_ID + CDP_API_KEY_SECRET in .env.local
 *   3. Add { config: { x402: { price: "$0.01" } } } to any route
 */

if (!globalThis.crypto) {
  globalThis.crypto = require("crypto").webcrypto;
}

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_EIP712 = { name: "USD Coin", version: "2" };

let _payTo = null;
let _network = "eip155:8453";
let _x402Server = null;

async function x402Plugin(fastify, opts) {
  _payTo = opts.payTo || null;

  // Load from settings.json
  try {
    const settingsPath = path.join(process.cwd(), "server", "config", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    if (settings.x402?.payTo) _payTo = settings.x402.payTo;
    if (settings.x402?.network) _network = settings.x402.network;
  } catch {}

  // Auto-detect payTo from vault
  if (!_payTo) {
    try {
      const { getWalletAddress } = require("../vault/wallet-ops");
      _payTo = await getWalletAddress();
    } catch {}
  }

  // Initialize v2 x402 SDK with @coinbase/x402 facilitator auth
  try {
    const { facilitator } = require("@coinbase/x402");
    const { x402ResourceServer, HTTPFacilitatorClient } = require("@x402/core/server");
    const { ExactEvmScheme } = require("@x402/evm/exact/server");

    const client = new HTTPFacilitatorClient(facilitator);
    _x402Server = new x402ResourceServer(client);
    _x402Server.register("eip155:*", new ExactEvmScheme());
    console.log(`  💰 x402: v2 SDK loaded (ExactEvmScheme + CDP facilitator)`);
  } catch (err) {
    console.log(`  ⚠️ x402: SDK init failed (${err.message})`);
  }

  if (_payTo) {
    console.log(`  💰 x402: payments to ${_payTo.slice(0, 6)}...${_payTo.slice(-4)} on ${_network}`);
  }

  // ── Route-level x402 hook ──
  fastify.addHook("preHandler", async (request, reply) => {
    const routeConfig = request.routeOptions?.config?.x402 || request.routeConfig?.x402 || request.context?.config?.x402;
    if (!routeConfig) return;
    if (!_payTo) { reply.code(500).send({ error: "x402 not configured — run wolverine --init-vault" }); return; }
    if (!_x402Server) { reply.code(500).send({ error: "x402 SDK not loaded — install @coinbase/x402 @x402/core @x402/evm" }); return; }

    // Determine dollar amount
    let dollarAmount;
    if (routeConfig.variable) {
      const field = routeConfig.priceField || "dollars";
      const raw = request.body?.[field] || request.query?.[field];
      if (!raw) {
        reply.code(400).send({ error: `${field} required`, x402: { variable: true, min: routeConfig.min || "$1", max: routeConfig.max || "$10000" } });
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
    const paymentHeader = request.headers["x-payment"] || request.headers["payment-signature"];

    // Build v2 payment requirements
    const { getAddress } = await import("viem");
    const proto = request.headers["x-forwarded-proto"] || "https";
    const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost";

    const paymentRequirements = {
      scheme: "exact",
      network: _network,
      amount: usdcAmount,
      asset: getAddress(USDC_ADDRESS),
      payTo: getAddress(_payTo),
      maxTimeoutSeconds: 60,
      extra: USDC_EIP712,
    };

    // No payment — return 402
    if (!paymentHeader) {
      reply.code(402).send({
        x402Version: 2,
        error: "Payment Required",
        accepts: [paymentRequirements],
        price,
        network: _network,
        payTo: _payTo,
        protocol: "x402",
        ...(routeConfig.variable ? { variable: true, min: routeConfig.min, max: routeConfig.max, priceField: routeConfig.priceField || "dollars" } : {}),
      });
      return;
    }

    // Decode payment
    let paymentPayload;
    try {
      const raw = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
      if (!raw.payload?.authorization || !raw.payload?.signature) throw new Error("Missing authorization or signature");

      paymentPayload = {
        x402Version: raw.x402Version || 2,
        scheme: raw.scheme || "exact",
        network: raw.network || _network,
        payload: raw.payload,
      };
      if (raw.accepted) paymentPayload.accepted = raw.accepted;
      if (raw.resource) paymentPayload.resource = raw.resource;
    } catch (err) {
      reply.code(402).send({ error: "Invalid payment: " + err.message, accepts: [paymentRequirements] });
      return;
    }

    // For variable pricing, match maxAmountRequired to user's payment
    const userValue = paymentPayload.payload.authorization.value;
    const actualRequirements = { ...paymentRequirements, amount: userValue };

    // Verify via facilitator
    try {
      console.log(`  💰 x402 verify: from=${paymentPayload.payload?.authorization?.from} value=${userValue} network=${paymentPayload.network}`);
      const verifyResult = await _x402Server.verifyPayment(paymentPayload, actualRequirements);
      if (!verifyResult.isValid) {
        console.log(`  ⚠️ x402 verify failed: ${verifyResult.invalidReason} ${verifyResult.invalidMessage || ""}`);
        reply.code(402).send({ error: verifyResult.invalidReason, message: verifyResult.invalidMessage, payer: verifyResult.payer });
        return;
      }
    } catch (err) {
      const detail = err.invalidReason || err.invalidMessage || err.cause?.message || "";
      console.log(`  ⚠️ x402 verify error: ${err.message} | ${detail}`);
      reply.code(402).send({ error: err.invalidReason || err.message, message: err.invalidMessage || detail });
      return;
    }

    // Settle via facilitator — USDC moves on-chain BEFORE handler runs
    const payer = paymentPayload.payload.authorization.from;
    try {
      const settleResult = await _x402Server.settlePayment(paymentPayload, actualRequirements);
      if (!settleResult.success) {
        console.log(`  ⚠️ x402 settle failed: ${settleResult.errorReason || "unknown"}`);
        reply.code(402).send({ error: "Settlement failed", reason: settleResult.errorReason });
        return;
      }
      const txHash = settleResult.transaction || null;
      console.log(`  💰 x402 settled: ${txHash || "confirmed"} (${price} from ${payer?.slice(0, 10)})`);

      request.x402 = { paid: true, amount: price, from: payer, value: userValue, verified: true, settled: true, txHash };
      _logPayment({ route: request.url, method: request.method, amount: price, from: payer, txHash, verified: true, settled: true, timestamp: Date.now() });
    } catch (err) {
      console.log(`  ⚠️ x402 settle error: ${err.message}`);
      reply.code(402).send({ error: "Settlement failed: " + err.message });
      return;
    }
  });

  // Public info endpoint
  fastify.get("/x402/info", async () => ({
    payTo: _payTo, network: _network, protocol: "x402", x402Version: 2,
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
