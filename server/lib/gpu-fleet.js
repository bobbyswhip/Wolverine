const https = require("https");
const http = require("http");

/**
 * GPU Fleet Manager — controls Vast.ai GPU instances for inference.
 *
 * Features:
 * - Start/stop individual GPUs via Vast API
 * - Health monitoring and auto-discovery
 * - Round-robin routing across active GPUs
 * - Auto-scale: start burst GPUs when queue grows, stop when idle
 * - Cold start tracking (~5s per GPU)
 *
 * Each GPU instance runs llama.cpp with --api-key for security.
 * Only the EC2 backend has the internal keys.
 */

const VAST_API = "https://cloud.vast.ai/api/v0";
const VAST_KEY = process.env.VAST_API_KEY || "";
const POLL_INTERVAL_MS = 30000; // health check every 30s
const IDLE_STOP_MS = parseInt(process.env.GPU_IDLE_STOP_MS, 10) || 300000; // 5 min idle → stop
const SCALE_UP_QUEUE = parseInt(process.env.GPU_SCALE_UP_QUEUE, 10) || 3; // start burst GPU when 3+ queued

class GpuFleet {
  constructor(config = {}) {
    // GPU registry: { instanceId → { host, port, key, status, lastUsed, lastHealth, model } }
    this.gpus = new Map();
    this._roundRobinIndex = 0;
    this._pollTimer = null;
    this._scaleTimer = null;
    this._requestQueue = [];
    this._activeRequests = 0;
  }

  /**
   * Register a GPU instance in the fleet.
   */
  register(instanceId, { host, port, key, model = "wolverine-test-1", role = "general", autoStop = true }) {
    this.gpus.set(String(instanceId), {
      instanceId: String(instanceId),
      host, port: parseInt(port, 10), key,
      model, role, autoStop,
      status: "unknown", // unknown, starting, healthy, unhealthy, stopped
      lastUsed: 0,
      lastHealth: null,
      coldStartMs: null,
    });
    return this;
  }

  /**
   * Load GPU config from environment or database.
   */
  loadFromEnv() {
    // Primary GPU from env
    const url = process.env.WOLVERINE_INFERENCE_URL;
    const key = process.env.WOLVERINE_GPU_KEY;
    if (url && key) {
      try {
        const parsed = new URL(url);
        const instanceId = process.env.WOLVERINE_GPU_INSTANCE_ID || "primary";
        this.register(instanceId, {
          host: parsed.hostname,
          port: parseInt(parsed.port, 10) || 80,
          key,
          role: "primary",
          autoStop: false, // primary stays on
        });
      } catch {}
    }
    return this;
  }

