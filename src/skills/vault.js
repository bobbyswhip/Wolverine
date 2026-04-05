/**
 * Vault Skill — secure wallet operations for the agent and server.
 *
 * Exposes wallet functionality (sign, address, status) through the
 * skill registry so agents and server code can use the wallet WITHOUT
 * ever touching the private key directly.
 *
 * The private key is decrypted in-memory, used, and wiped. Error messages
 * are always generic to prevent key leakage through the AI repair pipeline.
 */

const SKILL_NAME = "vault";
const SKILL_DESCRIPTION = "Secure Ethereum wallet + x402 payments — sign transactions, get address, manage paid API routes. Private key encrypted at rest via AES-256-GCM, never exposed in code or errors. x402 support: set prices on routes, receive USDC on Base network.";
const SKILL_KEYWORDS = ["wallet", "ethereum", "eth", "sign", "transaction", "vault", "private key", "address", "crypto", "blockchain", "send", "transfer", "x402", "payment", "usdc", "base", "price", "paid", "api"];
const SKILL_USAGE = `
  vault.status()           — check if vault is initialized, show address
  vault.address()          — get the wallet's Ethereum address
  vault.sign_tx(tx)        — sign a transaction { to, value, chainId, nonce, gasLimit }
  vault.sign_message(msg)  — sign an arbitrary message
  vault.public_key()       — get compressed public key hex

  SECURITY: The private key never leaves the vault. All operations decrypt
  in-memory, use, and wipe. Error messages are generic — no key material
  can leak into the AI repair pipeline.
`;

/**
 * Execute a vault action. Called by skill registry when matched.
 * @param {string} action — "status" | "address" | "sign_tx" | "sign_message" | "public_key"
 * @param {object} params — action-specific parameters
 */
async function execute(action, params = {}) {
  const { getWalletAddress, getPublicKeyHex, signMessage, signTransaction, getVaultStatus } = require("../vault/wallet-ops");

  switch (action) {
    case "status": {
      const status = getVaultStatus();
      if (status.initialized) {
        try {
          status.address = await getWalletAddress();
        } catch {
          status.address = null;
        }
      }
      return status;
    }

    case "address":
      return { address: await getWalletAddress() };

    case "public_key":
      return { publicKey: await getPublicKeyHex() };

    case "sign_message":
      if (!params.message) return { error: "message required" };
      return { signature: await signMessage(params.message) };

    case "sign_tx": {
      if (!params.to || !params.chainId) return { error: "to and chainId required" };
      const signed = await signTransaction(params);
      return { signedTransaction: signed };
    }

    default:
      return { error: `Unknown vault action: ${action}. Use: status, address, sign_tx, sign_message, public_key` };
  }
}

module.exports = { SKILL_NAME, SKILL_DESCRIPTION, SKILL_KEYWORDS, SKILL_USAGE, execute };
