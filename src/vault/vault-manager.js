const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/**
 * Vault Manager — encrypted key storage for the wolverine framework.
 *
 * Two files in .wolverine/vault/:
 *   master.key  — 32 bytes raw AES-256 key (chmod 0600)
 *   eth.vault   — JSON with AES-256-GCM encrypted Ethereum private key
 *
 * Design principles:
 * - Private keys NEVER exist as JavaScript strings (only Buffers, wipe-able)
 * - Generic errors only — wallet-ops swallows details before they reach AI
 * - master.key is the single secret on disk — everything else is encrypted
 * - Survives git pull, npm install, auto-update (lives in .wolverine/)
 */

const VAULT_DIR = () => path.join(process.cwd(), ".wolverine", "vault");
const MASTER_KEY_PATH = () => path.join(VAULT_DIR(), "master.key");
const ETH_VAULT_PATH = () => path.join(VAULT_DIR(), "eth.vault");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Initialize the vault. Idempotent — creates keys only if missing.
 * Called during runner startup before any server code runs.
 */
async function initVault() {
  const vaultDir = VAULT_DIR();
  fs.mkdirSync(vaultDir, { recursive: true });

  let created = false;

  // Master encryption key
  if (!fs.existsSync(MASTER_KEY_PATH())) {
    const masterKey = crypto.randomBytes(32);
    fs.writeFileSync(MASTER_KEY_PATH(), masterKey);
    try { fs.chmodSync(MASTER_KEY_PATH(), 0o600); } catch {}
    masterKey.fill(0);
    created = true;
    console.log("  🔐 Vault: master encryption key generated");
  }

  // Ethereum private key (encrypted)
  if (!fs.existsSync(ETH_VAULT_PATH())) {
    const ethKey = crypto.randomBytes(32);
    await encryptAndStore(ethKey);
    ethKey.fill(0);
    created = true;
    console.log("  🔐 Vault: ethereum wallet created");
  }

  return { created };
}

/**
 * Check if vault is fully initialized.
 */
function isVaultInitialized() {
  return fs.existsSync(MASTER_KEY_PATH()) && fs.existsSync(ETH_VAULT_PATH());
}

/**
 * Encrypt a private key Buffer and write to eth.vault.
 * Wipes the master key from memory after use.
 */
async function encryptAndStore(keyBuf) {
  let masterKey = null;
  try {
    masterKey = fs.readFileSync(MASTER_KEY_PATH());
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(keyBuf), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const vault = {
      version: 1,
      algorithm: ALGORITHM,
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
      ciphertext: encrypted.toString("hex"),
      created: new Date().toISOString(),
      rotated: null,
    };

    const tmpPath = ETH_VAULT_PATH() + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(vault, null, 2), "utf-8");
    fs.renameSync(tmpPath, ETH_VAULT_PATH());
    try { fs.chmodSync(ETH_VAULT_PATH(), 0o600); } catch {}
  } finally {
    if (masterKey) masterKey.fill(0);
  }
}

/**
 * Decrypt the Ethereum private key. Returns a Buffer.
 * CALLER MUST call .fill(0) on the returned Buffer when done.
 */
function decryptPrivateKey() {
  if (!isVaultInitialized()) {
    throw new Error("vault not initialized");
  }

  let masterKey = null;
  try {
    masterKey = fs.readFileSync(MASTER_KEY_PATH());
    const vault = JSON.parse(fs.readFileSync(ETH_VAULT_PATH(), "utf-8"));

    if (vault.version !== 1) throw new Error("unsupported vault version");

    const iv = Buffer.from(vault.iv, "hex");
    const authTag = Buffer.from(vault.authTag, "hex");
    const ciphertext = Buffer.from(vault.ciphertext, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally {
    if (masterKey) masterKey.fill(0);
  }
}

/**
 * Re-encrypt with a fresh IV. Defensive measure if key material was
 * potentially exposed in an error message.
 */
async function rotateEncryption() {
  let keyBuf = null;
  try {
    keyBuf = decryptPrivateKey();
    await encryptAndStore(keyBuf);

    // Update rotated timestamp
    const vault = JSON.parse(fs.readFileSync(ETH_VAULT_PATH(), "utf-8"));
    vault.rotated = new Date().toISOString();
    fs.writeFileSync(ETH_VAULT_PATH(), JSON.stringify(vault, null, 2), "utf-8");
  } finally {
    if (keyBuf) keyBuf.fill(0);
  }
}

/**
 * Export vault contents for backup. Returns raw Buffers.
 * Caller MUST wipe masterKey after writing to backup.
 */
function exportVaultForBackup() {
  if (!isVaultInitialized()) return null;
  return {
    masterKey: fs.readFileSync(MASTER_KEY_PATH()),
    vaultFile: fs.readFileSync(ETH_VAULT_PATH(), "utf-8"),
  };
}

/**
 * Import vault from backup. Only used during catastrophic recovery
 * when both vault files are missing.
 */
function importVaultFromBackup(masterKeyBuf, vaultFileStr) {
  const vaultDir = VAULT_DIR();
  fs.mkdirSync(vaultDir, { recursive: true });

  fs.writeFileSync(MASTER_KEY_PATH(), masterKeyBuf);
  try { fs.chmodSync(MASTER_KEY_PATH(), 0o600); } catch {}

  fs.writeFileSync(ETH_VAULT_PATH(), vaultFileStr, "utf-8");
  try { fs.chmodSync(ETH_VAULT_PATH(), 0o600); } catch {}
}

function getVaultPath() { return VAULT_DIR(); }

module.exports = {
  initVault,
  isVaultInitialized,
  decryptPrivateKey,
  rotateEncryption,
  exportVaultForBackup,
  importVaultFromBackup,
  getVaultPath,
  MASTER_KEY_PATH,
  ETH_VAULT_PATH,
};