  /**
   * Load GPU config from database.
   */
  async loadFromDb(pool) {
    try {
      // Check if gpu_fleet table exists
      const exists = await pool.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'gpu_fleet' LIMIT 1"
      );
      if (exists.rows.length === 0) {
        await pool.query(`
          CREATE TABLE gpu_fleet (
            instance_id TEXT PRIMARY KEY,
            vast_id TEXT,
            host TEXT NOT NULL,
            port INTEGER NOT NULL DEFAULT 8080,
            internal_key TEXT NOT NULL,
            model TEXT DEFAULT 'wolverine-test-1',
            role TEXT DEFAULT 'general',
            auto_stop BOOLEAN DEFAULT true,
            status TEXT DEFAULT 'stopped',
            gpu_name TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);
      }
      const { rows } = await pool.query("SELECT * FROM gpu_fleet");
      for (const r of rows) {
        this.register(r.instance_id, {
          host: r.host, port: r.port, key: r.internal_key,
          model: r.model, role: r.role, autoStop: r.auto_stop,
        });
        const gpu = this.gpus.get(r.instance_id);
        if (gpu) gpu.status = r.status;
        if (gpu) gpu.vastId = r.vast_id;
        if (gpu) gpu.gpuName = r.gpu_name;
      }
    } catch (err) {
      console.log("[GPU Fleet] DB load failed:", err.message);
    }
    return this;
  }

  /**
   * Start health polling.
   */
  startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._healthCheck(), POLL_INTERVAL_MS);
    this._healthCheck(); // immediate first check
    return this;
  }

  stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  /**
   * Get a healthy GPU for inference (round-robin).
   * Returns { host, port, key, instanceId } or null if none available.
   */
  getAvailable() {
    const healthy = Array.from(this.gpus.values()).filter(g => g.status === "healthy");
    if (healthy.length === 0) return null;
    this._roundRobinIndex = (this._roundRobinIndex + 1) % healthy.length;
    const gpu = healthy[this._roundRobinIndex];
    gpu.lastUsed = Date.now();
    return { host: gpu.host, port: gpu.port, key: gpu.key, instanceId: gpu.instanceId, model: gpu.model };
  }

  /**
   * Start a stopped GPU instance via Vast API.
   */
  async startGpu(instanceId) {
    const gpu = this.gpus.get(String(instanceId));
    if (!gpu) throw new Error(`GPU ${instanceId} not registered`);
    if (gpu.status === "healthy" || gpu.status === "starting") return gpu;

    gpu.status = "starting";
    gpu.coldStartMs = null;
    const startTime = Date.now();

    const vastId = gpu.vastId || instanceId;
    try {
      await this._vastApi("PUT", `/instances/${vastId}/`, { state: "running" });

      // Poll until healthy (max 60s)
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const res = await this._httpGet(gpu.host, gpu.port, "/v1/models", gpu.key);
          if (res && res.includes("gemma")) {
            gpu.status = "healthy";
            gpu.coldStartMs = Date.now() - startTime;
            gpu.lastHealth = Date.now();
            console.log(`[GPU Fleet] ${instanceId} started in ${gpu.coldStartMs}ms`);
            return gpu;
          }
        } catch {}
      }
      gpu.status = "unhealthy";
      throw new Error(`GPU ${instanceId} failed to start within 60s`);
    } catch (err) {
      gpu.status = "unhealthy";
      throw err;
    }
  }

  /**
   * Stop a GPU instance via Vast API.
   */
  async stopGpu(instanceId) {
    const gpu = this.gpus.get(String(instanceId));
    if (!gpu) throw new Error(`GPU ${instanceId} not registered`);

    const vastId = gpu.vastId || instanceId;
    try {
      await this._vastApi("PUT", `/instances/${vastId}/`, { state: "stopped" });
      gpu.status = "stopped";
      console.log(`[GPU Fleet] ${instanceId} stopped`);
    } catch (err) {
      console.log(`[GPU Fleet] Stop failed for ${instanceId}:`, err.message);
    }
    return gpu;
  }

  /**
   * Auto-scale: start burst GPUs when needed, stop idle ones.
   */
  async autoScale(queueLength) {
    // Scale up: start a stopped GPU if queue is long
    if (queueLength >= SCALE_UP_QUEUE) {
      const stopped = Array.from(this.gpus.values()).find(g => g.status === "stopped" && g.autoStop);
      if (stopped) {
        console.log(`[GPU Fleet] Queue at ${queueLength}, starting burst GPU ${stopped.instanceId}`);
        try { await this.startGpu(stopped.instanceId); } catch (e) { console.log("[GPU Fleet] Scale-up failed:", e.message); }
      }
    }

    // Scale down: stop idle burst GPUs
    const now = Date.now();
    for (const gpu of this.gpus.values()) {
      if (gpu.autoStop && gpu.status === "healthy" && gpu.lastUsed > 0 && (now - gpu.lastUsed) > IDLE_STOP_MS) {
        console.log(`[GPU Fleet] ${gpu.instanceId} idle for ${Math.round((now - gpu.lastUsed) / 1000)}s, stopping`);
        try { await this.stopGpu(gpu.instanceId); } catch {}
      }
    }
  }

  /**
   * Get fleet status for dashboard/API.
   */
  getStatus() {
    const gpus = Array.from(this.gpus.values()).map(g => ({
      instanceId: g.instanceId,
      vastId: g.vastId,
      gpuName: g.gpuName,
      host: g.host,
      port: g.port,
      model: g.model,
      role: g.role,
      status: g.status,
      autoStop: g.autoStop,
      lastUsed: g.lastUsed ? new Date(g.lastUsed).toISOString() : null,
      lastHealth: g.lastHealth ? new Date(g.lastHealth).toISOString() : null,
      coldStartMs: g.coldStartMs,
    }));
    return {
      total: gpus.length,
      healthy: gpus.filter(g => g.status === "healthy").length,
      stopped: gpus.filter(g => g.status === "stopped").length,
      starting: gpus.filter(g => g.status === "starting").length,
      gpus,
    };
  }

  // ── Private ──

  async _healthCheck() {
    for (const gpu of this.gpus.values()) {
      if (gpu.status === "stopped" || gpu.status === "starting") continue;
      try {
        const res = await this._httpGet(gpu.host, gpu.port, "/v1/models", gpu.key);
        if (res && (res.includes("gemma") || res.includes("wolverine"))) {
          gpu.status = "healthy";
          gpu.lastHealth = Date.now();
        } else {
          gpu.status = "unhealthy";
        }
      } catch {
        gpu.status = "unhealthy";
      }
    }
  }

  _vastApi(method, path, body) {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : null;
      const req = https.request({
        hostname: "cloud.vast.ai",
        path: `/api/v0${path}`,
        method,
        timeout: 15000,
        headers: {
          "Authorization": `Bearer ${VAST_KEY}`,
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      }, (res) => {
        let data = "";
        res.on("data", c => { data += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Vast API timeout")); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  _httpGet(host, port, path, key) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: host, port, path, method: "GET", timeout: 5000,
        headers: key ? { "Authorization": `Bearer ${key}` } : {},
      }, (res) => {
        let data = "";
        res.on("data", c => { data += c; });
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.end();
    });
  }
}

module.exports = { GpuFleet };
