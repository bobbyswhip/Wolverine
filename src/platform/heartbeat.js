const https = require("https");
const http = require("http");
const { URL } = require("url");
const { collectHeartbeat, INSTANCE_ID } = require("./telemetry");
const { getOrCreateKey } = require("./register");
const { HeartbeatQueue } = require("./queue");

// Minimal ANSI — no chalk import for a background process
const G = s => `\x1b[32m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const C = s => `\x1b[36m${s}\x1b[0m`;
const D = s => `\x1b[90m${s}\x1b[0m`;

const PLATFORM_URL = process.env.WOLVERINE_PLATFORM_URL || "https://api.wolverinenode.xyz";
const INTERVAL = parseInt(process.env.WOLVERINE_HEARTBEAT_INTERVAL_MS, 10) || 60000;

let _q, _t, _s, _k, _f = 0;

async function tick() {
  if (!_s) return;

  // Retry registration until we get a key
  if (!_k) {
    _k = await getOrCreateKey(PLATFORM_URL);
    if (!_k) return;
    console.log(G("  📡 Registered — heartbeats active"));
  }

  const body = JSON.stringify(collectHeartbeat(_s));

  try {
    const u = new URL(`${PLATFORM_URL}/api/v1/heartbeat`);
    const ok = await send(u, body);

    if (ok) {
      if (_f > 0) console.log(G(`  📡 Reconnected (was ${_f} failures)`));
      _f = 0;
      const d = await _q.drain(PLATFORM_URL, _k);
      if (d > 0) console.log(D(`  📡 Drained ${d} queued`));
    } else {
      _f++;
      _q.enqueue(JSON.parse(body));
      if (_f === 1 || _f % 10 === 0) console.log(Y(`  📡 Platform error (${_f} failures)`));
    }
  } catch {
    _f++;
    _q.enqueue(JSON.parse(body));
    if (_f === 1 || _f % 10 === 0) console.log(Y(`  📡 Unreachable (${_f} failures)`));
  }
}

function send(u, body) {
  return new Promise(resolve => {
    const req = (u.protocol === "https:" ? https : http).request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": `Bearer ${_k}`,
        "X-Instance-Id": INSTANCE_ID,
      },
      timeout: 5000,
    }, res => {
      res.resume(); // drain response
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

async function startHeartbeat(subsystems) {
  if (process.env.WOLVERINE_TELEMETRY === "false") {
    console.log(D("  📡 Telemetry: off"));
    return;
  }
  _s = subsystems;
  _q = new HeartbeatQueue();
  _k = await getOrCreateKey(PLATFORM_URL);

  console.log(C(`  📡 ${PLATFORM_URL} (${INTERVAL / 1000}s)`));
  setTimeout(tick, 5000);
  _t = setInterval(tick, INTERVAL);
}

function stopHeartbeat() {
  if (_t) { clearInterval(_t); _t = null; }
  if (_s && _k) tick().catch(() => {});
}

module.exports = { startHeartbeat, stopHeartbeat, INSTANCE_ID };
