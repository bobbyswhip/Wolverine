const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const chalk = require("chalk");
const { INSTANCE_ID } = require("./telemetry");

/**
 * Auto-Registration — zero-config platform onboarding.
 *
 * First run: no key → register with platform → save key locally
 * Subsequent runs: read saved key → start heartbeats immediately
 */

const KEY_PATH = path.join(process.cwd(), ".wolverine", "platform-key");
const PLATFORM_URL = process.env.WOLVERINE_PLATFORM_URL || "https://api.wolverinenode.xyz";

/**
 * Get or create a platform API key.
 * Returns the key string, or null if registration failed.
 */
async function getOrCreateKey() {
  // Check saved key first
  const saved = loadSavedKey();
  if (saved) return saved;

  // No saved key — register with platform
  console.log(chalk.cyan("  📡 First run — registering with platform..."));

  const name = process.env.WOLVERINE_INSTANCE_NAME
    || path.basename(process.cwd())
    || "wolverine-server";

  try {
    const result = await postJSON(`${PLATFORM_URL}/api/v1/register`, {
      instanceId: INSTANCE_ID,
      name,
      version: require("../../package.json").version,
    });

    if (result.key) {
      saveKey(result.key);
      console.log(chalk.green(`  📡 Registered: ${INSTANCE_ID} (${name})`));
      return result.key;
    }

    console.log(chalk.yellow(`  📡 Registration returned no key: ${JSON.stringify(result)}`));
    return null;
  } catch (err) {
    console.log(chalk.yellow(`  📡 Registration failed: ${err.message} — will retry next startup`));
    return null;
  }
}

function loadSavedKey() {
  try {
    if (fs.existsSync(KEY_PATH)) {
      const key = fs.readFileSync(KEY_PATH, "utf-8").trim();
      if (key.length > 10) return key;
    }
  } catch {}
  return null;
}

function saveKey(key) {
  try {
    fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
    fs.writeFileSync(KEY_PATH, key, "utf-8");
  } catch {}
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const data = JSON.stringify(body);

    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 10000,
    }, (res) => {
      let responseBody = "";
      res.on("data", (d) => { responseBody += d; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(responseBody));
        } catch {
          reject(new Error(`Invalid response: ${responseBody.slice(0, 100)}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

module.exports = { getOrCreateKey, loadSavedKey, PLATFORM_URL };
