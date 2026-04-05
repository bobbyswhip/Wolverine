// Minimal test - no wolverine, no old processes, just CDP auth
import { webcrypto } from 'crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { getAuthHeaders } from '@coinbase/cdp-sdk/auth';

const keyId = '2714e755-2459-4e2f-938e-ec5dbe84abfa';
const secret = 'Qwx77zFCvOBAHomneUQJuHBz2hOftfGABxRxtQPVJlII2Er1B7DumIUi+dUiSSfFOKx02+DPUpn3+1/gXxNVfA==';

// Test 1: GET /supported
const h1 = await getAuthHeaders({ apiKeyId: keyId, apiKeySecret: secret, requestMethod: 'GET', requestHost: 'https://api.cdp.coinbase.com', requestPath: '/platform/v2/x402/supported' });
const r1 = await fetch('https://api.cdp.coinbase.com/platform/v2/x402/supported', { headers: h1 });
console.log('/supported:', r1.status, await r1.text());

// Test 2: POST /verify with empty body
const h2 = await getAuthHeaders({ apiKeyId: keyId, apiKeySecret: secret, requestMethod: 'POST', requestHost: 'https://api.cdp.coinbase.com', requestPath: '/platform/v2/x402/verify' });
const r2 = await fetch('https://api.cdp.coinbase.com/platform/v2/x402/verify', { method: 'POST', headers: { ...h2, 'Content-Type': 'application/json' }, body: '{}' });
console.log('/verify:', r2.status, await r2.text());
