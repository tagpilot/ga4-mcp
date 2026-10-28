// Hands out Google access tokens: from the cache, by refreshing (through the broker), or by signing in.
// Two ways to sign in (api-contract.md v3):
//   - device connect (default, no key configured): the user approves this device in their Tag Pilot
//     account, which goes on to Google's consent; we receive a per-device ga4:mcp key + the Google code.
//   - key sign-in (§K, TAGPILOT_API_KEY set): Google consent for that key.
// Both poll the broker, so the browser can be on any machine. A tool call waits up to `authWaitMs`;
// after that it returns a "finish connecting, then ask again" message while polling continues.
import os from 'node:os';
import { log } from '../log.js';
import { VERSION } from '../version.js';
import type { CachedToken, TokenCache } from './cache.js';
import {
  KeyRejectedError,
  OAuthGrantError,
  type AuthEndpoint,
  type DeviceClientInfo,
  type DeviceEndpoint,
  type TokenResponse,
} from './endpoints.js';
import { createPkce } from './pkce.js';

/** The saved credential was rejected; it was deleted and the next call signs in again. */
export class ReauthRequiredError extends Error {
  override name = 'ReauthRequiredError';
}

/** Sign-in or connect is still in progress; `message` tells the user where to finish it. */
export class AuthPendingError extends Error {
  override name = 'AuthPendingError';
  constructor(message: string, readonly url: string) {
    super(message);
  }
}

/** The sign-in ended without a code: denied, expired or cancelled. */
export class SignInFailedError extends Error {
  override name = 'SignInFailedError';
}

export interface AccessTokenSource {
  getAccessToken(): Promise<string>;
  /** Forget the current access token (e.g. Google answered 401) so the next call refreshes. */
  invalidateAccessToken(): void;
}

export type Credential = { kind: 'key'; apiKey: string } | { kind: 'device'; device: DeviceEndpoint };

export interface TokenManagerOptions {
  credential: Credential;
  /** Key-authenticated broker calls (token exchange/refresh, §K sign-in) for a given key. */
  broker: (apiKey: string) => AuthEndpoint;
  cache: TokenCache;
  authWaitMs: number;
  openBrowser?: (url: string) => void;
  /** The connecting client, e.g. the MCP client's name from `initialize`. */
  clientName?: () => string | undefined;
  now?: () => number;
  /** Overrides the broker's poll interval (tests). */
  pollIntervalMs?: number;
  /** Added to the poll interval on `slow_down`. Default 2 s (RFC 8628). */
  slowDownMs?: number;
}

/** Refresh this long before the access token actually expires. */
const EXPIRY_MARGIN_MS = 60_000;

interface PendingAuth {
  url: string;
  pendingMessage: string;
  done: Promise<string>;
}

export class TokenManager implements AccessTokenSource {
  private pending: Promise<PendingAuth> | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly abort = new AbortController();
  private readonly now: () => number;

