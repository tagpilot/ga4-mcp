import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TokenCache, cacheFileFor } from '../src/auth/cache.js';
import { BrokerEndpoint } from '../src/auth/endpoints.js';
import { AuthPendingError, ReauthRequiredError, SignInFailedError, TokenManager } from '../src/auth/token-manager.js';
import { createAccessTokenSource } from '../src/auth/index.js';
import { loadConfig } from '../src/config.js';
import { SetupError } from '../src/errors.js';
import { startMockServer, tempDir, type Recorded } from './helpers.js';

const API_KEY = 'tpk_test_123';

interface Session {
  id: string;
  challenge: string;
  status: 'pending' | 'complete' | 'error';
  code?: string;
  error?: string;
}

/**
 * Mock tc-api broker implementing contract v2. `authorize_url` points at a fake consent page on the
 * mock: "opening" it in a browser completes the session the way Google + the broker callback would.
 */
async function startBroker(opts: {
  refresh?: (r: Recorded) => { status: number; body?: unknown };
  result?: (s: Session, n: number) => { status: number; body?: unknown } | undefined;
  expiresIn?: number;
} = {}) {
  const sessions = new Map<string, Session>();
  let seq = 0;
  let tokenSeq = 0;
  let polls = 0;
  const broker = await startMockServer((req, url) => {
    if (req.path === '/consent') {
      const s = sessions.get(url.searchParams.get('session') ?? '');
      if (!s) return { status: 400, body: 'invalid or expired' };
      const denied = url.searchParams.get('deny');
      Object.assign(s, denied ? { status: 'error', error: denied } : { status: 'complete', code: `code-for-${s.id}` });
      return { status: 200, body: 'Signed in to Tag Pilot GA4 MCP.' };
    }
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return { status: 401, body: { code: 401, message: 'Invalid API key' } };
    if (req.path === '/integrations/v1/ga4/oauth/session') {
      const id = `sess-${++seq}`;
      sessions.set(id, { id, challenge: String(req.body.code_challenge), status: 'pending' });
      return {
        status: 201,
        body: { session_id: id, authorize_url: `${broker.url}/consent?session=${id}`, poll_interval: 2, expires_in: opts.expiresIn ?? 600 },
      };
    }
    const m = req.path.match(/^\/integrations\/v1\/ga4\/oauth\/session\/([^/]+)\/result$/);
    if (m) {
      polls++;
      const s = sessions.get(m[1]);
      const custom = s && opts.result?.(s, polls);
      if (custom) return custom;
      if (!s) return { status: 404, body: { error: 'not_found' } };
      if (s.status === 'pending') return { status: 200, body: { status: 'pending' } };
      sessions.delete(s.id); // single use
      return { status: 200, body: s.status === 'complete' ? { status: 'complete', code: s.code } : { status: 'error', error: s.error } };
    }
    if (req.path === '/integrations/v1/ga4/oauth/token') {
      if (req.body.grant_type === 'refresh_token' && opts.refresh) return opts.refresh(req);
      tokenSeq++;
      return {
        status: 200,
        body: {
          access_token: `access-${tokenSeq}`,
          expires_in: 3599,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/analytics.readonly',
          ...(req.body.grant_type === 'authorization_code' ? { refresh_token: 'refresh-1' } : {}),
        },
      };
    }
    return { status: 404 };
  });
  return { ...broker, sessions, polls: () => polls };
}

type Broker = Awaited<ReturnType<typeof startBroker>>;

const managers: TokenManager[] = [];
function manager(broker: { url: string }, dir: string, extra: Partial<ConstructorParameters<typeof TokenManager>[0]> = {}) {
  const cache = new TokenCache(cacheFileFor(dir, API_KEY));
  const m = new TokenManager({
    endpoint: new BrokerEndpoint(broker.url, API_KEY),
    cache,
    authWaitMs: 5000,
    pollIntervalMs: 10,
    // The "browser": open the authorize URL, i.e. approve on the fake consent page.
    openBrowser: (u) => void fetch(u).catch(() => {}),
    ...extra,
  });
  managers.push(m);
  return { m, cache };
}

