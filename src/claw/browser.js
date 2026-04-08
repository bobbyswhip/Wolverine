/**
 * Wolverine Claw Browser — lightweight headless browser for the agent.
 *
 * Single browser, single tab. All page content scanned through wolverine's
 * injection detection and secret redaction before the agent sees it.
 *
 * Uses puppeteer (optional dep). If not installed, tools return an error
 * message telling the user to npm install puppeteer.
 *
 * Security:
 * - Page text scanned for injection patterns before agent receives it
 * - URLs validated (no file://, no internal IPs)
 * - Screenshots returned as base64 (model-native format)
 * - JavaScript execution sandboxed to page context
 * - Auto-closes on process exit
 */

const path = require("path");

let _browser = null;
let _page = null;
let _puppeteer = null;
let _wolverineApi = null;

// ── URL validation ──────────────────────────────────────────────

const BLOCKED_URL_PATTERNS = [
  /^file:\/\//i,
  /^data:/i,
  /^javascript:/i,
  /^chrome/i,
  /^about:/i,
  // Block internal/private IPs
  /^https?:\/\/127\./,
  /^https?:\/\/0\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/169\.254\./,
  /^https?:\/\/localhost/i,
  // Block cloud metadata endpoints
  /^https?:\/\/metadata\./i,
  /169\.254\.169\.254/,
];

function _validateUrl(url) {
  if (!url || typeof url !== "string") return "Invalid URL";
  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) return `Blocked URL: ${url.slice(0, 50)} (security policy)`;
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "URL must start with http:// or https://";
  }
  return null;
}

// ── Browser lifecycle ───────────────────────────────────────────

async function _ensureBrowser() {
  if (!_puppeteer) {
    try {
      _puppeteer = require("puppeteer");
    } catch {
      throw new Error("puppeteer not installed. Run: npm install puppeteer");
    }
  }

  if (!_browser || !_browser.connected) {
    const launchArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ];
    // --single-process and --no-zygote cause crashes on Windows
    if (process.platform !== "win32") {
      launchArgs.push("--single-process", "--no-zygote");
    }

    _browser = await _puppeteer.launch({
      headless: "new",
      args: launchArgs,
      defaultViewport: { width: 1280, height: 800 },
    });

    // Auto-close on process exit
    const cleanup = () => { try { _browser?.close(); } catch {} };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }

  if (!_page || _page.isClosed()) {
    const pages = await _browser.pages();
    _page = pages[0] || await _browser.newPage();

    // Block popups — single tab only
    _page.on("popup", async (popup) => {
      try { await popup.close(); } catch {}
    });
  }

  return _page;
}

async function _closeBrowser() {
  try {
    if (_page && !_page.isClosed()) await _page.close();
  } catch {}
  try {
    if (_browser && _browser.connected) await _browser.close();
  } catch {}
  _page = null;
  _browser = null;
}

// ── Security scanning ──────────────────────────────────────────

function _getApi() {
  if (_wolverineApi) return _wolverineApi;
  try {
    if (global.wolverine) { _wolverineApi = global.wolverine; return _wolverineApi; }
    const { init } = require("./wolverine-api");
    _wolverineApi = init(process.cwd());
    return _wolverineApi;
  } catch {
    return null;
  }
}

function _scanContent(text) {
  const api = _getApi();
  if (!api || !text) return { safe: true, text };

  const scan = api.scanText(text);
  if (!scan.safe) {
    return {
      safe: false,
      text: scan.redacted,
      warnings: [
        scan.injection?.safe === false ? `INJECTION DETECTED: ${(scan.injection.flags || []).map(f => f.label).join(", ")}` : null,
        scan.secrets ? "SECRETS DETECTED AND REDACTED" : null,
      ].filter(Boolean),
    };
  }
  return { safe: true, text };
}

// ── Tool definitions ────────────────────────────────────────────

