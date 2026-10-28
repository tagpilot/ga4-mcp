// Device connect (api-contract.md v3: D1 start, D5 poll, D6 token) against a mock tc-api.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deviceFile, TokenCache } from '../src/auth/cache.js';
import { BrokerEndpoint, DeviceEndpoint } from '../src/auth/endpoints.js';
import { AuthPendingError, ReauthRequiredError, SignInFailedError, TokenManager } from '../src/auth/token-manager.js';
import { logout, status } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { startMockServer, tempDir, TEST_PRODUCT, type Recorded } from './helpers.js';

interface DeviceSession {
  deviceCode: string;
  userCode: string;
  challenge: string;
  client: Record<string, string>;
  status: 'pending' | 'complete' | 'denied';
  apiKey?: string;
  code?: string;
  googleError?: string;
}

/**
 * Mock tc-api. `verification_uri_complete` points at a fake /connect page on the mock: opening it
 * stands for "log in, approve the device, finish Google consent". `&deny=…` simulates a denial.
 */
async function startTcApi(opts: {
  poll?: (n: number, s: DeviceSession | undefined) => { status: number; body?: unknown } | undefined;
  refresh?: (r: Recorded) => { status: number; body?: unknown };
  expiresIn?: number;
} = {}) {
  const byDevice = new Map<string, DeviceSession>();
  const byUser = new Map<string, DeviceSession>();
  const revoked = new Set<string>();
  let polls = 0;
  let keySeq = 0;
  let tokenSeq = 0;
  const api = await startMockServer((req, url) => {
    if (req.path === '/v3/public/ga4/device') {
      const n = byDevice.size + 1;
      const s: DeviceSession = {
        deviceCode: crypto.randomBytes(32).toString('base64url'),
        userCode: `ABCD-${1000 + n}`,
        challenge: String(req.body.code_challenge),
        client: req.body.client as Record<string, string>,
        status: 'pending',
      };
      byDevice.set(s.deviceCode, s);
      byUser.set(s.userCode, s);
      return {
        status: 201,
        body: {
          device_code: s.deviceCode,
          user_code: s.userCode,
          verification_uri: `${api.url}/connect`,
          verification_uri_complete: `${api.url}/connect?code=${s.userCode}`,
          interval: 2,
          expires_in: opts.expiresIn ?? 600,
        },
      };
    }
    if (req.path === '/connect') {
      const s = byUser.get(url.searchParams.get('code') ?? '');
      if (!s) return { status: 404, body: 'unknown code' };
      const deny = url.searchParams.get('deny');
      if (deny) Object.assign(s, { status: 'denied', googleError: deny === 'access_denied' ? undefined : deny });
      else Object.assign(s, { status: 'complete', apiKey: `tpk_device_${++keySeq}`, code: `google-code-${s.userCode}` });
      return { status: 200, body: 'Connected.' };
    }
    if (req.path === '/v3/public/ga4/device/token') {
      polls++;
      const s = byDevice.get(String(req.body.device_code));
      const custom = opts.poll?.(polls, s);
      if (custom) return custom;
      if (!s) return { status: 400, body: { error: 'expired_token' } };
      if (s.status === 'pending') return { status: 400, body: { error: 'authorization_pending' } };
      byDevice.delete(s.deviceCode);
      if (s.status === 'denied') return { status: 400, body: { error: 'access_denied', ...(s.googleError ? { google_error: s.googleError } : {}) } };
      return { status: 200, body: { status: 'complete', api_key: s.apiKey, code: s.code } };
    }
    if (req.path === '/integrations/v1/ga4/oauth/token') {
      const key = String(req.headers.authorization).replace(/^Bearer /, '');
      if (!key.startsWith('tpk_device_') || revoked.has(key)) return { status: 401, body: { code: 401, message: 'Invalid API key' } };
      if (req.body.grant_type === 'refresh_token' && opts.refresh) return opts.refresh(req);
      tokenSeq++;
      return {
        status: 200,
        body: {
          access_token: `access-${tokenSeq}`,
          expires_in: 3599,
          scope: 'https://www.googleapis.com/auth/analytics.readonly',
          ...(req.body.grant_type === 'authorization_code' ? { refresh_token: `refresh-${tokenSeq}` } : {}),
        },
      };
    }
    return { status: 404 };
  });
  return { ...api, byDevice, revoked, polls: () => polls };
}

