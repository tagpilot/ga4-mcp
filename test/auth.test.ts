import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TokenCache, cacheFileFor } from '../src/auth/cache.js';
import { BrokerEndpoint, DirectGoogleEndpoint } from '../src/auth/endpoints.js';
import { AuthPendingError, ReauthRequiredError, TokenManager } from '../src/auth/token-manager.js';
import { createAccessTokenSource } from '../src/auth/index.js';
import { loadConfig } from '../src/config.js';
import { SetupError } from '../src/errors.js';
import { startMockServer, tempDir, mockFetch, type Recorded } from './helpers.js';

const API_KEY = 'tpk_test_123';

/**
 * Mock broker. `/session` returns an authorize_url pointing at the mock's own fake consent page, which
 * 302s to the loopback callback the way Google + tc-api's callback would.
 */
async function startBroker(opts: { refresh?: (r: Recorded) => { status: number; body?: unknown }; consentCode?: string } = {}) {
  let session: { redirect_port: number; state: string; code_challenge: string } | undefined;
  let tokenSeq = 0;
  const broker = await startMockServer((req, url) => {
    if (req.path === '/integrations/v1/ga4/oauth/session') {
      session = req.body as typeof session;
      return { status: 201, body: { authorize_url: `${brokerUrl()}/consent?x=1`, expires_in: 600 } };
    }
    if (req.path === '/consent') {
      const state = url.searchParams.get('state') ?? session!.state;
      return {
        status: 302,
        headers: { location: `http://127.0.0.1:${session!.redirect_port}/callback?code=${opts.consentCode ?? 'auth-code-1'}&state=${state}` },
      };
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
  const brokerUrl = () => broker.url;
  return { ...broker, session: () => session! };
}

type Broker = Awaited<ReturnType<typeof startBroker>>;

function manager(broker: Broker, dir: string, extra: Partial<ConstructorParameters<typeof TokenManager>[0]> = {}) {
  const cache = new TokenCache(cacheFileFor(dir, API_KEY));
  const m = new TokenManager({
    endpoint: new BrokerEndpoint(broker.url, API_KEY),
    cache,
    authWaitMs: 5000,
    // The "browser": follow the authorize URL through the fake consent page to the loopback callback.
    openBrowser: (u) => void fetch(u).catch(() => {}),
    ...extra,
  });
  return { m, cache };
}

const tokenCalls = (b: Broker) => b.requests.filter((r) => r.path.endsWith('/token'));

describe('broker auth flow', () => {
  let broker: Broker | undefined;
  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  test('first call: session → browser → callback → token exchange → cache (mode 600)', async () => {
    broker = await startBroker();
    const dir = tempDir();
    const { m, cache } = manager(broker, dir);

    assert.equal(await m.getAccessToken(), 'access-1');

    const [sessionReq] = broker.requests;
    assert.equal(sessionReq.path, '/integrations/v1/ga4/oauth/session');
    assert.equal(sessionReq.headers.authorization, `Bearer ${API_KEY}`);
    assert.match(String(sessionReq.headers['user-agent']), /^tagpilot-ga4-mcp\/\d+\.\d+\.\d+$/);
    const s = broker.session();
    assert.ok(s.redirect_port >= 1024 && s.redirect_port <= 65535);
    assert.match(s.state, /^[A-Za-z0-9_-]{16,128}$/);
    assert.match(s.code_challenge, /^[A-Za-z0-9_-]{43,128}$/);

    const [exchange] = tokenCalls(broker);
    assert.equal(exchange.body.grant_type, 'authorization_code');
    assert.equal(exchange.body.code, 'auth-code-1');
    const verifier = String(exchange.body.code_verifier);
    assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), s.code_challenge, 'PKCE S256');
    assert.equal(exchange.body.redirect_uri, undefined, 'broker adds redirect_uri itself');

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

  test('a callback with the wrong state is rejected and its code is never exchanged', async () => {
    broker = await startBroker();
    let attempts = 0;
    const { m } = manager(broker, tempDir(), {
      openBrowser: (u) => {
        void (async () => {
          attempts++;
          const forged = await fetch(`${u}&state=forged-state`);
          assert.equal(forged.status, 400);
          assert.match(await forged.text(), /mismatch/i);
          await fetch(u); // the real redirect still completes the flow
        })();
      },
    });
    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(attempts, 1);
    assert.equal(tokenCalls(broker).length, 1, 'only the code with the right state was exchanged');
  });

  test('Google error on the callback fails the flow and the next call starts over', async () => {
    broker = await startBroker();
    let n = 0;
    const { m } = manager(broker, tempDir(), {
      openBrowser: (u) => {
        n++;
        if (n === 1) {
          const s = broker!.session();
          void fetch(`http://127.0.0.1:${s.redirect_port}/callback?error=access_denied&state=${s.state}`);
        } else void fetch(u);
      },
    });
    await assert.rejects(m.getAccessToken(), /access_denied/);
    assert.equal(tokenCalls(broker).length, 0);
    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(broker.requests.filter((r) => r.path.endsWith('/session')).length, 2);
  });

  test('sign-in still pending after the wait: returns the URL, completes in the background', async () => {
    broker = await startBroker();
    let authorizeUrl = '';
    const { m } = manager(broker, tempDir(), { authWaitMs: 50, openBrowser: (u) => (authorizeUrl = u) });
    const err = await m.getAccessToken().catch((e: unknown) => e);
    assert.ok(err instanceof AuthPendingError);
    assert.ok(err.message.includes(authorizeUrl));
    await fetch(authorizeUrl); // user finishes in the browser later
    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(broker.requests.filter((r) => r.path.endsWith('/session')).length, 1, 'same sign-in, not a new one');
  });

  test('expired access token is refreshed through the broker; refresh_token kept', async () => {
    broker = await startBroker();
    const { m, cache } = manager(broker, tempDir());
    cache.write({ refresh_token: 'refresh-old', access_token: 'stale', expiry: Date.now() + 10_000, scope: 's' });

    assert.equal(await m.getAccessToken(), 'access-1');
    const [refresh] = tokenCalls(broker);
    assert.deepEqual(refresh.body, { grant_type: 'refresh_token', refresh_token: 'refresh-old' });
    assert.equal(refresh.headers.authorization, `Bearer ${API_KEY}`);
    const saved = cache.read()!;
    assert.equal(saved.refresh_token, 'refresh-old');
    assert.equal(saved.access_token, 'access-1');
    assert.equal(broker.requests.filter((r) => r.path.endsWith('/session')).length, 0);
  });

  test('concurrent calls share one refresh', async () => {
    broker = await startBroker();
    const { m, cache } = manager(broker, tempDir());
    cache.write({ refresh_token: 'r', expiry: 0 });
    const tokens = await Promise.all([m.getAccessToken(), m.getAccessToken(), m.getAccessToken()]);
    assert.deepEqual(tokens, ['access-1', 'access-1', 'access-1']);
    assert.equal(tokenCalls(broker).length, 1);
  });

  test('invalid_grant on refresh clears the cache, explains, and re-auths on the next call', async () => {
    broker = await startBroker({
      refresh: () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }),
    });
    const { m, cache } = manager(broker, tempDir());
    cache.write({ refresh_token: 'revoked', access_token: 'old', expiry: 0 });

    const err = await m.getAccessToken().catch((e: unknown) => e);
    assert.ok(err instanceof ReauthRequiredError);
    assert.match(err.message, /browser window will open/);
    assert.equal(cache.read(), null, 'cache deleted');

    assert.equal(await m.getAccessToken(), 'access-1');
    assert.equal(broker.requests.filter((r) => r.path.endsWith('/session')).length, 1);
    assert.equal(cache.read()!.refresh_token, 'refresh-1');
  });

  test('other refresh failures keep the cache', async () => {
    broker = await startBroker({ refresh: () => ({ status: 503, body: { error: 'service_unavailable' } }) });
    const { m, cache } = manager(broker, tempDir());
    cache.write({ refresh_token: 'keep-me', expiry: 0 });
    await assert.rejects(m.getAccessToken(), SetupError);
    assert.equal(cache.read()!.refresh_token, 'keep-me');
  });

  for (const [status, pattern] of [
    [401, /invalid or revoked/],
    [403, /ga4:mcp/],
    [503, /not available/],
    [429, /Retry in 7 s/],
    [502, /could not reach Google/],
  ] as const) {
    test(`broker ${status} on /session gives a clear message`, async () => {
      broker = await startMockServer(() => ({ status, body: { error: 'x', message: 'nope' }, headers: { 'retry-after': '7' } })) as unknown as Broker;
      const { m } = manager(broker, tempDir());
      await assert.rejects(m.getAccessToken(), pattern);
    });
  }

  test('an unreachable broker is reported with its URL', async () => {
    const m = new TokenManager({
      endpoint: new BrokerEndpoint('http://127.0.0.1:9', API_KEY),
      cache: new TokenCache(cacheFileFor(tempDir(), API_KEY)),
      authWaitMs: 1000,
    });
    await assert.rejects(m.getAccessToken(), /Could not reach Tag Pilot at http:\/\/127\.0\.0\.1:9/);
  });
});

describe('configuration', () => {
  test('missing TAGPILOT_API_KEY surfaces on first use with a link to the app', async () => {
    const source = createAccessTokenSource(loadConfig({}));
    await assert.rejects(source.getAccessToken(), (e: Error) => e instanceof SetupError && /app\.tagpilot\.io/.test(e.message));
  });

  test('defaults and overrides', () => {
    const c = loadConfig({ TAGPILOT_API_KEY: ' tpk_x ', TAGPILOT_API_URL: 'http://localhost:8000/', GA4_MCP_OAUTH_PORT: '53682' });
    assert.equal(c.mode, 'broker');
    assert.equal(c.apiKey, 'tpk_x');
    assert.equal(c.apiUrl, 'http://localhost:8000');
    assert.equal(c.oauthPort, 53682);
    assert.equal(loadConfig({}).apiUrl, 'https://api.tagpilot.io');
    assert.match(loadConfig({}).cacheDir, /\.config\/tagpilot\/ga4-mcp$/);
    assert.equal(loadConfig({ GA4_MCP_DEV_GOOGLE_CLIENT_ID: 'id', GA4_MCP_DEV_GOOGLE_CLIENT_SECRET: 's' }).mode, 'dev');
    assert.throws(() => loadConfig({ GA4_MCP_OAUTH_PORT: '80' }), /1024/);
  });
});

describe('dev mode (direct Google client)', () => {
  test('authorize URL and token exchange', async () => {
    const f = mockFetch(() => ({ body: { access_token: 'a', expires_in: 3600, refresh_token: 'r' } }));
    const ep = new DirectGoogleEndpoint('cid', 'csecret', f.fetch);
    const { authorizeUrl } = await ep.startSession({ port: 5555, codeChallenge: 'c'.repeat(43), state: 'st' });
    const u = new URL(authorizeUrl);
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555/callback');
    assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/analytics.readonly');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('access_type'), 'offline');

    await ep.exchangeCode({ code: 'k', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:5555/callback' });
    const sent = new URLSearchParams(String(f.calls[0].init.body));
    assert.equal(f.calls[0].url, 'https://oauth2.googleapis.com/token');
    assert.equal(sent.get('client_secret'), 'csecret');
    assert.equal(sent.get('code_verifier'), 'v');
    assert.equal(sent.get('redirect_uri'), 'http://127.0.0.1:5555/callback');
  });
});
