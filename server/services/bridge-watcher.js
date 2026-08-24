// Bridge watcher service. Tracks Base→Solana bridges and fires the claim
// sequence (prove + create-ATA + relay) on the user's behalf when the Solana
// side has finalized the Base block containing the user's tx.
//
// Two intake paths:
//   1. Frontend POSTs /bridge/register-pending after submitting a Base tx.
//   2. Auto-discovery scanner (this file's discoverTick) polls Base for
//      supported-token Transfer(..., to=bridge_contract) events and
//      self-registers any unseen bridges. This is the safety net for cases
//      where the frontend errors after the tx confirms (closed tab, network
//      blip, etc.) — the watcher catches them anyway.
//
// Scope: wASS discovery only matches bridges that went through one of OUR tip
// routers. POKE uses the official Bridge directly and pays its on-chain relay
// gas fee, so its discovery instead validates the exact Base token, Solana
// mint, destination token account, and successful outgoing bridge event.
//
// Safety knobs (env-overridable):
//   AUTO_CLAIM_ENABLED        default "1"
//   AUTO_DISCOVER_ENABLED     default "1"
//   AUTO_CLAIM_MAX_AGE_S      default 86400 (24h)
//   AUTO_CLAIM_MAX_AMOUNT_WEI default 1e22 (10000 wASS)

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs/promises");
const path = require("path");
const { createPublicClient, fallback, http, parseAbiItem } = require("viem");
const { base } = require("viem/chains");
const execFileAsync = promisify(execFile);

const BUN = `${process.env.HOME}/.bun/bin/bun`;
const BRIDGE_SCRIPTS = `${process.env.HOME}/base-bridge/scripts`;
const PAYER_KP = `.bridge-keys/wass-bridger.json`;
const WASS_MINT = "AUtGNieMScUQREZWS3GZ82PES8ScDvjDxnbWCUqe5CaE";

const STATE_FILE = path.join(process.env.HOME, "wolverine/data/bridges.json");
const POLL_INTERVAL_MS = 30_000;
const DISCOVER_INTERVAL_MS = 45_000;

const SOL_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const SOL_BRIDGE_ACCOUNT = "DMtzswCcRcsMmJasgHTNZcBHZvdBkrBe248CBdEXxpJm";

// On-chain auto-discovery params.
const WASS_BASE = "0x445040FfaAb67992Ba1020ec2558CD6754d83Ad6";
const POKE_BASE = "0xb2000000000000000000007d9640993d01f94199";
const POKE_REMOTE_TOKEN = "0xc2b406cac99d2df492757ea1c30cbe370a6cf487e7c50b06cdd793e96f05f249";
const BRIDGE_CONTRACT = "0x3eff766C76a1be2Ce1aCF2B69c78bCae257D5188";
const TIP_ROUTERS = [
  "0x3cBf24df9baF80089289efE8E4215335A7267112", // V2.01 (current — has firstTime fee)
  "0x8F4021B31eF0571c4192c9A820AeD6aCE740baDF", // V2
  "0xFf39C525c7398f8148bBB80B2E6E520D7eBfE48E", // V1
];
// keccak256("TipAndBridgeFirstTimeCalled(address,uint256,uint256)") — emitted
// only by V2.01's firstTime path. Used by discoverer to refuse bridges into
// fresh ATAs that didn't pre-fund their rent.
const TIP_FIRST_TIME_TOPIC =
  "0xf26f29d6cca127803e3e05aec111e430d5fb5397447fbec2f8eeb8c3f7f763fb";
const ERC20_TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
// Bridge contract event whose data has [localToken|remoteToken|to|amount].
const BRIDGE_OUTGOING_TOPIC =
  "0xf1109ae3af61805fa998753209b2a90166bfc4b38ad8a6b5a268591ce18f99c0";
const BASE_RPC = process.env.BASE_RPC_URL || "https://base.publicnode.com";
const baseClient = createPublicClient({
  chain: base,
  transport: fallback([
    http(BASE_RPC),
    http("https://mainnet.base.org"),
  ]),
});

const AUTO_DISCOVER_ENABLED = (process.env.AUTO_DISCOVER_ENABLED ?? "1") !== "0";
// How many blocks back to scan on first boot (no checkpoint). 1800 ≈ 1h on Base.
const DISCOVER_BACKFILL_BLOCKS = 1_800n;

