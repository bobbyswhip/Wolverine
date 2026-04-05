const fs = require("fs");
const path = require("path");

/**
 * x402 Fastify Plugin — add crypto payments to any route with one flag.
 *
 * Makes it dead simple to accept USDC payments on Base network.
 * The developer marks a route with x402 config, and the middleware
 * handles the 402 → payment → verification → settlement flow.
 *
 * Settlement is handled by the x402 facilitator (Coinbase CDP),
 * which verifies the payment signature AND executes the on-chain
 * USDC transfer. Compatible with x402 Bazaar for API discovery.
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
// Production facilitator (Base mainnet) — handles verify + on-chain settlement
let _facilitatorUrl = "https://api.cdp.coinbase.com/platform/v2/x402";
// Testnet facilitator: "https://x402.org/facilitator"

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

  // Auto-select facilitator based on network
  if (!opts.facilitator) {
    const isTestnet = _network.includes("84532") || _network.includes("11155");
    _facilitatorUrl = isTestnet
      ? "https://x402.org/facilitator"
      : "https://api.cdp.coinbase.com/platform/v2/x402";
  }

  if (_payTo) {
    console.log(`  💰 x402: payments to ${_payTo.slice(0, 6)}...${_payTo.slice(-4)} on ${_network}`);
    console.log(`  💰 x402: facilitator ${_facilitatorUrl}`);
  }

  // ── Route-level x402 hook (preHandler so body is parsed for variable pricing) ──
  fastify.addHook("preHandler", async (request, reply) => {
    // Check if this route has x402 config (Fastify v4: context.config, v5: routeOptions.config)
    const routeConfig = request.routeOptions?.config?.x402 || request.routeConfig?.x402 || request.context?.config?.x402;
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

    // Payment present — send to facilitator for verification + on-chain settlement
    const routeAccepts = [{
      scheme: "exact",
      price,
      network: _network,
      payTo: _payTo,
    }];

    const verified = await _settleViaFacilitator(paymentSig, routeAccepts);
    if (verified.valid) {
      reply.header("Payment-Response", JSON.stringify(verified.receipt || {}));
      request.x402 = { paid: true, amount: price, receipt: verified.receipt, txHash: verified.txHash, from: verified.from };
      // Log payment for dashboard analytics
      _logPayment({ route: request.url, method: request.method, amount: price, from: verified.from, txHash: verified.txHash, verified: true, timestamp: Date.now() });
      return; // continue to route handler
    }

    // Facilitator rejected — try self-settlement as fallback
    if (verified.reason === "facilitator_unavailable") {
      const selfResult = await _selfSettle(paymentSig, price);
      if (selfResult.valid) {
        reply.header("Payment-Response", JSON.stringify(selfResult.receipt || {}));
        request.x402 = { paid: true, amount: price, receipt: selfResult.receipt, txHash: selfResult.txHash, from: selfResult.from };
        _logPayment({ route: request.url, method: request.method, amount: price, from: selfResult.from, txHash: selfResult.txHash, verified: true, settled: "self", timestamp: Date.now() });
        return;
      }
      reply.code(402).send({ error: "Payment settlement failed", reason: selfResult.reason, price, payTo: _payTo });
      return;
    }

    reply.code(402).send({ error: "Payment verification failed", reason: verified.reason, price, payTo: _payTo });
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

/**
 * Send payment to the x402 facilitator for verification AND on-chain settlement.
 * The facilitator:
 *  1. Verifies the EIP-3009 signature
 *  2. Calls transferWithAuthorization() on the USDC contract
 *  3. Returns the transaction hash
 *
 * This is the standard x402 flow — compatible with Bazaar discovery.
 */
async function _settleViaFacilitator(paymentSig, routeAccepts) {
  try {
    const https = require("https");
    const http = require("http");
    const url = new (require("url").URL)(_facilitatorUrl + "/verify");
    const body = JSON.stringify({
      paymentSignature: paymentSig,
      routeConfig: { accepts: routeAccepts },
    });
    return new Promise((resolve) => {
      const client = url.protocol === "https:" ? https : http;
      const req = client.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 30000, // settlement can take time (on-chain tx)
      }, (res) => {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => {
          try {
            const p = JSON.parse(data);
            if (p.valid || p.success) {
              resolve({
                valid: true,
                receipt: p,
                txHash: p.txHash || p.transactionHash || null,
                from: p.from || p.payer || null,
              });
            } else {
              resolve({ valid: false, reason: p.error || p.reason || "facilitator_rejected" });
            }
          } catch {
            resolve({ valid: false, reason: "facilitator_invalid_response" });
          }
        });
      });
      req.on("error", () => resolve({ valid: false, reason: "facilitator_unavailable" }));
      req.on("timeout", () => { req.destroy(); resolve({ valid: false, reason: "facilitator_timeout" }); });
      req.write(body);
      req.end();
    });
  } catch {
    return { valid: false, reason: "facilitator_unavailable" };
  }
}

