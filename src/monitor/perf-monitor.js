const http = require("http");
const chalk = require("chalk");
const { getModel } = require("../core/models");
const { aiCall } = require("../core/ai-client");

/**
 * Performance Monitor — detects non-error issues that degrade server quality.
 *
 * Monitors:
 * - Endpoint response times (detects slowdowns)
 * - Request rate per endpoint (detects spam/DDoS patterns)
 * - Error rate per endpoint (detects failing routes)
 * - Memory/CPU via process metrics (if accessible)
 *
 * When it detects a pain point, it uses the AI (REASONING_MODEL) to analyze
 * the relevant code and suggest or apply optimizations.
 *
 * Architecture: Injects a lightweight proxy between wolverine and the server
 * that intercepts HTTP requests to gather metrics without modifying user code.
 */

class PerfMonitor {
  constructor(options = {}) {
    this.logger = options.logger;
    this.sandbox = options.sandbox;
    this.cwd = options.cwd || process.cwd();
    this.port = options.port || parseInt(process.env.PORT, 10) || 3000;

    // Config
    this.sampleIntervalMs = options.sampleIntervalMs || 30000; // check every 30s
    this.slowThresholdMs = options.slowThresholdMs || 2000;    // >2s = slow
    this.spikeMultiplier = options.spikeMultiplier || 5;       // 5x avg = spike
    this.spamThreshold = options.spamThreshold || 100;          // >100 req/min to one endpoint = spam

    // Metrics store
    this._endpoints = {};   // path -> { totalRequests, totalTime, errors, timestamps[] }
    this._timer = null;
    this._running = false;
    this._analysisInProgress = false;
  }