function buildBrowserTools() {
  return [
    {
      type: "function",
      function: {
        name: "browser_navigate",
        description: "Navigate to a URL in the browser. Returns page title and a text summary. Single tab only.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to navigate to (http/https only)" },
          },
          required: ["url"],
        },
      },
      execute: async ({ url }) => {
        const urlErr = _validateUrl(url);
        if (urlErr) return `[ERROR] ${urlErr}`;

        try {
          const page = await _ensureBrowser();
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
          const title = await page.title();
          return `Navigated to: ${url}\nTitle: ${title}`;
        } catch (e) {
          return `[ERROR] Navigation failed: ${e.message}`;
        }
      },
    },
    {
      type: "function",
      function: {
        name: "browser_read_page",
        description: "Read the current page's visible text content. Content is security-scanned for injection and secrets before you see it.",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector to read from (default: body)" },
          },
        },
      },
      execute: async ({ selector }) => {
        try {
          const page = await _ensureBrowser();
          const sel = selector || "body";
          const text = await page.$eval(sel, el => el.innerText).catch(() => null);

          if (!text) return `[ERROR] No text found for selector: ${sel}`;

          // Security scan page content
          const scan = _scanContent(text);
          let result = scan.text;

          // Cap length
          if (result.length > 6000) result = result.slice(0, 6000) + "\n... (truncated)";

          if (!scan.safe) {
            const warnings = scan.warnings.join("; ");
            return `[SECURITY WARNING: ${warnings}]\n\n${result}`;
          }

          return result;
        } catch (e) {
          return `[ERROR] Read failed: ${e.message}`;
        }
      },
    },
    {
      type: "function",
      function: {
        name: "browser_screenshot",
        description: "Take a screenshot of the current page. Returns base64-encoded image.",
        parameters: {
          type: "object",
          properties: {
            fullPage: { type: "boolean", description: "Capture full page or just viewport (default: false)" },
          },
        },
      },
      execute: async ({ fullPage }) => {
        try {
          const page = await _ensureBrowser();
          const buffer = await page.screenshot({
            encoding: "base64",
            type: "png",
            fullPage: fullPage || false,
          });
          return `[screenshot:base64:png:${buffer.length}chars]\n${buffer}`;
        } catch (e) {
          return `[ERROR] Screenshot failed: ${e.message}`;
        }
      },
    },
    {
      type: "function",
      function: {
        name: "browser_click",
        description: "Click an element on the page by CSS selector or coordinates.",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector to click" },
            x: { type: "number", description: "X coordinate (alternative to selector)" },
            y: { type: "number", description: "Y coordinate (alternative to selector)" },
          },
        },
      },
      execute: async ({ selector, x, y }) => {
        try {
          const page = await _ensureBrowser();
          if (selector) {
            await page.click(selector, { timeout: 5000 });
            return `Clicked: ${selector}`;
          } else if (x !== undefined && y !== undefined) {
            await page.mouse.click(x, y);
            return `Clicked at (${x}, ${y})`;
          }
          return "[ERROR] Provide selector or x,y coordinates";
        } catch (e) {
          return `[ERROR] Click failed: ${e.message}`;
        }
      },
    },
    {
      type: "function",
      function: {
        name: "browser_type",
        description: "Type text into a focused element or a specific selector.",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector to type into (optional — types into focused element if omitted)" },
            text: { type: "string", description: "Text to type" },
            clear: { type: "boolean", description: "Clear field before typing (default: false)" },
          },
          required: ["text"],
        },
      },
      execute: async ({ selector, text, clear }) => {
        // Scan outgoing text for secrets
        const api = _getApi();
        if (api) {
          const scan = api.scanText(text);
          if (scan.secrets) {
            return "[ERROR] Blocked — text contains secrets (API keys, tokens). Cannot type sensitive data into browser.";
          }
        }

        try {
          const page = await _ensureBrowser();
          if (selector) {
            if (clear) {
              await page.click(selector, { clickCount: 3 });
              await page.keyboard.press("Backspace");
            }
            await page.type(selector, text, { delay: 20 });
          } else {
            await page.keyboard.type(text, { delay: 20 });
          }
          return `Typed ${text.length} chars${selector ? ` into ${selector}` : ""}`;
        } catch (e) {
          return `[ERROR] Type failed: ${e.message}`;
        }
      },
    },
    {
      type: "function",
      function: {
        name: "browser_scroll",
        description: "Scroll the page up or down.",
        parameters: {
          type: "object",
          properties: {
            direction: { type: "string", description: "Scroll direction: up or down (default: down)" },
            amount: { type: "number", description: "Pixels to scroll (default: 500)" },
          },
        },
      },
      execute: async ({ direction, amount }) => {
        try {
          const page = await _ensureBrowser();
          const px = amount || 500;
          const dir = direction === "up" ? -px : px;
          await page.evaluate((d) => window.scrollBy(0, d), dir);
          return `Scrolled ${direction || "down"} ${px}px`;
        } catch (e) {
          return `[ERROR] Scroll failed: ${e.message}`;
        }
      },
    },
    {
      type: "function",
      function: {
        name: "browser_eval",
        description: "Execute JavaScript in the page context. Use for reading DOM state or interacting with page APIs. Script runs in the page, NOT in Node.js.",
        parameters: {
          type: "object",
          properties: {
            script: { type: "string", description: "JavaScript to execute in the page" },
          },
          required: ["script"],
        },
      },
      execute: async ({ script }) => {
        // Block dangerous patterns
        const blocked = ["fetch(", "XMLHttpRequest", "navigator.sendBeacon", "WebSocket(", "importScripts"];
        for (const b of blocked) {
          if (script.includes(b)) return `[ERROR] Blocked — script contains network call: ${b}`;
        }

        try {
          const page = await _ensureBrowser();
          const result = await page.evaluate(script).catch(e => `Error: ${e.message}`);
          const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);

          // Security scan output
          const scan = _scanContent(text);
          if (!scan.safe) {
            return `[SECURITY WARNING: ${scan.warnings.join("; ")}]\n\n${scan.text}`;
          }

          if (text.length > 4000) return text.slice(0, 4000) + "\n... (truncated)";
          return text || "(no return value)";
        } catch (e) {
          return `[ERROR] Eval failed: ${e.message}`;
        }
      },
    },
    {
      type: "function",
      function: {
        name: "browser_close",
        description: "Close the browser. Call when done with browser tasks to free resources.",
        parameters: { type: "object", properties: {} },
      },
      execute: async () => {
        await _closeBrowser();
        return "Browser closed.";
      },
    },
  ];
}

/**
 * Get tool definitions (without execute) for AI registration.
 */
function getToolDefinitions() {
  return buildBrowserTools().map(t => ({ type: t.type, function: t.function }));
}

/**
 * Get tool executor map { name: executeFn }.
 */
function getToolExecutors() {
  const tools = buildBrowserTools();
  const map = {};
  for (const t of tools) map[t.function.name] = t.execute;
  return map;
}

module.exports = { buildBrowserTools, getToolDefinitions, getToolExecutors, _validateUrl, _closeBrowser };
