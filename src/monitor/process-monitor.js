const { execSync } = require("child_process");
const chalk = require("chalk");

/**
 * Process Monitor — heartbeat, memory leak detection, frozen state detection.
 *
 * Tracks the child process health:
 * - Memory usage (RSS, heap) with leak detection
 * - CPU usage percentage
 * - Heartbeat (is the process alive?)
 * - Frozen detection (process alive but not responding)
 *
 * Triggers restart when:
 * - Memory exceeds threshold (configurable, default 512MB)
 * - Memory growing consistently for N samples (leak detection)
 * - Process not responding to health checks (frozen)
 */

class ProcessMonitor {
  constructor(options = {}) {
    this.logger = options.logger;
    this.pid = null;

    // Thresholds
    this.maxMemoryMB = options.maxMemoryMB || parseInt(process.env.WOLVERINE_MAX_MEMORY_MB, 10) || 512;
    this.leakSamples = options.leakSamples || 10;   // consecutive growing samples = leak
    this.sampleIntervalMs = options.sampleIntervalMs || 10000; // sample every 10s
    // A leak is flagged only when growth is BOTH sustained (leakSamples) AND large
    // (>= leakMinGrowthMB). Without this magnitude gate, ordinary warmup heap growth
    // (+~30MB over 10 samples) tripped a restart every ~2 min — a false-positive loop.
    this.leakMinGrowthMB = options.leakMinGrowthMB || parseInt(process.env.WOLVERINE_LEAK_MIN_GROWTH_MB, 10) || 200;

    // State
    this._samples = [];        // { timestamp, rss, heap, cpu }
    this._timer = null;
    this._running = false;
    this._onRestart = null;
    this._consecutiveGrowth = 0;

    // Analytics aggregates
    this._peakMemory = 0;
    this._avgMemory = 0;
    this._sampleCount = 0;
    this._cpuSamples = [];
    this._lastCpuUsage = null;
    this._lastCpuTime = null;
  }