/**
 * Self-settlement fallback — verify the signature AND execute the
 * on-chain transferWithAuthorization() using the server's vault wallet.
 *
 * Only used when the facilitator is unavailable. Requires ethers + RPC.
 * The server pays gas to execute the transfer.
 */
async function _selfSettle(paymentSig, price) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(paymentSig, "base64").toString());
  } catch {
    return { valid: false, reason: "invalid_payment_format" };
  }

  if (!payload.payload?.authorization || !payload.payload?.signature) {
    return { valid: false, reason: "missing_authorization" };
  }

  const auth = payload.payload.authorization;
  const sig = payload.payload.signature;

  // Verify amount
  const expectedUsdc = Math.round(parseFloat(price.replace("$", "")) * 1e6);
  const actualUsdc = parseInt(auth.value, 16) || parseInt(auth.value, 10) || 0;
  if (actualUsdc < expectedUsdc * 0.99) {
    return { valid: false, reason: "amount_mismatch" };
  }

  // Verify payTo matches
  if (auth.to?.toLowerCase() !== _payTo?.toLowerCase()) {
    return { valid: false, reason: "wrong_recipient" };
  }

  // Verify not expired
  if (auth.validBefore && auth.validBefore < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: "payment_expired" };
  }

  try {
    const { ethers } = require("ethers");
    const fromAddr = ethers.getAddress(auth.from.toLowerCase());
    const toAddr = ethers.getAddress(auth.to.toLowerCase());

    // Step 1: Verify the signature
    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    };
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    };
    const message = {
      from: fromAddr,
      to: toAddr,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    };

    const recoveredAddress = ethers.verifyTypedData(domain, types, message, sig);
    if (recoveredAddress.toLowerCase() !== fromAddr.toLowerCase()) {
      return { valid: false, reason: "signature_mismatch" };
    }

    // Step 2: Execute transferWithAuthorization on-chain
    // Use the vault wallet to submit the transaction (server pays gas)
    const { decryptPrivateKey } = require("../vault/vault-manager");
    let keyBuf = null;
    try {
      keyBuf = decryptPrivateKey();
      const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
      const wallet = new ethers.Wallet(keyBuf, provider);

      const usdcContract = new ethers.Contract(
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        [
          "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
        ],
        wallet
      );

      // Parse the signature into v, r, s
      const sigBytes = ethers.getBytes(sig);
      const r = ethers.hexlify(sigBytes.slice(0, 32));
      const s = ethers.hexlify(sigBytes.slice(32, 64));
      const v = sigBytes[64];

      const tx = await usdcContract.transferWithAuthorization(
        fromAddr, toAddr, auth.value,
        auth.validAfter, auth.validBefore, auth.nonce,
        v, r, s,
        { gasLimit: 100000 }
      );

      // Wait for confirmation (1 block)
      const receipt = await tx.wait(1);
      console.log(`  💰 x402 self-settled: ${receipt.hash} (${price} USDC)`);

      return {
        valid: true,
        from: fromAddr,
        receipt: { authorization: auth, settled: "self", blockNumber: receipt.blockNumber },
        txHash: receipt.hash,
      };
    } finally {
      if (keyBuf) keyBuf.fill(0);
    }
  } catch (err) {
    console.log(`  ⚠️ x402 self-settlement failed: ${err.message}`);
    return { valid: false, reason: "settlement_failed: " + err.message };
  }
}

function _logPayment(entry) {
  try {
    const logPath = path.join(process.cwd(), ".wolverine", "x402-payments.json");
    let payments = [];
    try { payments = JSON.parse(fs.readFileSync(logPath, "utf-8")); } catch {}
    payments.push(entry);
    // Keep last 1000 payments
    if (payments.length > 1000) payments = payments.slice(-1000);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(payments, null, 2));
  } catch {}
}

x402Plugin[Symbol.for("skip-override")] = true;
module.exports = x402Plugin;
