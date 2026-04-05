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

const VAULT_DIR = (projectRoot) => path.join(projectRoot || process.cwd(), ".wolverine", "vault");
const MASTER_KEY_PATH = (projectRoot) => path.join(VAULT_DIR(projectRoot), "master.key");
const ETH_VAULT_PATH = (projectRoot) => path.join(VAULT_DIR(projectRoot), "eth.vault");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Initialize the vault. Idempotent — creates keys only if missing.
 * Called during runner startup before any server code runs.
 */
async function initVault(projectRoot) {
  const vaultDir = VAULT_DIR(projectRoot);
  fs.mkdirSync(vaultDir, { recursive: true });

  let created = false;

  // Master encryption key
  if (!fs.existsSync(MASTER_KEY_PATH(projectRoot))) {
    const masterKey = crypto.randomBytes(32);
    fs.writeFileSync(MASTER_KEY_PATH(projectRoot), masterKey);
    try { fs.chmodSync(MASTER_KEY_PATH(projectRoot), 0o600); } catch {}
    masterKey.fill(0);
    created = true;
    console.log("  🔐 Vault: master encryption key generated");
  }

  // Ethereum private key (encrypted)
  if (!fs.existsSync(ETH_VAULT_PATH(projectRoot))) {
    const ethKey = crypto.randomBytes(32);
    await encryptAndStore(ethKey, { projectRoot });
    ethKey.fill(0);
    created = true;
    console.log("  🔐 Vault: ethereum wallet created");
  }

  return { created };
}

/**
 * Check if vault is fully initialized.
 */
function isVaultInitialized(projectRoot) {
  return fs.existsSync(MASTER_KEY_PATH(projectRoot)) && fs.existsSync(ETH_VAULT_PATH(projectRoot));
}

/**
 * Encrypt a private key Buffer and write to eth.vault.
 * Wipes the master key from memory after use.
 */
async function encryptAndStore(keyBuf, options) {
  const projectRoot = options?.projectRoot;
  let masterKey = null;
  try {
    masterKey = fs.readFileSync(MASTER_KEY_PATH(projectRoot));
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
      rotated: options?.rotated || null,
    };

    const tmpPath = ETH_VAULT_PATH(projectRoot) + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(vault, null, 2), "utf-8");
    fs.renameSync(tmpPath, ETH_VAULT_PATH(projectRoot));
    try { fs.chmodSync(ETH_VAULT_PATH(projectRoot), 0o600); } catch {}
  } finally {
    if (masterKey) masterKey.fill(0);
  }
}

/**
 * Decrypt the Ethereum private key. Returns a Buffer.
 * CALLER MUST call .fill(0) on the returned Buffer when done.
 */
function decryptPrivateKey(projectRoot) {
  if (!isVaultInitialized(projectRoot)) {
    throw new Error("vault not initialized");
  }

  let masterKey = null;
  try {
    masterKey = fs.readFileSync(MASTER_KEY_PATH(projectRoot));
    const vault = JSON.parse(fs.readFileSync(ETH_VAULT_PATH(projectRoot), "utf-8"));

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
async function rotateEncryption(projectRoot) {
  let keyBuf = null;
  try {
    keyBuf = decryptPrivateKey(projectRoot);
    await encryptAndStore(keyBuf, { rotated: new Date().toISOString(), projectRoot });
  } finally {
    if (keyBuf) keyBuf.fill(0);
  }
}

/**
 * Export vault contents for backup. Returns raw Buffers.
 * Caller MUST wipe masterKey after writing to backup.
 */
function exportVaultForBackup(projectRoot) {
  if (!isVaultInitialized(projectRoot)) return null;
  return {
    masterKey: fs.readFileSync(MASTER_KEY_PATH(projectRoot)),
    vaultFile: fs.readFileSync(ETH_VAULT_PATH(projectRoot), "utf-8"),
  };
}

/**
 * Import vault from backup. Only used during catastrophic recovery
 * when both vault files are missing.
 */
function importVaultFromBackup(masterKeyBuf, vaultFileStr, projectRoot) {
  const vaultDir = VAULT_DIR(projectRoot);
  fs.mkdirSync(vaultDir, { recursive: true });

  fs.writeFileSync(MASTER_KEY_PATH(projectRoot), masterKeyBuf);
  try { fs.chmodSync(MASTER_KEY_PATH(projectRoot), 0o600); } catch {}

  fs.writeFileSync(ETH_VAULT_PATH(projectRoot), vaultFileStr, "utf-8");
  try { fs.chmodSync(ETH_VAULT_PATH(projectRoot), 0o600); } catch {}
}

function getVaultPath(projectRoot) { return VAULT_DIR(projectRoot); }

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