  /**
   * Start monitoring a process.
   * @param {number} pid — the child process PID
   * @param {function} onRestart — callback when restart is needed
   */
  start(pid, onRestart) {
    this.pid = pid;
    this._onRestart = onRestart;
    this._running = true;
    this._consecutiveGrowth = 0;
    this._samples = [];
    this._lastCpuUsage = null;
    this._lastCpuTime = null;

    this._timer = setInterval(() => this._sample(), this.sampleIntervalMs);
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Reset for new process (after restart).
   */
  reset(newPid) {
    this.pid = newPid;
    this._consecutiveGrowth = 0;
    this._samples = [];
    this._lastCpuUsage = null;
    this._lastCpuTime = null;
  }

  /**
   * Get current analytics snapshot.
   */
  getMetrics() {
    const latest = this._samples.length > 0 ? this._samples[this._samples.length - 1] : null;
    const avgCpu = this._cpuSamples.length > 0
      ? Math.round(this._cpuSamples.reduce((a, b) => a + b, 0) / this._cpuSamples.length)
      : 0;

    return {
      pid: this.pid,
      alive: this._isAlive(),
      current: latest ? {
        rss: latest.rss,
        heap: latest.heap,
        cpu: latest.cpu,
      } : null,
      peak: {
        memory: this._peakMemory,
      },
      average: {
        memory: this._sampleCount > 0 ? Math.round(this._avgMemory / this._sampleCount) : 0,
        cpu: avgCpu,
      },
      leakDetection: {
        consecutiveGrowth: this._consecutiveGrowth,
        threshold: this.leakSamples,
        warning: this._consecutiveGrowth >= Math.floor(this.leakSamples * 0.7),
      },
      samples: this._samples.slice(-30).map(s => ({
        t: s.timestamp,
        rss: s.rss,
        heap: s.heap,
        cpu: s.cpu,
      })),
    };
  }

  // -- Private --

  _sample() {
    if (!this._running || !this.pid) return;

    if (!this._isAlive()) {
      // Process died — runner will handle this via exit event
      return;
    }

    try {
      // Get memory from process
      const memInfo = this._getMemory();
      const cpuPercent = this._getCpu();

      const sample = {
        timestamp: Date.now(),
        rss: memInfo.rss,
        heap: memInfo.heap,
        cpu: cpuPercent,
      };

      this._samples.push(sample);
      if (this._samples.length > 100) this._samples.shift();

      // Track peaks/averages
      if (memInfo.rss > this._peakMemory) this._peakMemory = memInfo.rss;
      this._avgMemory += memInfo.rss;
      this._sampleCount++;

      this._cpuSamples.push(cpuPercent);
      if (this._cpuSamples.length > 60) this._cpuSamples.shift();

      // Check memory threshold
      if (memInfo.rss > this.maxMemoryMB) {
        console.log(chalk.red(`  🚨 Memory limit exceeded: ${memInfo.rss}MB > ${this.maxMemoryMB}MB`));
        if (this.logger) {
          this.logger.error("process.memory_exceeded", `Memory ${memInfo.rss}MB exceeds ${this.maxMemoryMB}MB`, sample);
        }
        if (this._onRestart) this._onRestart("memory_exceeded");
        return;
      }

      // Leak detection: memory growing for N consecutive samples
      if (this._samples.length >= 2) {
        const prev = this._samples[this._samples.length - 2];
        if (sample.rss > prev.rss) {
          this._consecutiveGrowth++;
        } else {
          this._consecutiveGrowth = 0;
        }

        const _leakGrowth = this._consecutiveGrowth >= this.leakSamples ? (sample.rss - this._samples[this._samples.length - this.leakSamples].rss) : 0;
        if (this._consecutiveGrowth >= this.leakSamples && _leakGrowth >= this.leakMinGrowthMB) {
          const growth = sample.rss - this._samples[this._samples.length - this.leakSamples].rss;
          console.log(chalk.yellow(`  ⚠️  Memory leak detected: +${growth}MB over ${this.leakSamples} samples`));
          if (this.logger) {
            this.logger.warn("process.memory_leak", `Memory leak: +${growth}MB over ${this.leakSamples} samples`, { growth, rss: sample.rss });
          }
          if (this._onRestart) this._onRestart("memory_leak");
          this._consecutiveGrowth = 0;
          return;
        }
      }
    } catch {}
  }

  _getMemory() {
    try {
      // On Windows, use tasklist; on Unix, use /proc
      if (process.platform === "win32") {
        const output = execSync(`tasklist /FI "PID eq ${this.pid}" /FO CSV /NH`, { encoding: "utf-8", timeout: 3000 });
        const match = output.match(/"(\d[\d,]+)\s*K"/);
        if (match) {
          const kb = parseInt(match[1].replace(/,/g, ""), 10);
          return { rss: Math.round(kb / 1024), heap: 0 };
        }
      } else {
        const output = execSync(`ps -o rss= -p ${this.pid}`, { encoding: "utf-8", timeout: 3000 });
        const kb = parseInt(output.trim(), 10);
        return { rss: Math.round(kb / 1024), heap: 0 };
      }
    } catch {}
    return { rss: 0, heap: 0 };
  }

  _getCpu() {
    try {
      if (process.platform === "win32") {
        const output = execSync(
          `wmic path Win32_PerfFormattedData_PerfProc_Process where "IDProcess=${this.pid}" get PercentProcessorTime /VALUE`,
          { encoding: "utf-8", timeout: 3000 }
        );
        const match = output.match(/PercentProcessorTime=(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      } else {
        const output = execSync(`ps -o %cpu= -p ${this.pid}`, { encoding: "utf-8", timeout: 3000 });
        return Math.round(parseFloat(output.trim()));
      }
    } catch {}
    return 0;
  }

  _isAlive() {
    try {
      process.kill(this.pid, 0); // signal 0 = check if alive
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { ProcessMonitor };