  constructor(private readonly opts: TokenManagerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get cacheFile(): string {
    return this.opts.cache.file;
  }

  get mode(): Credential['kind'] {
    return this.opts.credential.kind;
  }

  async getAccessToken(waitMs = this.opts.authWaitMs): Promise<string> {
    let cached = this.opts.cache.read();
    if (cached && this.mode === 'device' && !cached.api_key) {
      this.opts.cache.clear(); // unusable without the device key
      cached = null;
    }
    if (cached?.access_token && cached.expiry && cached.expiry - this.now() > EXPIRY_MARGIN_MS) {
      return cached.access_token;
    }
    if (cached?.refresh_token) return this.refresh(cached);
    return this.authorize(waitMs);
  }

  invalidateAccessToken(): void {
    const cached = this.opts.cache.read();
    if (cached?.access_token) {
      delete cached.access_token;
      delete cached.expiry;
      this.opts.cache.write(cached);
    }
  }

  /** Stops any background sign-in polling. */
  close(): void {
    this.abort.abort();
  }

  private apiKeyFor(cached: CachedToken | null): string | undefined {
    const c = this.opts.credential;
    return c.kind === 'key' ? c.apiKey : cached?.api_key;
  }

  private refresh(cached: CachedToken): Promise<string> {
    this.refreshing ??= this.doRefresh(cached).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(cached: CachedToken): Promise<string> {
    const apiKey = this.apiKeyFor(cached)!;
    let res: TokenResponse;
    try {
      res = await this.opts.broker(apiKey).refresh(cached.refresh_token!);
    } catch (e) {
      if (e instanceof OAuthGrantError && e.error === 'invalid_grant') {
        this.opts.cache.clear();
        log('Google rejected the saved refresh token (invalid_grant); removed the saved sign-in.');
        throw new ReauthRequiredError(
          'Your Google sign-in for GA4 expired or was revoked, so the saved sign-in was removed. ' +
            'Ask again: the next request starts a new sign-in (a browser window opens).',
        );
      }
      if (e instanceof KeyRejectedError && this.mode === 'device') {
        this.opts.cache.clear();
        log('Tag Pilot rejected this device\'s key (revoked?); removed the saved connection.');
        throw new ReauthRequiredError(
          'This computer was disconnected from Tag Pilot (the device was revoked on the GA4 MCP page), so its saved connection was removed. ' +
            'Ask again to connect it again (a browser window opens).',
        );
      }
      throw e;
    }
    this.save(res, this.opts.cache.read() ?? cached);
    return res.access_token;
  }

  private save(res: TokenResponse, previous: CachedToken, apiKey?: string): void {
    const deviceKey = this.mode === 'device' ? (apiKey ?? previous.api_key) : undefined;
    this.opts.cache.write({
      ...(deviceKey ? { api_key: deviceKey } : {}),
      refresh_token: res.refresh_token ?? previous.refresh_token,
      access_token: res.access_token,
      expiry: this.now() + (res.expires_in ?? 3600) * 1000,
      scope: res.scope ?? previous.scope,
    });
  }

  private async authorize(waitMs: number): Promise<string> {
    if (!this.pending) {
      const started = this.opts.credential.kind === 'device' ? this.startDeviceConnect(this.opts.credential.device) : this.startKeySignIn(this.opts.credential.apiKey);
      this.pending = started;
      // A failed start, or a finished/failed sign-in, lets the next call begin a fresh one.
      const clear = () => {
        if (this.pending === started) this.pending = null;
      };
      started.then((p) => p.done.then(clear, clear), clear);
    }
    const { url, pendingMessage, done } = await this.pending;
    if (!Number.isFinite(waitMs)) return done;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AuthPendingError(pendingMessage, url)), waitMs);
    });
    try {
      return await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private finishSignIn(res: TokenResponse, apiKey?: string): string {
    if (!res.refresh_token) {
      log('Warning: Google returned no refresh token; you will need to sign in again when the access token expires.');
    }
    this.save(res, {}, apiKey);
    log(`Connected to Google Analytics. Saved to ${this.opts.cache.file}`);
    return res.access_token;
  }

  // ---- device connect (D1 → D5 → D6) ----

  private async startDeviceConnect(device: DeviceEndpoint): Promise<PendingAuth> {
    const { verifier, challenge } = createPkce();
    const client: DeviceClientInfo = { name: this.opts.clientName?.() || 'CLI', version: VERSION, hostname: os.hostname() };
    const s = await device.start({ codeChallenge: challenge, client });
    const url = s.verificationUriComplete;
    log(
      `Connect Tag Pilot GA4 MCP: open ${url} in any browser and confirm the code ${s.userCode}.\n` +
        'Sign in to (or create) your free Tag Pilot account, approve this device, then allow read-only Google Analytics access.',
    );
    this.opts.openBrowser?.(url);
    const done = this.pollDevice(device, s.deviceCode, s.interval, s.expiresIn, verifier);
    done.catch(() => {}); // nobody may be waiting any more; the next call sees the outcome via `pending`
    return {
      url,
      pendingMessage:
        `Connect at ${url} (code ${s.userCode}), then ask again.\n` +
        'A browser window should have opened; if not, open the link in any browser, on any device. Sign in to your free Tag Pilot account, ' +
        'check the code, approve this device, then allow read-only Google Analytics access.',
      done,
    };
  }

  private async pollDevice(device: DeviceEndpoint, deviceCode: string, interval: number, expiresIn: number, verifier: string): Promise<string> {
    const deadline = this.now() + expiresIn * 1000;
    let intervalMs = this.opts.pollIntervalMs ?? interval * 1000;
    let delayMs = intervalMs;
    for (;;) {
      await sleep(delayMs, this.abort.signal);
      if (this.now() >= deadline) {
        throw new SignInFailedError('The connect code expired before it was approved. Ask again to get a new code.');
      }
      const r = await device.poll(deviceCode);
      delayMs = intervalMs;
      switch (r.status) {
        case 'pending':
          continue;
        case 'slow_down':
          intervalMs += this.opts.slowDownMs ?? 2000;
          delayMs = intervalMs;
          continue;
        case 'retry':
          if (r.afterSeconds) delayMs = Math.max(intervalMs, r.afterSeconds * 1000);
          continue;
        case 'expired':
          throw new SignInFailedError('The connect code expired or was already used. Ask again to get a new code.');
        case 'denied':
          throw new SignInFailedError(
            `Connecting was not completed (${r.googleError ? `Google sign-in: ${r.googleError}` : 'denied'}). Ask again to start over.`,
          );
        case 'complete': {
          const res = await this.opts.broker(r.apiKey).exchangeCode({ code: r.code, codeVerifier: verifier });
          return this.finishSignIn(res, r.apiKey);
        }
      }
    }
  }

  // ---- key sign-in (§K) ----

  private async startKeySignIn(apiKey: string): Promise<PendingAuth> {
    const endpoint = this.opts.broker(apiKey);
    const { verifier, challenge } = createPkce();
    const session = await endpoint.startSession({ codeChallenge: challenge });
    const url = session.authorizeUrl;
    log(`Sign in with Google to give read-only access to Google Analytics. Open this link in any browser:\n${url}`);
    this.opts.openBrowser?.(url);
    const done = this.pollKeySession(endpoint, session.sessionId, session.pollInterval, session.expiresIn, verifier);
    done.catch(() => {});
    return {
      url,
      pendingMessage:
        `Finish signing in with Google at ${url} , then ask again.\n` +
        'A browser window should have opened; if not, open the link in any browser, on any device, and approve read-only access to Google Analytics.',
      done,
    };
  }

  private async pollKeySession(endpoint: AuthEndpoint, sessionId: string, pollInterval: number, expiresIn: number, verifier: string): Promise<string> {
    const deadline = this.now() + expiresIn * 1000;
    const intervalMs = this.opts.pollIntervalMs ?? pollInterval * 1000;
    let delayMs = intervalMs;
    for (;;) {
      await sleep(delayMs, this.abort.signal);
      if (this.now() >= deadline) {
        throw new SignInFailedError('The Google sign-in link expired before it was used. Ask again to get a new link.');
      }
      const result = await endpoint.pollResult(sessionId);
      delayMs = intervalMs;
      switch (result.status) {
        case 'pending':
          continue;
        case 'retry':
          if (result.afterSeconds) delayMs = Math.max(intervalMs, result.afterSeconds * 1000);
          continue;
        case 'not_found':
          throw new SignInFailedError('The Google sign-in session expired or was already used. Ask again to get a new link.');
        case 'error':
          throw new SignInFailedError(`Google sign-in was not completed (${result.error}). Ask again to get a new sign-in link.`);
        case 'complete':
          return this.finishSignIn(await endpoint.exchangeCode({ code: result.code, codeVerifier: verifier }));
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new SignInFailedError('Sign-in cancelled.'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SignInFailedError('Sign-in cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
