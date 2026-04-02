const https = require("https");
const http = require("http");
const { URL } = require("url");
const chalk = require("chalk");
const { collectHeartbeat, INSTANCE_ID } = require("./telemetry");
const { getOrCreateKey } = require("./register");
const { HeartbeatQueue } = require("./queue");

/**
 * Heartbeat — sends telemetry to YOUR platform backend.
 *
 * Opt-in: set WOLVERINE_PLATFORM_URL and WOLVERINE_PLATFORM_KEY in .env.local
 * Without those, telemetry is disabled — zero overhead.
 *
 * This is the open-source client. Point it at your own platform backend
 * that implements the heartbeat API (see PLATFORM.md for the spec).
 */

// Default platform — every wolverine instance reports here unless overridden
const DEFAULT_PLATFORM = "https://api.wolverinenode.xyz";
const PLATFORM_URL = process.env.WOLVERINE_PLATFORM_URL || DEFAULT_PLATFORM;
const INTERVAL = parseInt(process.env.WOLVERINE_HEARTBEAT_INTERVAL_MS, 10) || 60000;

let _queue = null;
let _timer = null;
let _subsystems = null;
let _key = null;
let _consecutiveFailures = 0;

async function sendHeartbeat() {
  if (!PLATFORM_URL || !_key || !_subsystems) return;

  const payload = collectHeartbeat(_subsystems);
  const body = JSON.stringify(payload);

  try {
    const url = new URL(`${PLATFORM_URL}/api/v1/heartbeat`);
    const client = url.protocol === "https:" ? https : http;

    const result = await new Promise((resolve, reject) => {
      const req = client.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Authorization": `Bearer ${_key}`,
          "X-Instance-Id": INSTANCE_ID,
        },
        timeout: 5000,
      }, (res) => {
        let data = "";
        res.on("data", (d) => { data += d; });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });

      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.write(body);
      req.end();
    });

    if (result.status >= 200 && result.status < 300) {
      if (_consecutiveFailures > 0) {
        console.log(chalk.green(`  📡 Platform reconnected after ${_consecutiveFailures} failures`));
      }
      _consecutiveFailures = 0;
      const drained = await _queue.drain(PLATFORM_URL, _key);
      if (drained > 0) console.log(chalk.gray(`  📡 Drained ${drained} queued heartbeats`));
    } else {
      _consecutiveFailures++;
      _queue.enqueue(payload);
      if (_consecutiveFailures === 1 || _consecutiveFailures % 10 === 0) {
        console.log(chalk.yellow(`  📡 Platform ${result.status} (${_consecutiveFailures} failures, ${_queue.getQueueSize()} queued)`));
      }
    }
  } catch (err) {
    _consecutiveFailures++;
    _queue.enqueue(payload);
    if (_consecutiveFailures === 1 || _consecutiveFailures % 10 === 0) {
      console.log(chalk.yellow(`  📡 Platform unreachable: ${err.message} (${_consecutiveFailures} failures, ${_queue.getQueueSize()} queued)`));
    }
  }
}

/**
 * Start heartbeats. Only activates if WOLVERINE_PLATFORM_URL is set.
 * Auto-registers to get a key if none exists.
 */
async function startHeartbeat(subsystems) {
  if (process.env.WOLVERINE_TELEMETRY === "false") {
    console.log(chalk.gray("  📡 Telemetry: disabled (WOLVERINE_TELEMETRY=false)"));
    return;
  }

  _subsystems = subsystems;
  _queue = new HeartbeatQueue();

  // Auto-register or use saved/env key
  _key = await getOrCreateKey(PLATFORM_URL);
  if (!_key) {
    console.log(chalk.yellow("  📡 No key — heartbeats will queue until registered"));
  }

  const queueSize = _queue.getQueueSize();
  console.log(chalk.cyan(`  📡 Platform: ${PLATFORM_URL} (every ${INTERVAL / 1000}s${queueSize > 0 ? `, ${queueSize} queued` : ""})`));
  console.log(chalk.cyan(`  📡 Instance: ${INSTANCE_ID}`));

  setTimeout(() => sendHeartbeat(), 5000);
  _timer = setInterval(() => sendHeartbeat(), INTERVAL);
}

function stopHeartbeat() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_subsystems && _key) sendHeartbeat().catch(() => {});
}

module.exports = { startHeartbeat, stopHeartbeat, INSTANCE_ID };