const AUTO_CLAIM_ENABLED = (process.env.AUTO_CLAIM_ENABLED ?? "1") !== "0";
const AUTO_CLAIM_MAX_AGE_S = Number(process.env.AUTO_CLAIM_MAX_AGE_S ?? 86_400);
const AUTO_CLAIM_MAX_AMOUNT_WEI = BigInt(process.env.AUTO_CLAIM_MAX_AMOUNT_WEI ?? "10000000000000000000000"); // 1e22 = 10000 wASS

class BridgeWatcher {
  constructor() {
    this.state = { bridges: {} };
    this.solBaseBlockNumber = 0n;
    this.timer = null;
    this.discoverTimer = null;
    this.tickInFlight = false;
    this.discoverInFlight = false;
    this.lastScannedBlock = 0n;
  }

  async load() {
    try {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      const raw = await fs.readFile(STATE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      this.state = { bridges: parsed.bridges || {} };
      this.lastScannedBlock = BigInt(parsed.lastScannedBlock || 0);
    } catch (e) {
      if (e.code !== "ENOENT") console.warn("[bridge-watcher] load error:", e.message);
      this.state = { bridges: {} };
      this.lastScannedBlock = 0n;
    }
  }

  async save() {
    try {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      const payload = {
        bridges: this.state.bridges,
        lastScannedBlock: this.lastScannedBlock.toString(),
      };
      await fs.writeFile(STATE_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
      console.warn("[bridge-watcher] save error:", e.message);
    }
  }

  /** Register a bridge that the user submitted through our UI. */
  async register(rec) {
    // rec = { txHash, sender (evm), asset, recipientPubkey, destinationAta, baseBlockNumber, amountWei }
    if (!rec.txHash || !rec.sender) throw new Error("txHash and sender required");
    if (this.state.bridges[rec.txHash]) {
      // Don't overwrite existing — but allow updating fields if the registrant has more info
      const cur = this.state.bridges[rec.txHash];
      const updated = {
        ...cur,
        ...rec,
        registeredAt: cur.registeredAt,
        // A fresh, on-chain-verified registration is also the explicit retry
        // mechanism for a prior transient claim failure.
        status: cur.status === "failed" ? "registered" : cur.status,
      };
      if (cur.status === "failed") {
        delete updated.error;
        delete updated.retryAt;
      }
      this.state.bridges[rec.txHash] = updated;
    } else {
      this.state.bridges[rec.txHash] = {
        ...rec,
        registeredAt: Math.floor(Date.now() / 1000),
        status: "registered",
      };
    }
    await this.save();
    return this.state.bridges[rec.txHash];
  }

  /** Returns bridges where sender or recipientPubkey matches. */
  listForUser(addressOrPubkey) {
    const k = String(addressOrPubkey || "").toLowerCase();
    if (!k) return [];
    return Object.values(this.state.bridges).filter((b) => {
      return (b.sender || "").toLowerCase() === k
          || (b.recipientPubkey || "") === addressOrPubkey;
    }).sort((a, b) => (b.registeredAt || 0) - (a.registeredAt || 0));
  }

  /** Read Solana bridge state to get the latest finalized Base block. */
  async fetchSolBaseBlock() {
    const r = await fetch(SOL_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getAccountInfo",
        params: [SOL_BRIDGE_ACCOUNT, { encoding: "base64" }],
      }),
    }).then((x) => x.json());
    const b64 = r?.result?.value?.data?.[0];
    if (!b64) throw new Error("Solana bridge account empty");
    const buf = Buffer.from(b64, "base64");
    return buf.readBigUInt64LE(8);
  }

  /** Run the prove + create-ata + relay sequence for a single bridge. */
  async claim(bridge) {
    const args0 = ["run", "src/bin.ts", "sol", "bridge"];
    const env = { cwd: BRIDGE_SCRIPTS, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 };

    // 1. prove (skip-relay so we get message hash)
    const proveOut = await execFileAsync(BUN, [...args0, "prove-message",
      "--deploy-env", "mainnet",
      "--transaction-hash", bridge.txHash,
      "--payer-kp", PAYER_KP, "--skip-relay",
    ], env).then((r) => r.stdout);
    const proveSig = (proveOut.match(/Signature:\s*([A-Za-z0-9]+)/) || [])[1] || null;
    const messageHash = (proveOut.match(/Message Hash:\s*(0x[a-fA-F0-9]{64})/) || [])[1];
    if (!messageHash) throw new Error("could not extract message hash");

    // 2. create-ATA for router-backed wASS (idempotent). POKE registrations
    // are accepted only when the destination Token-2022 account already
    // exists, matching the frontend's pre-send safety gate.
    let ataSig = null;
    if (bridge.asset === "wASS") {
      try {
        const ataOut = await execFileAsync(BUN, ["run", "src/bin.ts", "sol", "spl", "create-ata",
          "--deploy-env", "mainnet",
          "--mint", WASS_MINT,
          "--owner", bridge.recipientPubkey,
          "--payer-kp", PAYER_KP,
        ], env).then((r) => r.stdout);
        ataSig = (ataOut.match(/Signature:\s*([A-Za-z0-9]+)/) || [])[1] || null;
      } catch (e) {
        const msg = String(e.stderr || e.message || "");
        if (!msg.includes("already in use")) {
          // Non-fatal; continue to relay anyway
          console.warn("[bridge-watcher] create-ata warn:", msg.slice(0, 200));
        }
      }
    }

    // 3. relay
    const relayOut = await execFileAsync(BUN, [...args0, "relay-message",
      "--deploy-env", "mainnet",
      "--message-hash", messageHash,
      "--payer-kp", PAYER_KP,
    ], env).then((r) => r.stdout);
    const relaySig = (relayOut.match(/Signature:\s*([A-Za-z0-9]+)/) || [])[1] || null;

    return { messageHash, proveSig, ataSig, relaySig };
  }

  isClaimable(b) {
    if (b.status !== "registered" && b.status !== "ready") return false;
    if (BigInt(b.baseBlockNumber || 0) > this.solBaseBlockNumber) return false;
    // Safety: skip very old registrations and very large amounts
    const age = Math.floor(Date.now() / 1000) - (b.registeredAt || 0);
    if (age > AUTO_CLAIM_MAX_AGE_S) return false;
    if (BigInt(b.amountWei || 0) > AUTO_CLAIM_MAX_AMOUNT_WEI) return false;
    if (b.asset !== "wASS" && b.asset !== "SOL" && b.asset !== "POKE") return false;
    if (Number(b.retryAt || 0) > Math.floor(Date.now() / 1000)) return false;
    return true;
  }

  async tick() {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      // 1. refresh Solana finalization pointer
      try {
        this.solBaseBlockNumber = await this.fetchSolBaseBlock();
      } catch (e) {
        console.warn("[bridge-watcher] sol-state fetch failed:", e.message);
      }

      // 2. mark registered → ready when finalized
      let mutated = false;
      for (const b of Object.values(this.state.bridges)) {
        if (b.status === "registered" && BigInt(b.baseBlockNumber || 0) <= this.solBaseBlockNumber) {
          b.status = "ready";
          mutated = true;
        }
      }
      if (mutated) await this.save();

      // 3. auto-claim ready bridges
      if (AUTO_CLAIM_ENABLED) {
        for (const b of Object.values(this.state.bridges)) {
          if (!this.isClaimable(b)) continue;
          b.status = "claiming";
          await this.save();
          try {
            const result = await this.claim(b);
            Object.assign(b, result, {
              status: "completed",
              completedAt: Math.floor(Date.now() / 1000),
            });
            delete b.error;
            delete b.retryAt;
            console.info(`[bridge-watcher] claimed ${b.txHash.slice(0,12)} → ${result.relaySig?.slice(0,12)}`);
          } catch (e) {
            const err = String(e.stderr || e.message || e);
            // Solana program error 0x0 / 4615026 = "message already executed".
            // The relay landed via a previous claim attempt — treat as success.
            const alreadyDone = err.includes("custom program error: 0x0")
                            || err.includes("custom program error: #0")
                            || err.includes("4615026");
            if (alreadyDone) {
              b.status = "completed";
              b.completedAt = Math.floor(Date.now() / 1000);
              b.error = "Already claimed on-chain (no action needed).";
              console.info(`[bridge-watcher] ${b.txHash.slice(0,12)} already claimed — marking completed`);
            } else {
              b.error = err.slice(-1500);
              const transient = /(?:429|rate.?limit|too many requests|fetch failed|requested resource not available|http request failed|timeout)/i.test(err);
              if (transient) {
                b.status = "ready";
                b.retryAt = Math.floor(Date.now() / 1000) + 60;
                console.warn(`[bridge-watcher] transient claim failure ${b.txHash}; retry scheduled:`, b.error.slice(0, 200));
              } else {
                b.status = "failed";
                console.warn(`[bridge-watcher] claim failed ${b.txHash}:`, b.error.slice(0, 200));
              }
            }
          }
          await this.save();
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Auto-discovery: scan Base for completed bridges that went through one of
   * our tip routers but were never registered via /bridge/register-pending
   * (frontend bug, network blip, closed tab, etc). The tip-router enforces
   * payment on-chain so a router-sourced Transfer guarantees the user paid
   * the tip — admin SOL stays protected.
   */
  async discoverTick() {
    if (this.discoverInFlight) return;
    this.discoverInFlight = true;
    try {
      const head = await baseClient.getBlockNumber();
      let from = this.lastScannedBlock + 1n;
      // First-time bootstrap: only look back DISCOVER_BACKFILL_BLOCKS so we
      // don't re-process the entire chain on a fresh deploy.
      if (this.lastScannedBlock === 0n) {
        from = head - DISCOVER_BACKFILL_BLOCKS;
        if (from < 0n) from = 0n;
      }
      if (from > head) return; // already at head

      // getLogs cap on Base public RPC has tightened to ~1k blocks per call.
      const STEP = 500n;
      let cursor = from;
      while (cursor <= head) {
        const stop = (cursor + STEP - 1n) > head ? head : (cursor + STEP - 1n);
        // Filter supported-token Transfers TO the bridge contract. For wASS
        // this is the second router → bridge hop. POKE calls the official
        // bridge directly and is validated from the outgoing event below.
        for (const route of [
          { asset: "wASS", token: WASS_BASE },
          { asset: "POKE", token: POKE_BASE },
        ]) {
          const logs = await baseClient.getLogs({
            address: route.token,
            fromBlock: cursor,
            toBlock: stop,
            event: ERC20_TRANSFER_EVENT,
            args: { to: BRIDGE_CONTRACT },
          });
          for (const log of logs) {
            const fromAddr = "0x" + log.topics[1].slice(26).toLowerCase();
            if (route.asset === "wASS" && !TIP_ROUTERS.map(r => r.toLowerCase()).includes(fromAddr)) continue;
            const txHash = log.transactionHash.toLowerCase();
            if (this.state.bridges[txHash]) continue; // already known

            try {
              await this.discoverAndRegister(txHash, log.blockNumber, route.asset);
            } catch (e) {
              console.warn(
                `[bridge-watcher] discover ${txHash.slice(0, 12)} failed:`,
                (e?.message || String(e)).slice(0, 200),
              );
            }
          }
        }
        cursor = stop + 1n;
      }
      this.lastScannedBlock = head;
      await this.save();
    } finally {
      this.discoverInFlight = false;
    }
  }

  /**
   * Decode a router→bridge tx and register it for auto-claim. Resolves the
   * destination Solana ATA from the bridge's outgoing-message event.
   */
  async discoverAndRegister(txHash, blockNumber, expectedAsset = "wASS") {
    const [tx, receipt] = await Promise.all([
      baseClient.getTransaction({ hash: txHash }),
      baseClient.getTransactionReceipt({ hash: txHash }),
    ]);
    if (receipt.status !== "success") return;

    // Sender = the EOA that initiated. For direct EOA call, tx.from. For
    // smart-wallet batched execute (EIP-7702 etc), tx.from IS the user EOA
    // (the EOA's bytecode is delegated to a smart account impl).
    const sender = tx.from.toLowerCase();

    // Decode the bridge contract's outgoing-message event to get the
    // destination ATA on Solana. Event data layout (each field 32 bytes):
    //   [0..32]   localToken (left-padded address)
    //   [32..64]  remoteToken (bytes32 — wASS SPL mint)
    //   [64..96]  to (bytes32 — destination Solana account)
    //   [96..128] amount (uint256 — Base-side wei value)
    // NOTE: this slot is the Base 18-dec wei amount, NOT the 9-dec SPL
    // units. Confirmed empirically: 10-wASS bridges emit 0x..8ac7230489e80000
    // (= 10e18). Don't rescale.
    let localToken = null;
    let remoteToken = null;
    let destBytes32 = null;
    let amountWei = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== BRIDGE_CONTRACT.toLowerCase()) continue;
      if ((log.topics[0] || "").toLowerCase() !== BRIDGE_OUTGOING_TOPIC) continue;
      const data = log.data.slice(2);
      localToken = "0x" + data.slice(24, 64);
      remoteToken = "0x" + data.slice(64, 128);
      destBytes32 = "0x" + data.slice(128, 192);
      amountWei = BigInt("0x" + data.slice(192, 256)).toString();
      break;
    }
    if (!destBytes32 || !amountWei) {
      throw new Error("could not decode bridge outgoing event");
    }
    const expectedLocal = expectedAsset === "POKE" ? POKE_BASE : WASS_BASE;
    if (localToken.toLowerCase() !== expectedLocal.toLowerCase()) {
      throw new Error(`bridge outgoing local token does not match ${expectedAsset}`);
    }
    if (expectedAsset === "POKE" && remoteToken.toLowerCase() !== POKE_REMOTE_TOKEN) {
      throw new Error("bridge outgoing remote token is not the canonical Solana POKE mint");
    }
    const destinationAta = bytes32ToBase58(destBytes32);

    // Recipient pubkey: we can't reverse-derive the OWNER from the ATA
    // without an RPC call to Solana. Fetch the ATA's owner so the relay
    // step has the right destination. If the ATA doesn't exist on Solana
    // yet, owner lookup returns null — that's a first-time bridge.
    const recipientPubkey = await fetchAtaOwner(destinationAta);
    const ataExists = recipientPubkey !== null;

    // POKE finalization transfers into an existing Token-2022 account and
    // cannot create it as part of relay. Refuse an unsafe registration rather
    // than repeatedly spending the payer's SOL on a message that cannot land.
    if (expectedAsset === "POKE" && !ataExists) {
      throw new Error("POKE destination token account does not exist on Solana");
    }

    // Anti-spam: a first-time bridge requires the firstTime fee event in
    // the receipt. Otherwise admin would lock 0.002 SOL/wallet — drainable
    // by anyone bridging 1 wASS to N fresh ATAs.
    if (expectedAsset === "wASS" && !ataExists) {
      const paidFirstTime = receipt.logs.some((log) => {
        const addr = (log.address || "").toLowerCase();
        if (!TIP_ROUTERS.map((r) => r.toLowerCase()).includes(addr)) return false;
        if ((log.topics?.[0] || "").toLowerCase() !== TIP_FIRST_TIME_TOPIC) return false;
        const userTopic = log.topics[1];
        if (!userTopic) return false;
        const user = ("0x" + userTopic.slice(26)).toLowerCase();
        return user === sender.toLowerCase();
      });
      if (!paidFirstTime) {
        console.warn(
          `[bridge-watcher] discover ${txHash.slice(0, 12)} skipped — fresh ATA without firstTime fee`,
        );
        return;
      }
    }

    await this.register({
      txHash,
      sender,
      asset: expectedAsset,
      recipientPubkey: recipientPubkey || destinationAta,
      destinationAta,
      baseBlockNumber: String(blockNumber),
      amountWei,
    });
    console.info(
      `[bridge-watcher] discovered+registered ${txHash.slice(0, 12)} ` +
      `${(BigInt(amountWei)/10n**18n).toString()} ${expectedAsset} → ${destinationAta.slice(0,8)}…`,
    );
  }

  start() { if (!require("../lib/role").isWorker) return;
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), POLL_INTERVAL_MS);
    this.tick().catch(() => {});
    if (AUTO_DISCOVER_ENABLED) {
      this.discoverTimer = setInterval(
        () => this.discoverTick().catch((e) =>
          console.warn("[bridge-watcher] discover error:", e?.message)),
        DISCOVER_INTERVAL_MS,
      );
      this.discoverTick().catch((e) =>
        console.warn("[bridge-watcher] discover error:", e?.message));
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.discoverTimer) clearInterval(this.discoverTimer);
    this.timer = null;
    this.discoverTimer = null;
  }
}

// Solana base58 + ATA-owner helpers, kept at module level to avoid
// reaching for a heavy dep just for two utilities.
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bytes32ToBase58(hex) {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    out = BASE58[r] + out;
    n = n / 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

async function fetchAtaOwner(ata) {
  try {
    const r = await fetch(SOL_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getAccountInfo",
        params: [ata, { encoding: "base64" }],
      }),
    }).then((x) => x.json());
    const b64 = r?.result?.value?.data?.[0];
    if (!b64) return null;
    // SPL Token (and Token-2022) account layout starts with 32 bytes mint
    // then 32 bytes owner. Decode owner at offset 32..64.
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 64) return null;
    return bytes32ToBase58("0x" + buf.subarray(32, 64).toString("hex"));
  } catch {
    return null;
  }
}

const watcher = new BridgeWatcher();
let initialized = false;
async function ensureInit() {
  if (initialized) return;
  initialized = true;
  await watcher.load();
  watcher.start();
}

module.exports = { watcher, ensureInit };