type TcApi = Awaited<ReturnType<typeof startTcApi>>;
const managers: TokenManager[] = [];

function manager(api: { url: string }, dir: string, extra: Partial<ConstructorParameters<typeof TokenManager>[0]> = {}) {
  const cache = new TokenCache(deviceFile(dir));
  const m = new TokenManager({
    product: TEST_PRODUCT,
    credential: { kind: 'device', device: new DeviceEndpoint(api.url, TEST_PRODUCT) },
    broker: (key) => new BrokerEndpoint(api.url, key, TEST_PRODUCT),
    cache,
    authWaitMs: 5000,
    pollIntervalMs: 10,
    slowDownMs: 15,
    clientName: () => 'Claude Desktop',
    openBrowser: (u) => setTimeout(() => void fetch(u), 30),
    ...extra,
  });
  managers.push(m);
  return { m, cache };
}

const byPath = (a: TcApi, p: string) => a.requests.filter((r) => r.path === p);

describe('device connect', () => {
  let api: TcApi | undefined;
  afterEach(async () => {
    for (const m of managers.splice(0)) m.close();
    await api?.close();
    api = undefined;
  });

  test('D1 → approve → D5 pending…complete → D6 with the device key → device.json (mode 600)', async () => {
    api = await startTcApi();
    const dir = tempDir();
    let opened = '';
    const { m, cache } = manager(api, dir, { openBrowser: (u) => { opened = u; setTimeout(() => void fetch(u), 60); } });

    assert.equal(await m.getAccessToken(), 'access-1');

    const [start] = byPath(api, '/v3/public/ga4/device');
    assert.equal(start.headers.authorization, undefined, 'D1 is public');
    assert.match(String(start.headers['user-agent']), /^tagpilot-test-mcp\/9\.8\.7$/);
    assert.equal(start.body.product, 'ga4', 'D1 names the product');
    assert.deepEqual(start.body.client, { name: 'Claude Desktop', version: '9.8.7', hostname: os.hostname().slice(0, 64) });
    const challenge = String(start.body.code_challenge);
    assert.match(opened, /\/connect\?code=ABCD-/);

    const polls = byPath(api, '/v3/public/ga4/device/token');
    assert.ok(polls.length >= 2, 'polled while pending');
    assert.ok(polls.every((p) => p.headers.authorization === undefined && typeof p.body.device_code === 'string'));

    const [exchange] = byPath(api, '/integrations/v1/ga4/oauth/token');
    assert.equal(exchange.headers.authorization, 'Bearer tpk_device_1', 'D6 uses the key from D5');
    assert.equal(exchange.body.code, 'google-code-ABCD-1001');
    assert.equal(crypto.createHash('sha256').update(String(exchange.body.code_verifier)).digest('base64url'), challenge);

    const file = path.join(dir, 'device.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const saved = cache.read()!;
    assert.equal(saved.api_key, 'tpk_device_1');
    assert.equal(saved.refresh_token, 'refresh-1');
    assert.equal(saved.access_token, 'access-1');

    const before = api.requests.length;
    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(api.requests.length, before, 'served from device.json');
  });

  test('tool call during connect: "Connect at <url> (code …), then ask again", polling continues', async () => {
    api = await startTcApi();
    let url = '';
    const { m } = manager(api, tempDir(), { authWaitMs: 50, openBrowser: (u) => (url = u) });
    const err = await m.getAccessToken().catch((e: unknown) => e);
    assert.ok(err instanceof AuthPendingError);
    assert.match(err.message, /^Connect at http:\/\/127\.0\.0\.1:\d+\/connect\?code=ABCD-1001 \(code ABCD-1001\), then ask again\./);
    assert.ok(api.polls() > 0);
    await fetch(url);
    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(byPath(api, '/v3/public/ga4/device').length, 1, 'same connect');
  });

  test('concurrent tool calls share one connect', async () => {
    api = await startTcApi();
    let opens = 0;
    const { m } = manager(api, tempDir(), { openBrowser: (u) => { opens++; setTimeout(() => void fetch(u), 30); } });
    assert.deepEqual(await Promise.all([m.getAccessToken(), m.getAccessToken(), m.getAccessToken()]), ['access-1', 'access-1', 'access-1']);
    assert.equal(opens, 1);
    assert.equal(byPath(api, '/v3/public/ga4/device').length, 1);
    assert.equal(byPath(api, '/integrations/v1/ga4/oauth/token').length, 1);
  });

  test('slow_down adds to the poll interval', async () => {
    api = await startTcApi({ poll: (n) => (n <= 2 ? { status: 400, body: { error: 'slow_down' } } : undefined) });
    const times: number[] = [];
    const { m } = manager(api, tempDir(), { openBrowser: (u) => setTimeout(() => void fetch(u), 100) });
    const orig = api.requests.push.bind(api.requests);
    api.requests.push = (...r: Recorded[]) => { if (r[0].path.endsWith('/device/token')) times.push(Date.now()); return orig(...r); };
    assert.equal(await m.getAccessToken(), 'access-1');
    // 10 ms base, +15 after each slow_down → later gaps ≥ 40 ms
    assert.ok(times.length >= 3);
    assert.ok(times[2] - times[1] >= 35, `gap after two slow_downs: ${times[2] - times[1]} ms`);
  });

  test('access_denied (user or Google) ends the connect; the next call starts over', async () => {
    api = await startTcApi();
    let n = 0;
    const { m, cache } = manager(api, tempDir(), { openBrowser: (u) => setTimeout(() => void fetch(++n === 1 ? `${u}&deny=consent_cancelled` : u), 20) });
    await assert.rejects(m.getAccessToken(), (e: Error) => e instanceof SignInFailedError && /Google sign-in: consent_cancelled/.test(e.message));
    assert.equal(cache.read(), null);
    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(byPath(api, '/v3/public/ga4/device').length, 2);
  });

  test('expired_token ends the connect', async () => {
    api = await startTcApi({ poll: () => ({ status: 400, body: { error: 'expired_token' } }) });
    const { m } = manager(api, tempDir(), { openBrowser: () => {} });
    await assert.rejects(m.getAccessToken(), (e: Error) => e instanceof SignInFailedError && /expired/.test(e.message));
  });

  test('the session expiry stops polling', async () => {
    api = await startTcApi({ expiresIn: 0.1 });
    const { m } = manager(api, tempDir(), { openBrowser: () => {} });
    await assert.rejects(m.getAccessToken(), /connect code expired before it was approved/);
    const polls = api.polls();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(api.polls(), polls);
  });

  test('temporary poll failures (429, 5xx) are retried', async () => {
    api = await startTcApi({ poll: (n) => (n === 1 ? { status: 429, body: {} } : n === 2 ? { status: 503, body: {} } : undefined) });
    const { m } = manager(api, tempDir());
    assert.equal(await m.getAccessToken(), 'access-1');
  });

  test('D1 errors are explained', async () => {
    const down = await startMockServer(() => ({ status: 503, body: { error: 'temporarily_unavailable' } }));
    const { m } = manager(down, tempDir());
    await assert.rejects(m.getAccessToken(), /not available right now/);
    await down.close();
    const limited = await startMockServer(() => ({ status: 429, body: {} }));
    const { m: m2 } = manager(limited, tempDir());
    await assert.rejects(m2.getAccessToken(), /Too many connect attempts/);
    await limited.close();
  });

  test('revoked device (401 on refresh) deletes device.json and reconnects on the next call', async () => {
    api = await startTcApi();
    const { m, cache } = manager(api, tempDir());
    cache.write({ api_key: 'tpk_device_old', refresh_token: 'r', expiry: 0 });
    api.revoked.add('tpk_device_old');

    const err = await m.getAccessToken().catch((e: unknown) => e);
    assert.ok(err instanceof ReauthRequiredError);
    assert.match(err.message, /disconnected from Tag Pilot.*revoked on https:\/\/app\.tagpilot\.io\/test-mcp/);
    assert.equal(cache.read(), null, 'device.json deleted');
    assert.equal(byPath(api, '/v3/public/ga4/device').length, 0, 'no connect during the failing call');

    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(cache.read()!.api_key, 'tpk_device_1');
  });

  test('refresh uses the stored device key and keeps it', async () => {
    api = await startTcApi();
    const { m, cache } = manager(api, tempDir());
    cache.write({ api_key: 'tpk_device_9', refresh_token: 'r9', access_token: 'old', expiry: 0, scope: 's' });
    assert.equal(await m.getAccessToken(), 'access-1');
    const [refresh] = byPath(api, '/integrations/v1/ga4/oauth/token');
    assert.equal(refresh.headers.authorization, 'Bearer tpk_device_9');
    assert.deepEqual(refresh.body, { grant_type: 'refresh_token', refresh_token: 'r9' });
    assert.deepEqual({ ...cache.read(), expiry: 0 }, { api_key: 'tpk_device_9', refresh_token: 'r9', access_token: 'access-1', expiry: 0, scope: 'https://www.googleapis.com/auth/analytics.readonly' });
  });

  test('invalid_grant with a device key: credential removed, reconnect next time', async () => {
    api = await startTcApi({ refresh: () => ({ status: 400, body: { error: 'invalid_grant' } }) });
    const { m, cache } = manager(api, tempDir());
    cache.write({ api_key: 'tpk_device_9', refresh_token: 'r9', expiry: 0 });
    await assert.rejects(m.getAccessToken(), (e: Error) => e instanceof ReauthRequiredError && /expired or was revoked/.test(e.message));
    assert.equal(cache.read(), null);
  });

  test('a device.json without a key is ignored', async () => {
    api = await startTcApi();
    const { m, cache } = manager(api, tempDir());
    cache.write({ refresh_token: 'orphan', expiry: 0 });
    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(byPath(api, '/v3/public/ga4/device').length, 1);
    assert.equal(cache.read()!.api_key, 'tpk_device_1');
  });
});

describe('status and logout with device connect', () => {
  const now = Date.UTC(2026, 9, 28, 12);

  test('status: not connected / connected with key prefix and Google state', () => {
    const dir = tempDir();
    const config = loadConfig(TEST_PRODUCT, { TEST_MCP_CONFIG_DIR: dir });
    assert.match(status(TEST_PRODUCT, config, now).join('\n'), /device: not connected \(the first question/);
    new TokenCache(deviceFile(dir)).write({ api_key: 'tpk_abcdef123456', refresh_token: 'r', expiry: now + 60_000 });
    const out = status(TEST_PRODUCT, config, now).join('\n');
    assert.match(out, /device: connected \(Tag Pilot key tpk_abcd…; manage it on https:\/\/app\.tagpilot\.io\/test-mcp\)/);
    assert.match(out, /google: signed in \(access token valid until 2026-10-28T12:01:00/);
    assert.ok(!out.includes('tpk_abcdef123456'), 'never prints the whole key');
  });

  test('logout removes device.json and says how to revoke the device', () => {
    const dir = tempDir();
    new TokenCache(deviceFile(dir)).write({ api_key: 'tpk_abcdef123456', refresh_token: 'r' });
    const lines = logout(TEST_PRODUCT, loadConfig(TEST_PRODUCT, { TEST_MCP_CONFIG_DIR: dir }));
    assert.equal(fs.existsSync(deviceFile(dir)), false);
    assert.match(lines.join('\n'), /Removed .*device\.json/);
    assert.match(lines.join('\n'), /revoke it under Connected devices on https:\/\/app\.tagpilot\.io\/test-mcp/);
  });
});
