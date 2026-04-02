const fs = require("fs");
const path = require("path");

const QUEUE_PATH = path.join(process.cwd(), ".wolverine", "heartbeat-queue.jsonl");
const MAX_ENTRIES = 1440;

class HeartbeatQueue {
  constructor() { this._count = 0; }

  enqueue(payload) {
    try {
      fs.appendFileSync(QUEUE_PATH, JSON.stringify(payload) + "\n");
      this._count++;
      // Trim only when significantly over limit (not every write)
      if (this._count > MAX_ENTRIES + 100) {
        const lines = fs.readFileSync(QUEUE_PATH, "utf-8").trim().split("\n");
        fs.writeFileSync(QUEUE_PATH, lines.slice(-MAX_ENTRIES).join("\n") + "\n");
        this._count = MAX_ENTRIES;
      }
    } catch {}
  }

  async drain(url, key) {
    if (!fs.existsSync(QUEUE_PATH)) return 0;
    let lines;
    try { lines = fs.readFileSync(QUEUE_PATH, "utf-8").trim().split("\n").filter(Boolean); }
    catch { return 0; }
    if (!lines.length) return 0;

    let sent = 0;
    for (const line of lines) {
      try {
        const r = await fetch(`${url}/api/v1/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
          body: line,
          signal: AbortSignal.timeout(3000),
        });
        if (r.ok) sent++; else break;
      } catch { break; }
    }

    if (sent > 0) {
      const rest = lines.slice(sent);
      if (!rest.length) { try { fs.unlinkSync(QUEUE_PATH); } catch {} }
      else fs.writeFileSync(QUEUE_PATH, rest.join("\n") + "\n");
      this._count = rest.length;
    }
    return sent;
  }
}

module.exports = { HeartbeatQueue };
