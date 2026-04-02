const https = require("https");
const http = require("http");
const { URL } = require("url");
const chalk = require("chalk");
const { collectHeartbeat, INSTANCE_ID } = require("./telemetry");
const { HeartbeatQueue } = require("./queue");

/**
 * Heartbeat — sends telemetry to the platform on an interval.
 *
 * HTTPS only. Gzip optional. 5s timeout per request.
 * On failure: queues locally, drains on next success.
 */

const PLATFORM_URL = process.env.WOLVERINE_PLATFORM_URL;
const PLATFORM_KEY = process.env.WOLVERINE_PLATFORM_KEY;
const INTERVAL = parseInt(process.env.WOLVERINE_HEARTBEAT_INTERVAL_MS, 10) || 60000;

let _queue = null;
let _timer = null;
let _subsystems = null;
let _consecutiveFailures = 0;

/**
 * Send a single heartbeat to the platform.
 */
async function sendHeartbeat() {
  if (!PLATFORM_URL || !PLATFORM_KEY || !_subsystems) return;

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
          "Authorization": `Bearer ${PLATFORM_KEY}`,
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

      // Drain queued heartbeats
      const drained = await _queue.drain(PLATFORM_URL, PLATFORM_KEY);
      if (drained > 0) {
        console.log(chalk.gray(`  📡 Drained ${drained} queued heartbeats`));
      }
    } else {
      _consecutiveFailures++;
      _queue.enqueue(payload);
      if (_consecutiveFailures === 1 || _consecutiveFailures % 10 === 0) {
        console.log(chalk.yellow(`  📡 Platform returned ${result.status} (${_consecutiveFailures} failures, ${_queue.getQueueSize()} queued)`));
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
 * Start sending heartbeats on an interval.
 */
function startHeartbeat(subsystems) {
  if (!PLATFORM_URL || !PLATFORM_KEY) {
    console.log(chalk.gray("  📡 Platform telemetry: disabled (no WOLVERINE_PLATFORM_URL)"));
    return;
  }

  _subsystems = subsystems;
  _queue = new HeartbeatQueue();

  const queueSize = _queue.getQueueSize();
  console.log(chalk.cyan(`  📡 Platform: ${PLATFORM_URL} (every ${INTERVAL / 1000}s${queueSize > 0 ? `, ${queueSize} queued` : ""})`));
  console.log(chalk.cyan(`  📡 Instance: ${INSTANCE_ID} (${process.env.WOLVERINE_INSTANCE_NAME || "unnamed"})`));

  // First heartbeat after 5s (let subsystems initialize)
  setTimeout(() => sendHeartbeat(), 5000);
  _timer = setInterval(() => sendHeartbeat(), INTERVAL);
}

/**
 * Stop heartbeats. Send a final one before shutdown.
 */
function stopHeartbeat() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  // Best-effort final heartbeat
  if (_subsystems && PLATFORM_URL) {
    sendHeartbeat().catch(() => {});
  }
}

module.exports = { startHeartbeat, stopHeartbeat, INSTANCE_ID };
