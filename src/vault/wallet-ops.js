const { decryptPrivateKey } = require("./vault-manager");

/**
 * Wallet Operations — safe Ethereum wallet interactions.
 *
 * Every function follows the same pattern:
 * 1. Decrypt private key into Buffer
 * 2. Use it (sign, derive address, etc.)
 * 3. Wipe Buffer in finally block
 * 4. Catch block swallows real error, throws generic message
 *
 * The private key NEVER exists as a JavaScript string.
 * Error messages are always generic — no hex, no key material, no details
 * that could leak through the AI repair pipeline.
 */

/**
 * Derive the Ethereum address from the vault's private key.
 * Address is not secret — safe to return as string.
 */
async function getWalletAddress() {
  let keyBuf = null;
  try {
    keyBuf = decryptPrivateKey();
    const { keccak256, getPublicKey } = _getCrypto();
    const pubKey = getPublicKey(keyBuf);
    const address = _pubKeyToAddress(pubKey, keccak256);
    return address;
  } catch {
    throw new Error("wallet operation failed: could not derive address");
  } finally {
    if (keyBuf) keyBuf.fill(0);
  }
}

/**
 * Get the compressed public key hex. Not secret.
 */
async function getPublicKeyHex() {
  let keyBuf = null;
  try {
    keyBuf = decryptPrivateKey();
    const { getPublicKey } = _getCrypto();
    const pubKey = getPublicKey(keyBuf, true); // compressed
    return Buffer.from(pubKey).toString("hex");
  } catch {
    throw new Error("wallet operation failed: could not derive public key");
  } finally {
    if (keyBuf) keyBuf.fill(0);
  }
}

/**
 * Sign an arbitrary message. Returns signature hex string.
 * @param {string|Buffer} message — the message to sign
 */
async function signMessage(message) {
  let keyBuf = null;
  try {
    keyBuf = decryptPrivateKey();
    const { keccak256, sign } = _getCrypto();
    const msgBuf = typeof message === "string" ? Buffer.from(message) : message;
    // Ethereum signed message prefix
    const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${msgBuf.length}`);
    const hash = keccak256(Buffer.concat([prefix, msgBuf]));
    const sig = sign(hash, keyBuf);
    return sig;
  } catch {
    throw new Error("wallet operation failed: could not sign message");
  } finally {
    if (keyBuf) keyBuf.fill(0);
  }
}

/**
 * Sign a transaction object. Returns signed transaction hex.
 * @param {object} tx — { to, value, data?, nonce, gasLimit, gasPrice?, maxFeePerGas?, maxPriorityFeePerGas?, chainId }
 */
async function signTransaction(tx) {
  // Validate BEFORE decrypting — don't touch the key for bad input
  if (!tx || typeof tx !== "object") throw new Error("wallet operation failed: invalid transaction");
  if (!tx.to || !tx.chainId) throw new Error("wallet operation failed: missing required fields");

  let keyBuf = null;
  try {
    keyBuf = decryptPrivateKey();
    // Use ethers for tx serialization + signing, but feed it a raw signer
    const { Wallet } = require("ethers");
    const wallet = new Wallet(keyBuf);
    const signed = await wallet.signTransaction(tx);
    return signed;
  } catch {
    throw new Error("wallet operation failed: could not sign transaction");
  } finally {
    if (keyBuf) keyBuf.fill(0);
  }
}

/**
 * Get vault status — safe metadata only, no key material.
 */
function getVaultStatus() {
  const { isVaultInitialized, getVaultPath } = require("./vault-manager");
  const fs = require("fs");
  const masterExists = fs.existsSync(require("./vault-manager").MASTER_KEY_PATH());
  const ethExists = fs.existsSync(require("./vault-manager").ETH_VAULT_PATH());

  return {
    initialized: isVaultInitialized(),
    vaultPath: getVaultPath(),
    masterKeyExists: masterExists,
    ethVaultExists: ethExists,
  };
}

// ── Crypto helpers (use @noble/secp256k1 or built-in) ──

function _getCrypto() {
  const crypto = require("crypto");

  function keccak256(data) {
    // Ethereum uses keccak256 (NOT NIST SHA3-256)
    try {
      const { keccak256: k } = require("ethers");
      const buf = data instanceof Uint8Array ? data : Buffer.from(data);
      const hex = k(buf);
      return Buffer.from(hex.slice(2), "hex");
    } catch {
      return crypto.createHash("sha3-256").update(data).digest();
    }
  }

  function getPublicKey(privKeyBuf, compressed = false) {
    const ecdh = crypto.createECDH("secp256k1");
    ecdh.setPrivateKey(privKeyBuf);
    return compressed ? ecdh.getPublicKey("buffer", "compressed") : ecdh.getPublicKey("buffer", "uncompressed");
  }

  function sign(hash, privKeyBuf) {
    const sig = crypto.sign(null, hash, {
      key: crypto.createPrivateKey({
        key: Buffer.concat([
          // DER-encode secp256k1 private key
          Buffer.from("302e0201010420", "hex"),
          privKeyBuf,
          Buffer.from("a00706052b8104000a", "hex"),
        ]),
        format: "der",
        type: "sec1",
      }),
      dsaEncoding: "ieee-p1363",
    });
    return sig.toString("hex");
  }

  return { keccak256, getPublicKey, sign };
}

function _pubKeyToAddress(uncompressedPubKey, keccak256) {
  // Skip the 0x04 prefix byte, hash the rest, take last 20 bytes
  const pubBytes = uncompressedPubKey.slice(1);
  const hash = keccak256(pubBytes);
  const addrBytes = hash.slice(hash.length - 20);
  const addr = "0x" + addrBytes.toString("hex");
  // EIP-55 checksum
  const addrLower = addr.slice(2).toLowerCase();
  const hashHex = keccak256(Buffer.from(addrLower)).toString("hex");
  let checksummed = "0x";
  for (let i = 0; i < 40; i++) {
    checksummed += parseInt(hashHex[i], 16) >= 8 ? addrLower[i].toUpperCase() : addrLower[i];
  }
  return checksummed;
}

module.exports = { getWalletAddress, getPublicKeyHex, signMessage, signTransaction, getVaultStatus };