  /**
   * Start monitoring by polling the server's response times.
   */
  start() {
    this._running = true;

    // Periodic analysis of accumulated metrics
    this._timer = setInterval(() => this._analyze(), this.sampleIntervalMs);

    if (this.logger) {
      this.logger.info("perf.start", "Performance monitor started", {
        sampleInterval: this.sampleIntervalMs,
        slowThreshold: this.slowThresholdMs,
      });
    }
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Record a request observation. Call this from a proxy or middleware.
   */
  recordRequest(endpoint, responseTimeMs, statusCode) {
    if (!this._endpoints[endpoint]) {
      this._endpoints[endpoint] = {
        totalRequests: 0,
        totalTime: 0,
        errors: 0,
        maxTime: 0,
        timestamps: [],
        recentTimes: [],
      };
    }

    const ep = this._endpoints[endpoint];
    ep.totalRequests++;
    ep.totalTime += responseTimeMs;
    ep.maxTime = Math.max(ep.maxTime, responseTimeMs);
    ep.timestamps.push(Date.now());
    ep.recentTimes.push(responseTimeMs);

    // Keep only last 5 minutes of timestamps
    const fiveMinAgo = Date.now() - 300000;
    ep.timestamps = ep.timestamps.filter(t => t > fiveMinAgo);
    ep.recentTimes = ep.recentTimes.slice(-200);

    if (statusCode >= 400) {
      ep.errors++;
    }
  }

  /**
   * Get current metrics snapshot for all endpoints.
   */
  getMetrics() {
    const metrics = {};
    for (const [endpoint, ep] of Object.entries(this._endpoints)) {
      const avgTime = ep.totalRequests > 0 ? Math.round(ep.totalTime / ep.totalRequests) : 0;
      const fiveMinAgo = Date.now() - 300000;
      const recentCount = ep.timestamps.filter(t => t > fiveMinAgo).length;
      const requestsPerMin = Math.round((recentCount / 5) * 10) / 10;

      metrics[endpoint] = {
        totalRequests: ep.totalRequests,
        avgResponseMs: avgTime,
        maxResponseMs: ep.maxTime,
        requestsPerMin,
        errorRate: ep.totalRequests > 0 ? Math.round((ep.errors / ep.totalRequests) * 100) : 0,
        errors: ep.errors,
      };
    }
    return metrics;
  }

  /**
   * Internal — analyze metrics and flag issues.
   */
  async _analyze() {
    if (!this._running || this._analysisInProgress) return;
    if (Object.keys(this._endpoints).length === 0) return;

    const issues = [];

    for (const [endpoint, ep] of Object.entries(this._endpoints)) {
      const avgTime = ep.totalRequests > 0 ? ep.totalTime / ep.totalRequests : 0;
      const fiveMinAgo = Date.now() - 300000;
      const recentCount = ep.timestamps.filter(t => t > fiveMinAgo).length;
      const requestsPerMin = recentCount / 5;

      // Slow endpoint detection
      if (avgTime > this.slowThresholdMs) {
        issues.push({
          type: "slow_endpoint",
          endpoint,
          avgTime: Math.round(avgTime),
          maxTime: ep.maxTime,
          message: `${endpoint} averaging ${Math.round(avgTime)}ms (threshold: ${this.slowThresholdMs}ms)`,
        });
      }

      // Response time spike detection
      if (ep.recentTimes.length >= 10) {
        const recent = ep.recentTimes.slice(-10);
        const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        if (recentAvg > avgTime * this.spikeMultiplier && avgTime > 100) {
          issues.push({
            type: "spike",
            endpoint,
            recentAvg: Math.round(recentAvg),
            overallAvg: Math.round(avgTime),
            message: `${endpoint} response time spiked: ${Math.round(recentAvg)}ms (normal: ${Math.round(avgTime)}ms)`,
          });
        }
      }

      // Spam/DDoS detection
      if (requestsPerMin > this.spamThreshold) {
        issues.push({
          type: "spam",
          endpoint,
          requestsPerMin: Math.round(requestsPerMin),
          message: `${endpoint} receiving ${Math.round(requestsPerMin)} req/min (threshold: ${this.spamThreshold})`,
        });
      }

      // High error rate detection
      const errorRate = ep.totalRequests > 10 ? ep.errors / ep.totalRequests : 0;
      if (errorRate > 0.2) {
        issues.push({
          type: "error_rate",
          endpoint,
          errorRate: Math.round(errorRate * 100),
          message: `${endpoint} has ${Math.round(errorRate * 100)}% error rate (${ep.errors}/${ep.totalRequests})`,
        });
      }
    }

    if (issues.length === 0) return;

    // Log all issues
    for (const issue of issues) {
      const eventType = {
        slow_endpoint: "perf.slow_endpoint",
        spike: "perf.spike_detected",
        spam: "perf.attack_detected",
        error_rate: "perf.slow_endpoint",
      }[issue.type];

      const severity = issue.type === "spam" ? "warn" : "info";

      if (this.logger) {
        this.logger[severity](eventType, issue.message, issue);
      }
      console.log(chalk.yellow(`  ⚡ Perf: ${issue.message}`));
    }

    // If there are serious issues, request AI optimization analysis
    const serious = issues.filter(i => i.type === "slow_endpoint" || i.type === "spam");
    if (serious.length > 0 && !this._analysisInProgress) {
      await this._requestOptimization(serious);
    }
  }

  /**
   * Ask AI to analyze performance issues and suggest optimizations.
   * Uses REASONING_MODEL since this is deep analysis.
   */
  async _requestOptimization(issues) {
    this._analysisInProgress = true;

    try {
      const model = getModel("chat");
      const issuesSummary = issues.map(i => `- ${i.message}`).join("\n");

      const result = await aiCall({
        model,
        systemPrompt: "You are a Node.js performance optimization expert.",
        userPrompt: `The following performance issues were detected on a live server:

${issuesSummary}

Current endpoint metrics:
${JSON.stringify(this.getMetrics(), null, 2)}

Provide a brief analysis and actionable suggestions. Focus on:
1. Root cause identification
2. Quick wins (caching, rate limiting, query optimization)
3. Whether this looks like an attack (spam patterns)

Keep your response under 300 words. Be specific and actionable.`,
        maxTokens: 512,
        category: "audit",
      });

      const analysis = result.content;
      console.log(chalk.cyan(`\n  📊 Performance Analysis:\n${analysis.split("\n").map(l => "    " + l).join("\n")}\n`));

      if (this.logger) {
        this.logger.info("perf.optimization", "AI performance analysis completed", {
          issues: issues.length,
          analysis: analysis.slice(0, 500),
        });
      }
    } catch (err) {
      console.log(chalk.yellow(`  Performance analysis failed: ${err.message}`));
    } finally {
      this._analysisInProgress = false;
    }
  }
}

/**
 * Create a lightweight HTTP proxy that wraps the server to capture metrics.
 * Sits between wolverine and the actual server process.
 */
function createMetricsProxy(targetPort, proxyPort, perfMonitor) {
  const proxy = http.createServer((req, res) => {
    const startTime = Date.now();

    const options = {
      hostname: "127.0.0.1",
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      const responseTime = Date.now() - startTime;
      perfMonitor.recordRequest(req.url, responseTime, proxyRes.statusCode);

      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      const responseTime = Date.now() - startTime;
      perfMonitor.recordRequest(req.url, responseTime, 502);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad Gateway", details: err.message }));
    });

    req.pipe(proxyReq);
  });

  proxy.listen(proxyPort, () => {
    console.log(chalk.gray(`  📊 Metrics proxy on :${proxyPort} → :${targetPort}`));
  });

  return proxy;
}

module.exports = { PerfMonitor, createMetricsProxy };
