const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { INSTANCE_ID } = require("./telemetry");

const KEY_PATH = path.join(process.cwd(), ".wolverine", "platform-key");
let _attempts = 0;
let _cachedKey = null;

async function getOrCreateKey(platformUrl) {
  if (process.env.WOLVERINE_PLATFORM_KEY) return process.env.WOLVERINE_PLATFORM_KEY;
  if (_cachedKey) return _cachedKey;

  try {
    if (fs.existsSync(KEY_PATH)) {
      const k = fs.readFileSync(KEY_PATH, "utf-8").trim();
      if (k.length > 10) { _cachedKey = k; return k; }
    }
  } catch {}

  if (!platformUrl) return null;
  _attempts++;

  if (_attempts === 1) console.log(`  \x1b[36m📡 Registering with ${platformUrl}...\x1b[0m`);
  else if (_attempts % 10 === 0) console.log(`  \x1b[90m📡 Registration retry #${_attempts}\x1b[0m`);

  try {
    const name = process.env.WOLVERINE_INSTANCE_NAME || path.basename(process.cwd());
    const result = await post(`${platformUrl}/api/v1/register`, { instanceId: INSTANCE_ID, name });
    if (result.key) {
      try { fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true }); fs.writeFileSync(KEY_PATH, result.key); } catch {}
      _cachedKey = result.key;
      console.log(`  \x1b[32m📡 Registered: ${INSTANCE_ID}${_attempts > 1 ? ` (${_attempts} attempts)` : ""}\x1b[0m`);
      _attempts = 0;
      return result.key;
    }
    return null;
  } catch (e) {
    if (_attempts === 1) console.log(`  \x1b[33m📡 Registration failed: ${e.message} — retrying\x1b[0m`);
    return null;
  }
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const d = JSON.stringify(body);
    const req = (u.protocol === "https:" ? https : http).request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d) },
      timeout: 5000,
    }, res => {
      let b = ""; res.on("data", c => b += c);
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { reject(new Error("bad response")); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(d); req.end();
  });
}

module.exports = { getOrCreateKey };
