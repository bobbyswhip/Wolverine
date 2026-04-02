const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const chalk = require("chalk");
const { INSTANCE_ID } = require("./telemetry");

/**
 * Auto-Registration — registers with the configured platform URL.
 *
 * First run: POST /api/v1/register → get key → save to .wolverine/platform-key
 * Subsequent runs: read saved key → start heartbeats immediately
 *
 * User only needs to set WOLVERINE_PLATFORM_URL. The key is auto-managed.
 */

const KEY_PATH = path.join(process.cwd(), ".wolverine", "platform-key");
let _registerAttempts = 0;

/**
 * Get platform key — load saved or auto-register to get one.
 * Called on startup and retried every heartbeat tick until success.
 */
async function getOrCreateKey(platformUrl) {
  // Check env override first
  if (process.env.WOLVERINE_PLATFORM_KEY) {
    return process.env.WOLVERINE_PLATFORM_KEY;
  }

  // Check saved key
  const saved = loadSavedKey();
  if (saved) return saved;

  // No key — register with platform
  if (!platformUrl) return null;

  _registerAttempts++;

  const name = process.env.WOLVERINE_INSTANCE_NAME
    || path.basename(process.cwd())
    || "wolverine-server";

  // Log on first attempt and every 10th retry (don't spam)
  if (_registerAttempts === 1) {
    console.log(chalk.cyan(`  📡 Registering with ${platformUrl}...`));
  } else if (_registerAttempts % 10 === 0) {
    console.log(chalk.gray(`  📡 Registration retry #${_registerAttempts}...`));
  }

  try {
    const result = await postJSON(`${platformUrl}/api/v1/register`, {
      instanceId: INSTANCE_ID,
      name,
      version: require("../../package.json").version,
    });

    if (result.key) {
      saveKey(result.key);
      console.log(chalk.green(`  📡 Registered: ${INSTANCE_ID} (${name})${_registerAttempts > 1 ? ` after ${_registerAttempts} attempts` : ""}`));
      _registerAttempts = 0;
      return result.key;
    }

    return null;
  } catch (err) {
    if (_registerAttempts === 1) {
      console.log(chalk.yellow(`  📡 Registration failed: ${err.message} — will keep retrying`));
    }
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
        try { resolve(JSON.parse(responseBody)); }
        catch { reject(new Error(`Invalid response: ${responseBody.slice(0, 100)}`)); }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

module.exports = { getOrCreateKey, loadSavedKey };
