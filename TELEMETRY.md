# Telemetry Should Work Out of the Box

## Problem

Right now every wolverine user has to manually add 4 env variables to connect to the platform:

```env
WOLVERINE_PLATFORM_URL=https://api.wolverinenode.xyz
WOLVERINE_PLATFORM_KEY=wlvk_...
WOLVERINE_INSTANCE_NAME=my-server
WOLVERINE_HEARTBEAT_INTERVAL_MS=60000
```

This is wrong. Wolverine telemetry should work **zero-config** for every server.

## What Needs to Change

### 1. Hardcode the platform URL

The platform URL is always `https://api.wolverinenode.xyz` — every wolverine instance talks to the same backend. This shouldn't be configurable, it should be a constant.

```js
// Before (requires env setup)
const PLATFORM_URL = process.env.WOLVERINE_PLATFORM_URL;

// After (works out of the box)
const PLATFORM_URL = process.env.WOLVERINE_PLATFORM_URL || "https://api.wolverinenode.xyz";
```

### 2. Auto-generate the platform key on first run

Instead of requiring users to get a key, wolverine should:
1. On first startup, call `POST /api/v1/register` with the instance ID
2. Platform returns a key and stores the new instance
3. Wolverine saves the key to `.wolverine/platform-key`
4. On subsequent startups, reads from the saved file

```
First run:
  → No key found in .wolverine/platform-key
  → POST https://api.wolverinenode.xyz/api/v1/register
    Body: { instanceId: "wlv_abc123", name: "auto-generated" }
  → Response: { key: "wlvk_auto_xxx", instanceId: "wlv_abc123" }
  → Save key to .wolverine/platform-key
  → Start heartbeats

Subsequent runs:
  → Read key from .wolverine/platform-key
  → Start heartbeats immediately
```

### 3. Auto-name from the server directory

Instead of requiring `WOLVERINE_INSTANCE_NAME`, derive it:

```js
const name = process.env.WOLVERINE_INSTANCE_NAME 
  || path.basename(process.cwd())  // folder name: "my-api"
  || "wolverine-server";
```

### 4. Platform backend needs a registration endpoint

```
POST /api/v1/register
Body: { instanceId: "wlv_abc123", name: "my-api" }
Response: { key: "wlvk_auto_xxx", instanceId: "wlv_abc123" }
```

This endpoint:
- Creates a new server record
- Generates and returns an API key
- Is rate-limited (1 registration per IP per minute)
- No auth required (it IS the auth setup)

### 5. Opt-out instead of opt-in

Telemetry should be ON by default. Users who don't want it set:

```env
WOLVERINE_TELEMETRY=false
```

## Changes Required

### Wolverine side (this repo)

1. **`src/platform/heartbeat.js`** — default URL to `https://api.wolverinenode.xyz`
2. **`src/platform/register.js`** (new) — auto-registration on first run
3. **`src/platform/telemetry.js`** — auto-name from cwd
4. **`.env.example`** — remove platform vars from required, add `WOLVERINE_TELEMETRY=true` as default

### Platform backend side

1. **`POST /api/v1/register`** — new endpoint, creates server + returns key
2. **Rate limiting** — 1 reg/IP/minute
3. **Key storage** — associate keys with server records

## Result

After this fix, a user does:

```bash
npm install wolverine-nodejs
npm start
```

And their server automatically:
- Registers with the platform
- Gets a key
- Starts sending heartbeats every 60s
- Appears on the fleet dashboard

Zero env variables. Zero setup. Just works.
