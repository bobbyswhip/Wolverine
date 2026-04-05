const fs = require("fs");
const path = require("path");

/**
 * x402 Fastify Plugin — add crypto payments to any route with one flag.
 *
 * Uses @coinbase/x402 facilitator + x402/verify for payment verification
 * and on-chain settlement. Matches the working pattern from blockaid-scanner.
 *
 * Two modes:
 *   Fixed price:    { x402: { price: "$0.01" } }
 *   Variable price: { x402: { variable: true, min: "$1", max: "$10000" } }
 */

// Node 18 needs globalThis.crypto
if (!globalThis.crypto) {
  globalThis.crypto = require("crypto").webcrypto;
}

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_EIP712 = { name: "USD Coin", version: "2" };

let _payTo = null;
let _network = "base"; // v1 format, not CAIP-2
let _facilitatorClient = null;

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

  // Initialize facilitator from @coinbase/x402 (ESM packages, need dynamic import)
  try {
    const { facilitator } = await import("@coinbase/x402");
    const { useFacilitator } = await import("x402/verify");
    _facilitatorClient = useFacilitator(facilitator);
    console.log(`  💰 x402: facilitator loaded (@coinbase/x402)`);
  } catch (err) {
    console.log(`  ⚠️ x402: facilitator init failed (${err.message}) — install @coinbase/x402 x402`);
  }

  if (_payTo) {
    console.log(`  💰 x402: payments to ${_payTo.slice(0, 6)}...${_payTo.slice(-4)} on ${_network}`);
  }

  // ── Route-level x402 hook ──
  fastify.addHook("preHandler", async (request, reply) => {
    const routeConfig = request.routeOptions?.config?.x402 || request.routeConfig?.x402 || request.context?.config?.x402;
    if (!routeConfig) return;
    if (!_payTo) {
      reply.code(500).send({ error: "x402 not configured — no wallet address" });
      return;
    }
    if (!_facilitatorClient) {
      reply.code(500).send({ error: "x402 facilitator not loaded — install @coinbase/x402 x402" });
      return;
    }

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

    const usdcAtomicAmount = String(Math.round(dollarAmount * 1e6));
    const price = "$" + dollarAmount.toFixed(2);

    // Check for payment header (X-PAYMENT for v1 compat, payment-signature for v2)
    const paymentHeader = request.headers["x-payment"] || request.headers["payment-signature"];

    // Build payment requirements (v1 format matching @coinbase/x402)
    const { getAddress } = await import("viem");
    // Build full resource URL (required by facilitator)
    const proto = request.headers["x-forwarded-proto"] || "https";
    const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost";
    const resourceUrl = `${proto}://${host}${request.url}`;

    const paymentRequirements = {
      scheme: "exact",
      network: _network,
      maxAmountRequired: usdcAtomicAmount,
      resource: resourceUrl,
      description: routeConfig.description || `Payment of $${dollarAmount.toFixed(2)} USDC`,
      mimeType: "application/json",
      payTo: getAddress(_payTo),
      maxTimeoutSeconds: 60,
      asset: getAddress(USDC_ADDRESS),
      extra: USDC_EIP712,
    };

    // No payment — return 402
    if (!paymentHeader) {
      reply.code(402).send({
        x402Version: 1,
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

    // Decode payment — parse raw payload directly (matching working project pattern)
    let decodedPayment;
    try {
      const raw = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));

      // Validate required fields
      if (!raw.payload?.authorization || !raw.payload?.signature) {
        throw new Error("Missing authorization or signature");
      }

      decodedPayment = {
        x402Version: raw.x402Version || 1,
        scheme: raw.scheme || "exact",
        network: raw.network || _network,
        payload: raw.payload,
      };
    } catch (err) {
      reply.code(402).send({ error: "Invalid payment format: " + err.message, accepts: [paymentRequirements] });
      return;
    }

    // For variable pricing, use user's actual payment value as maxAmountRequired
    const userValue = decodedPayment.payload.authorization.value;
    const actualRequirements = { ...paymentRequirements, maxAmountRequired: userValue };

    // Verify via facilitator
    try {
      console.log(`  💰 x402 verify: from=${decodedPayment.payload?.authorization?.from} value=${decodedPayment.payload?.authorization?.value} network=${decodedPayment.network}`);
      const verifyResult = await _facilitatorClient.verify(decodedPayment, actualRequirements);
      if (!verifyResult.isValid) {
        console.log(`  ⚠️ x402 verify failed: ${verifyResult.invalidReason} ${verifyResult.invalidMessage || ""}`);
        reply.code(402).send({ error: verifyResult.invalidReason || "Payment verification failed", message: verifyResult.invalidMessage, accepts: [paymentRequirements], payer: verifyResult.payer });
        return;
      }
    } catch (err) {
      console.log(`  ⚠️ x402 verify error: ${err.message}`);
      reply.code(402).send({ error: "Payment verification failed: " + err.message, accepts: [paymentRequirements] });
      return;
    }

    // Payment verified — attach info to request
    const payer = decodedPayment.payload.authorization.from;
    request.x402 = { paid: true, amount: price, from: payer, value: userValue, verified: true };

    // Log payment
    _logPayment({ route: request.url, method: request.method, amount: price, from: payer, verified: true, timestamp: Date.now() });
  });

  // Settlement hook — settle AFTER successful handler response
  fastify.addHook("onSend", async (request, reply, payload) => {
    if (!request.x402?.paid || !_facilitatorClient) return payload;
    if (reply.statusCode >= 400) return payload;

    try {
      const paymentHeader = request.headers["x-payment"] || request.headers["payment-signature"];
      const raw = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
      const decodedPayment = { x402Version: raw.x402Version || 1, scheme: raw.scheme || "exact", network: raw.network || _network, payload: raw.payload };

      const userValue = decodedPayment.payload.authorization.value;
      const { getAddress } = await import("viem");
      const proto = request.headers["x-forwarded-proto"] || "https";
      const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost";
      const requirements = {
        scheme: "exact", network: _network, maxAmountRequired: userValue,
        resource: `${proto}://${host}${request.url}`, description: "", mimeType: "application/json",
        payTo: getAddress(_payTo), maxTimeoutSeconds: 60, asset: getAddress(USDC_ADDRESS), extra: USDC_EIP712,
      };

      const settleResult = await _facilitatorClient.settle(decodedPayment, requirements);
      if (settleResult.success) {
        request.x402.txHash = settleResult.transaction;
        request.x402.settled = true;
        console.log(`  💰 x402 settled: ${settleResult.transaction || "confirmed"} (${request.x402.amount} from ${request.x402.from?.slice(0, 10)})`);
        // Update payment log
        _logPayment({ route: request.url, method: request.method, amount: request.x402.amount, from: request.x402.from, txHash: settleResult.transaction, verified: true, settled: true, timestamp: Date.now() });
      } else {
        console.log(`  ⚠️ x402 settle failed: ${settleResult.errorReason || "unknown"}`);
      }
    } catch (err) {
      console.log(`  ⚠️ x402 settle error: ${err.message}`);
    }
    return payload;
  });

  // Public info endpoint
  fastify.get("/x402/info", async () => ({
    payTo: _payTo, network: _network, protocol: "x402", x402Version: 1,
    facilitatorLoaded: !!_facilitatorClient,
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