const byPath = (b: Broker, suffix: string) => b.requests.filter((r) => r.path.endsWith(suffix));

describe('broker sign-in (polling)', () => {
  let broker: Broker | undefined;
  afterEach(async () => {
    for (const m of managers.splice(0)) m.close();
    await broker?.close();
    broker = undefined;
  });

  test('first call: session → browser → poll until complete → token exchange → cache (mode 600)', async () => {
    broker = await startBroker();
    const dir = tempDir();
    let opened = '';
    const { m, cache } = manager(broker, dir, {
      // Approve only after a few polls, so the client really sees "pending" first.
      openBrowser: (u) => {
        opened = u;
        setTimeout(() => void fetch(u), 60);
      },
    });

    assert.equal(await m.getAccessToken(), 'access-1');
    assert.match(opened, /\/consent\?session=sess-1$/);

    const [sessionReq] = byPath(broker, '/session');
    assert.equal(sessionReq.headers.authorization, `Bearer ${API_KEY}`);
    assert.match(String(sessionReq.headers['user-agent']), /^tagpilot-ga4-mcp\/\d+\.\d+\.\d+$/);
    assert.deepEqual(Object.keys(sessionReq.body), ['code_challenge'], 'v2 sends only the challenge');
    const challenge = String(sessionReq.body.code_challenge);
    assert.match(challenge, /^[A-Za-z0-9_-]{43,128}$/);

    const polls = byPath(broker, '/session/sess-1/result');
    assert.ok(polls.length >= 2, `polled while pending (${polls.length})`);
    assert.ok(polls.every((p) => p.method === 'POST' && p.headers.authorization === `Bearer ${API_KEY}`));

    const [exchange] = byPath(broker, '/token');
    assert.equal(exchange.body.grant_type, 'authorization_code');
    assert.equal(exchange.body.code, 'code-for-sess-1');
    const verifier = String(exchange.body.code_verifier);
    assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge, 'PKCE S256');
    assert.deepEqual(Object.keys(exchange.body).sort(), ['code', 'code_verifier', 'grant_type']);

    const file = cacheFileFor(dir, API_KEY);
    assert.equal(path.basename(file), crypto.createHash('sha256').update(API_KEY).digest('hex').slice(0, 16) + '.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const saved = cache.read()!;
    assert.equal(saved.refresh_token, 'refresh-1');
    assert.equal(saved.access_token, 'access-1');
    assert.ok(saved.expiry! > Date.now() + 3500_000);
    assert.equal(saved.scope, 'https://www.googleapis.com/auth/analytics.readonly');

    // Cached: no more broker traffic.
    const before = broker.requests.length;
    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(broker.requests.length, before);
  });

  test('uses the broker poll_interval when not overridden', async () => {
    broker = await startBroker();
    const { m } = manager(broker, tempDir(), { pollIntervalMs: undefined, authWaitMs: 300, openBrowser: () => {} });
    await assert.rejects(m.getAccessToken(), AuthPendingError);
    assert.equal(broker.polls(), 0, 'poll_interval is 2 s, so no poll within 300 ms');
  });

  test('sign-in still pending after the wait: "finish signing in" with the URL, polling continues', async () => {
    broker = await startBroker();
    let authorizeUrl = '';
    const { m } = manager(broker, tempDir(), { authWaitMs: 50, openBrowser: (u) => (authorizeUrl = u) });

    const err = await m.getAccessToken().catch((e: unknown) => e);
    assert.ok(err instanceof AuthPendingError);
    assert.match(err.message, /Finish signing in with Google at http:\/\/127\.0\.0\.1:\d+\/consent\?session=sess-1 , then ask again/);
    assert.ok(broker.polls() > 0, 'polling in the background');

    await fetch(authorizeUrl); // the user approves later, e.g. on another device
    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(byPath(broker, '/session').length, 1, 'same sign-in, not a new one');
  });

  test('concurrent tool calls share one sign-in', async () => {
    broker = await startBroker();
    let opens = 0;
    const { m } = manager(broker, tempDir(), {
      openBrowser: (u) => {
        opens++;
        setTimeout(() => void fetch(u), 30);
      },
    });
    const tokens = await Promise.all([m.getAccessToken(), m.getAccessToken(), m.getAccessToken()]);
    assert.deepEqual(tokens, ['access-1', 'access-1', 'access-1']);
    assert.equal(opens, 1);
    assert.equal(byPath(broker, '/session').length, 1);
    assert.equal(byPath(broker, '/token').length, 1);
  });

  test('a denied consent fails the sign-in; the next call starts a new one', async () => {
    broker = await startBroker();
    let n = 0;
    const { m } = manager(broker, tempDir(), { openBrowser: (u) => void fetch(++n === 1 ? `${u}&deny=access_denied` : u) });
    await assert.rejects(m.getAccessToken(), (e: Error) => e instanceof SignInFailedError && /access_denied/.test(e.message));
    assert.equal(byPath(broker, '/token').length, 0);
    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(byPath(broker, '/session').length, 2);
  });

  test('404 on the result (expired or collected elsewhere) ends the sign-in', async () => {
    broker = await startBroker({ result: () => ({ status: 404, body: { error: 'not_found' } }) });
    const { m } = manager(broker, tempDir(), { openBrowser: () => {} });
    await assert.rejects(m.getAccessToken(), (e: Error) => e instanceof SignInFailedError && /expired or was already used/.test(e.message));
    assert.equal(byPath(broker, '/token').length, 0);
  });

  test('the session expiry stops polling', async () => {
    broker = await startBroker({ expiresIn: 0.1 });
    const { m } = manager(broker, tempDir(), { openBrowser: () => {} });
    await assert.rejects(m.getAccessToken(), (e: Error) => e instanceof SignInFailedError && /link expired/.test(e.message));
    const polls = broker.polls();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(broker.polls(), polls, 'no polling after expiry');
  });

  test('temporary poll failures (429, 5xx) are retried', async () => {
    broker = await startBroker({
      result: (_s, n) =>
        n === 1 ? { status: 429, body: { error: 'rate_limited', message: 'slow down' } } : n === 2 ? { status: 503, body: { error: 'temporarily_unavailable' } } : undefined,
    });
    const { m } = manager(broker, tempDir(), { openBrowser: (u) => setTimeout(() => void fetch(u), 40) });
    assert.equal(await m.getAccessToken(), 'access-1');
    assert.ok(broker.polls() >= 3);
  });

  test('a revoked key while polling fails the sign-in with the key message', async () => {
    broker = await startBroker({ result: () => ({ status: 401, body: { code: 401, message: 'Invalid API key' } }) });
    const { m } = manager(broker, tempDir(), { openBrowser: () => {} });
    await assert.rejects(m.getAccessToken(), (e: Error) => e instanceof SetupError && /invalid or revoked/.test(e.message));
  });

  test('expired access token is refreshed through the broker; refresh_token kept', async () => {
    broker = await startBroker();
    const { m, cache } = manager(broker, tempDir());
    cache.write({ refresh_token: 'refresh-old', access_token: 'stale', expiry: Date.now() + 10_000, scope: 's' });

    assert.equal(await m.getAccessToken(), 'access-1');
    const [refresh] = byPath(broker, '/token');
    assert.deepEqual(refresh.body, { grant_type: 'refresh_token', refresh_token: 'refresh-old' });
    assert.equal(refresh.headers.authorization, `Bearer ${API_KEY}`);
    const saved = cache.read()!;
    assert.equal(saved.refresh_token, 'refresh-old');
    assert.equal(saved.access_token, 'access-1');
    assert.equal(byPath(broker, '/session').length, 0);
  });

  test('concurrent calls share one refresh', async () => {
    broker = await startBroker();
    const { m, cache } = manager(broker, tempDir());
    cache.write({ refresh_token: 'r', expiry: 0 });
    const tokens = await Promise.all([m.getAccessToken(), m.getAccessToken(), m.getAccessToken()]);
    assert.deepEqual(tokens, ['access-1', 'access-1', 'access-1']);
    assert.equal(byPath(broker, '/token').length, 1);
  });

  test('invalid_grant on refresh clears the cache, explains, and signs in again on the next call', async () => {
    broker = await startBroker({
      refresh: () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }),
    });
    const { m, cache } = manager(broker, tempDir());
    cache.write({ refresh_token: 'revoked', access_token: 'old', expiry: 0 });

    const err = await m.getAccessToken().catch((e: unknown) => e);
    assert.ok(err instanceof ReauthRequiredError);
    assert.match(err.message, /browser window opens/);
    assert.equal(cache.read(), null, 'cache deleted');
    assert.equal(byPath(broker, '/session').length, 0, 'no sign-in during the failing call');

    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(byPath(broker, '/session').length, 1);
    assert.equal(cache.read()!.refresh_token, 'refresh-1');
  });

  test('other refresh failures keep the cache', async () => {
    broker = await startBroker({ refresh: () => ({ status: 502, body: { error: 'temporarily_unavailable', message: 'x' } }) });
    const { m, cache } = manager(broker, tempDir());
    cache.write({ refresh_token: 'keep-me', expiry: 0 });
    await assert.rejects(m.getAccessToken(), /could not reach Google/);
    assert.equal(cache.read()!.refresh_token, 'keep-me');
  });

  for (const [status, body, pattern] of [
    [401, { code: 401, message: 'Invalid' }, /invalid or revoked/],
    [403, { code: 403, message: 'scope' }, /ga4:mcp/],
    [503, { error: 'temporarily_unavailable', message: 'off' }, /not available/],
    [429, { error: 'rate_limited', message: 'slow' }, /Retry in 7 s/],
    [400, { error: 'invalid_request', message: 'code_challenge must be…' }, /rejected the request: code_challenge must be/],
  ] as const) {
    test(`broker ${status} on /session gives a clear message`, async () => {
      const mock = await startMockServer(() => ({ status, body, headers: { 'retry-after': '7' } }));
      const { m } = manager(mock, tempDir());
      await assert.rejects(m.getAccessToken(), pattern);
      await mock.close();
    });
  }

  test('an unreachable broker is reported with its URL', async () => {
    const { m } = manager({ url: 'http://127.0.0.1:9' }, tempDir());
    await assert.rejects(m.getAccessToken(), /Could not reach Tag Pilot at http:\/\/127\.0\.0\.1:9/);
  });
});

describe('configuration', () => {
  test('missing TAGPILOT_API_KEY surfaces on first use with a link to the app', async () => {
    const source = createAccessTokenSource(loadConfig({}));
    await assert.rejects(source.getAccessToken(), (e: Error) => e instanceof SetupError && /app\.tagpilot\.io/.test(e.message));
  });

  test('defaults and overrides', () => {
    const c = loadConfig({ TAGPILOT_API_KEY: ' tpk_x ', TAGPILOT_API_URL: 'http://localhost:8000/' });
    assert.equal(c.apiKey, 'tpk_x');
    assert.equal(c.apiUrl, 'http://localhost:8000');
    assert.equal(c.authWaitMs, 45_000);
    assert.equal(loadConfig({}).apiUrl, 'https://api.tagpilot.io');
    assert.match(loadConfig({}).cacheDir, /\.config\/tagpilot\/ga4-mcp$/);
    assert.equal(loadConfig({ GA4_MCP_NO_BROWSER: '1' }).openBrowser, false);
  });
});
