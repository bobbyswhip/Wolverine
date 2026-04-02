const fs = require("fs");
const path = require("path");

/**
 * Heartbeat Queue — offline resilience for platform telemetry.
 *
 * When the platform is unreachable, heartbeats are queued locally.
 * On reconnect, queued heartbeats are drained (oldest first).
 * Max 1440 entries (24 hours at 1/minute). Oldest dropped after that.
 */

const QUEUE_PATH = path.join(process.cwd(), ".wolverine", "heartbeat-queue.jsonl");
const MAX_ENTRIES = 1440;

class HeartbeatQueue {
  enqueue(payload) {
    try {
      fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
      fs.appendFileSync(QUEUE_PATH, JSON.stringify(payload) + "\n");

      // Trim if over max
      const content = fs.readFileSync(QUEUE_PATH, "utf-8");
      const lines = content.trim().split("\n");
      if (lines.length > MAX_ENTRIES) {
        fs.writeFileSync(QUEUE_PATH, lines.slice(-MAX_ENTRIES).join("\n") + "\n");
      }
    } catch {}
  }

  async drain(platformUrl, platformKey) {
    if (!fs.existsSync(QUEUE_PATH)) return 0;

    let lines;
    try {
      lines = fs.readFileSync(QUEUE_PATH, "utf-8").trim().split("\n").filter(Boolean);
    } catch { return 0; }

    if (lines.length === 0) return 0;

    let sent = 0;
    for (const line of lines) {
      try {
        const res = await fetch(`${platformUrl}/api/v1/heartbeat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${platformKey}`,
          },
          body: line,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) sent++;
        else break;
      } catch {
        break;
      }
    }

    // Remove sent entries
    if (sent > 0) {
      const remaining = lines.slice(sent);
      if (remaining.length === 0) {
        try { fs.unlinkSync(QUEUE_PATH); } catch {}
      } else {
        fs.writeFileSync(QUEUE_PATH, remaining.join("\n") + "\n");
      }
    }

    return sent;
  }

  getQueueSize() {
    if (!fs.existsSync(QUEUE_PATH)) return 0;
    try {
      return fs.readFileSync(QUEUE_PATH, "utf-8").trim().split("\n").filter(Boolean).length;
    } catch { return 0; }
  }
}

module.exports = { HeartbeatQueue };
