const { spawn } = require("child_process");
const http = require("http");
const https = require("https");
const chalk = require("chalk");

/**
 * MCP Client — connects to Model Context Protocol servers.
 *
 * Supports two transport types (claw-code pattern):
 * 1. stdio — spawns a subprocess, communicates via JSON-RPC over stdin/stdout
 * 2. http  — connects to an HTTP endpoint
 *
 * JSON-RPC 2.0 protocol:
 *   → { jsonrpc: "2.0", id: 1, method: "initialize", params: {...} }
 *   ← { jsonrpc: "2.0", id: 1, result: {...} }
 */

class McpStdioClient {
  constructor(name, config) {
    this.name = name;
    this.command = config.command;
    this.args = config.args || [];
    this.env = config.env || {};
    this.cwd = config.cwd || process.cwd();

    this._process = null;
    this._requestId = 0;
    this._pending = new Map(); // id → { resolve, reject, timer }
    this._buffer = "";
    this._tools = [];
    this._connected = false;
    this._timeout = config.timeout || 30000;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this._process = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this._process.stdout.on("data", (data) => this._onData(data));
      this._process.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(chalk.gray(`  [mcp:${this.name}] ${msg}`));
      });

      this._process.on("error", (err) => {
        this._connected = false;
        reject(new Error(`MCP ${this.name}: failed to start — ${err.message}`));
      });

      this._process.on("exit", (code) => {
        this._connected = false;
        // Reject any pending requests
        for (const [id, pending] of this._pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`MCP ${this.name}: process exited with code ${code}`));
        }
        this._pending.clear();
      });

      // Initialize the server
      this._send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "wolverine", version: "1.0.0" },
      }).then((result) => {
        this._connected = true;
        // Send initialized notification
        this._notify("notifications/initialized", {});
        resolve(result);
      }).catch(reject);
    });
  }

  async listTools() {
    if (!this._connected) throw new Error(`MCP ${this.name}: not connected`);
    const result = await this._send("tools/list", {});
    this._tools = result.tools || [];
    return this._tools;
  }

  async callTool(toolName, args) {
    if (!this._connected) throw new Error(`MCP ${this.name}: not connected`);
    const result = await this._send("tools/call", { name: toolName, arguments: args });
    return result;
  }

  disconnect() {
    if (this._process) {
      this._process.kill("SIGTERM");
      this._process = null;
    }
    this._connected = false;
  }

  get isConnected() { return this._connected; }

  // -- JSON-RPC --

  _send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP ${this.name}: timeout on ${method}`));
      }, this._timeout);

      this._pending.set(id, { resolve, reject, timer });

      try {
        this._process.stdin.write(msg);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error(`MCP ${this.name}: write failed — ${err.message}`));
      }
    });
  }

  _notify(method, params) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    try { this._process.stdin.write(msg); } catch {}
  }

  _onData(data) {
    this._buffer += data.toString();

    // Parse complete JSON-RPC messages (newline-delimited)
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this._pending.has(msg.id)) {
          const { resolve, reject, timer } = this._pending.get(msg.id);
          clearTimeout(timer);
          this._pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(`MCP ${this.name}: ${msg.error.message || JSON.stringify(msg.error)}`));
          } else {
            resolve(msg.result);
          }
        }
      } catch {}
    }
  }
}

/**
 * MCP HTTP Client — for servers that expose an HTTP endpoint.
 */
class McpHttpClient {
  constructor(name, config) {
    this.name = name;
    this.url = config.url;
    this._tools = [];
    this._connected = false;
    this._timeout = config.timeout || 30000;
  }

  async connect() {
    const result = await this._post("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "wolverine", version: "1.0.0" },
    });
    this._connected = true;
    return result;
  }

  async listTools() {
    const result = await this._post("tools/list", {});
    this._tools = result.tools || [];
    return this._tools;
  }

  async callTool(toolName, args) {
    return this._post("tools/call", { name: toolName, arguments: args });
  }

  disconnect() { this._connected = false; }
  get isConnected() { return this._connected; }

  _post(method, params) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
      const url = new URL(this.url);
      const client = url.protocol === "https:" ? https : http;

      const req = client.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: this._timeout,
      }, (res) => {
        let data = "";
        res.on("data", (d) => { data += d; });
        res.on("end", () => {
          try {
            const msg = JSON.parse(data);
            if (msg.error) reject(new Error(`MCP ${this.name}: ${msg.error.message}`));
            else resolve(msg.result);
          } catch { reject(new Error(`MCP ${this.name}: invalid response`)); }
        });
      });

      req.on("error", (e) => reject(new Error(`MCP ${this.name}: ${e.message}`)));
      req.on("timeout", () => { req.destroy(); reject(new Error(`MCP ${this.name}: timeout`)); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = { McpStdioClient, McpHttpClient };
