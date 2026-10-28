// Hands out Google access tokens: from the cache, by refreshing (through the broker), or by signing in.
// Two ways to sign in (api-contract.md v3):
//   - device connect (default, no key configured): the user approves this device in their Tag Pilot
//     account, which goes on to Google's consent; we receive a per-device key + the Google code.
//   - key sign-in (§K, TAGPILOT_API_KEY set): Google consent for that key.
// Both poll the broker, so the browser can be on any machine. A tool call waits up to `authWaitMs`;
// after that it returns a "show the user this link" message while polling continues.
// Progress is reported as ConnectEvents (rendered in the terminal, and used for MCP elicitation).
import os from 'node:os';
import { log } from '../log.js';
import type { Product } from '../product.js';
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

/** Sign-in or connect is still in progress; `message` tells the assistant what to show the user. */
export class AuthPendingError extends Error {
  override name = 'AuthPendingError';
  constructor(message: string, readonly url: string) {
    super(message);
  }
}

/** The sign-in ended without a code: denied, expired or cancelled. */
export class SignInFailedError extends Error {
  override name = 'SignInFailedError';
  constructor(message: string, readonly reason: 'denied' | 'expired' | 'cancelled' = 'cancelled') {
    super(message);
  }
}

export interface AccessTokenSource {
  getAccessToken(): Promise<string>;
  /** Forget the current access token (e.g. Google answered 401) so the next call refreshes. */
  invalidateAccessToken(): void;
}

/** A sign-in in progress, as shown to the user. */
export interface PendingConnect {
  kind: 'device' | 'key';
  /** Link to open; for device connect it already carries the code. */
  url: string;
  /** Device connect: the short page to type the code on, and the code. */
  verificationUri?: string;
  userCode?: string;
  /** Epoch ms. */
  expiresAt: number;
}

export type ConnectionState =
  | { state: 'connected'; mode: 'device' | 'key'; deviceLabel?: string; keyPrefix?: string; accessTokenValidUntil?: number }
  | ({ state: 'waiting' } & PendingConnect)
  | { state: 'not_connected' }
  | { state: 'error'; message: string };

export type ConnectEvent =
  | ({ type: 'started' } & PendingConnect)
  | { type: 'connected'; label: string }
  | { type: 'failed'; reason: 'denied' | 'expired' | 'cancelled' | 'error'; message: string };

/** What the connect / connection_status tools need. */
export interface ConnectionManager {
  readonly product: Product;
  /** Starts a sign-in (or returns the one in progress). Null when already connected. */
  startConnect(): Promise<PendingConnect | null>;
  connectionState(): ConnectionState;
  /** Waits up to `ms` for a sign-in in progress to finish; returns the state afterwards. */
  waitForConnection(ms: number): Promise<ConnectionState>;
  onEvent(listener: (e: ConnectEvent) => void): () => void;
}

export type Credential = { kind: 'key'; apiKey: string } | { kind: 'device'; device: DeviceEndpoint };

export interface TokenManagerOptions {
  product: Product;
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
  info: PendingConnect;
  done: Promise<string>;
}

const keyPrefix = (key: string) => `${key.slice(0, 8)}…`;

/** The broker's device label: "<Label> · <client> on <hostname>", cut to 100 characters. */
export function deviceLabel(product: Product, client: DeviceClientInfo): string {
  return `${product.label} · ${client.name || 'MCP client'} on ${client.hostname || 'unknown device'}`.slice(0, 100);
}

export class TokenManager implements AccessTokenSource, ConnectionManager {
  private pending: Promise<PendingAuth> | null = null;
  private pendingInfo: PendingConnect | null = null;
  private lastError: string | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly abort = new AbortController();
  private readonly listeners = new Set<(e: ConnectEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly opts: TokenManagerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get product(): Product {
    return this.opts.product;
  }

  get cacheFile(): string {
    return this.opts.cache.file;
  }

  get mode(): Credential['kind'] {
    return this.opts.credential.kind;
  }

  onEvent(listener: (e: ConnectEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: ConnectEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a listener must not break the sign-in */
      }
    }
  }

  /** The cache, minus a device file without its key (unusable). */
  private readCache(): CachedToken | null {
    const cached = this.opts.cache.read();
    if (cached && this.mode === 'device' && !cached.api_key) {
      this.opts.cache.clear();
      return null;
    }
    return cached;
  }

  async getAccessToken(waitMs = this.opts.authWaitMs): Promise<string> {
    const cached = this.readCache();
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

  connectionState(): ConnectionState {
    const cached = this.readCache();
    if (cached?.refresh_token) {
      const c = this.opts.credential;
      return {
        state: 'connected',
        mode: c.kind,
        deviceLabel: cached.device_label,
        keyPrefix: c.kind === 'key' ? keyPrefix(c.apiKey) : cached.api_key ? keyPrefix(cached.api_key) : undefined,
        accessTokenValidUntil: cached.expiry,
      };
    }
    if (this.pendingInfo && this.pendingInfo.expiresAt > this.now()) return { state: 'waiting', ...this.pendingInfo };
    if (this.lastError) return { state: 'error', message: this.lastError };
    return { state: 'not_connected' };
  }

  async startConnect(): Promise<PendingConnect | null> {
    if (this.readCache()?.refresh_token) return null;
    return (await this.ensurePending()).info;
  }

  async waitForConnection(ms: number): Promise<ConnectionState> {
    const pending = this.pending;
    if (pending) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        pending.then((p) => p.done).catch(() => {}),
        new Promise((r) => {
          timer = setTimeout(r, ms);
        }),
      ]);
      clearTimeout(timer);
    }
    return this.connectionState();
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
          'The Google sign-in expired or was revoked, so the saved sign-in was removed. ' +
            'Call the connect tool (or retry the request) to get a new sign-in link for the user.',
        );
      }
      if (e instanceof KeyRejectedError && this.mode === 'device') {
        this.opts.cache.clear();
        log('Tag Pilot rejected this device\'s key (revoked?); removed the saved connection.');
        throw new ReauthRequiredError(
          `This computer was disconnected from Tag Pilot (the device was revoked on ${this.opts.product.pageUrl}), so its saved connection was removed. ` +
            'Call the connect tool (or retry the request) to get a new link for the user.',
        );
      }
      throw e;
    }
    this.save(res, this.opts.cache.read() ?? cached);
    return res.access_token;
  }

  private save(res: TokenResponse, previous: CachedToken, extra: { apiKey?: string; label?: string } = {}): void {
    const device = this.mode === 'device';
    const deviceKey = device ? (extra.apiKey ?? previous.api_key) : undefined;
    const label = device ? (extra.label ?? previous.device_label) : undefined;
    this.opts.cache.write({
      ...(deviceKey ? { api_key: deviceKey } : {}),
      ...(label ? { device_label: label } : {}),
      refresh_token: res.refresh_token ?? previous.refresh_token,
      access_token: res.access_token,
      expiry: this.now() + (res.expires_in ?? 3600) * 1000,
      scope: res.scope ?? previous.scope,
    });
  }

  private ensurePending(): Promise<PendingAuth> {
    if (!this.pending) {
      const c = this.opts.credential;
      const started = c.kind === 'device' ? this.startDeviceConnect(c.device) : this.startKeySignIn(c.apiKey);
      this.pending = started;
      this.lastError = null;
      const clear = () => {
        if (this.pending === started) {
          this.pending = null;
          this.pendingInfo = null;
        }
      };
      started.then(
        (p) => {
          this.pendingInfo = p.info;
          this.emit({ type: 'started', ...p.info });
          p.done.then(clear, (e: Error) => {
            clear();
            this.lastError = e.message;
            const reason = e instanceof SignInFailedError ? e.reason : 'error';
            this.emit({ type: 'failed', reason, message: e.message });
          });
        },
        (e: Error) => {
          clear();
          this.lastError = e.message;
          this.emit({ type: 'failed', reason: 'error', message: e.message });
        },
      );
    }
    return this.pending;
  }

  private async authorize(waitMs: number): Promise<string> {
    const { info, done } = await this.ensurePending();
    if (!Number.isFinite(waitMs)) return done;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AuthPendingError(pendingMessage(this.opts.product, info, this.now()), info.url)), waitMs);
    });
    try {
      return await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private finishSignIn(res: TokenResponse, extra: { apiKey?: string; label?: string } = {}): string {
    if (!res.refresh_token) {
      log('Warning: Google returned no refresh token; you will need to sign in again when the access token expires.');
    }
    this.save(res, {}, extra);
    const c = this.opts.credential;
    this.emit({ type: 'connected', label: extra.label ?? (c.kind === 'key' ? `TAGPILOT_API_KEY (${keyPrefix(c.apiKey)})` : this.opts.product.label) });
    return res.access_token;
  }

  // ---- device connect (D1 → D5 → D6) ----

  private async startDeviceConnect(device: DeviceEndpoint): Promise<PendingAuth> {
    const { verifier, challenge } = createPkce();
    const client: DeviceClientInfo = { name: this.opts.clientName?.() || 'CLI', version: this.opts.product.version, hostname: os.hostname() };
    const s = await device.start({ codeChallenge: challenge, client });
    const info: PendingConnect = {
      kind: 'device',
      url: s.verificationUriComplete,
      verificationUri: s.verificationUri,
      userCode: s.userCode,
      expiresAt: this.now() + s.expiresIn * 1000,
    };
    this.opts.openBrowser?.(info.url);
    const done = this.pollDevice(device, s.deviceCode, s.interval, s.expiresIn, verifier, deviceLabel(this.opts.product, client));
    done.catch(() => {}); // nobody may be waiting any more; the outcome is reported via events/state
    return { info, done };
  }

  private async pollDevice(device: DeviceEndpoint, deviceCode: string, interval: number, expiresIn: number, verifier: string, label: string): Promise<string> {
    const deadline = this.now() + expiresIn * 1000;
    let intervalMs = this.opts.pollIntervalMs ?? interval * 1000;
    let delayMs = intervalMs;
    for (;;) {
      await sleep(delayMs, this.abort.signal);
      if (this.now() >= deadline) {
        throw new SignInFailedError('The connect code expired before it was approved. Call the connect tool (or retry the request) to get a new code.', 'expired');
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
          throw new SignInFailedError('The connect code expired or was already used. Call the connect tool (or retry the request) to get a new code.', 'expired');
        case 'denied':
          throw new SignInFailedError(
            `Connecting was not completed (${r.googleError ? `Google sign-in: ${r.googleError}` : 'denied'}). Call the connect tool (or retry the request) to start over.`,
            'denied',
          );
        case 'complete': {
          const res = await this.opts.broker(r.apiKey).exchangeCode({ code: r.code, codeVerifier: verifier });
          return this.finishSignIn(res, { apiKey: r.apiKey, label });
        }
      }
    }
  }

  // ---- key sign-in (§K) ----

  private async startKeySignIn(apiKey: string): Promise<PendingAuth> {
    const endpoint = this.opts.broker(apiKey);
    const { verifier, challenge } = createPkce();
    const session = await endpoint.startSession({ codeChallenge: challenge });
    const info: PendingConnect = { kind: 'key', url: session.authorizeUrl, expiresAt: this.now() + session.expiresIn * 1000 };
    this.opts.openBrowser?.(info.url);
    const done = this.pollKeySession(endpoint, session.sessionId, session.pollInterval, session.expiresIn, verifier);
    done.catch(() => {});
    return { info, done };
  }

  private async pollKeySession(endpoint: AuthEndpoint, sessionId: string, pollInterval: number, expiresIn: number, verifier: string): Promise<string> {
    const deadline = this.now() + expiresIn * 1000;
    const intervalMs = this.opts.pollIntervalMs ?? pollInterval * 1000;
    let delayMs = intervalMs;
    for (;;) {
      await sleep(delayMs, this.abort.signal);
      if (this.now() >= deadline) {
        throw new SignInFailedError('The Google sign-in link expired before it was used. Call the connect tool (or retry the request) to get a new link.', 'expired');
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
          throw new SignInFailedError('The Google sign-in session expired or was already used. Call the connect tool (or retry the request) to get a new link.', 'expired');
        case 'error':
          throw new SignInFailedError(`Google sign-in was not completed (${result.error}). Call the connect tool (or retry the request) to get a new link.`, 'denied');
        case 'complete':
          return this.finishSignIn(await endpoint.exchangeCode({ code: result.code, codeVerifier: verifier }));
      }
    }
  }
}

const minutesLeft = (expiresAt: number, now: number) => Math.max(1, Math.round((expiresAt - now) / 60_000));

/** The link + code block for the assistant to show the user (markdown). */
export function connectInstructions(product: Product, info: PendingConnect, now: number): string {
  if (info.kind === 'device') {
    return [
      `[Connect ${product.title}](${info.url})`,
      `Code: **${info.userCode}**`,
      '',
      `Open the link (any browser, any device), sign in to or create a free Tag Pilot account, check that the code matches, approve, then allow ${product.googleAccess}. ` +
        `The link works for about ${minutesLeft(info.expiresAt, now)} min. (On another device: go to ${info.verificationUri} and type the code.)`,
    ].join('\n');
  }
  return [
    `[Sign in with Google for ${product.title}](${info.url})`,
    '',
    `Open the link (any browser, any device) and allow ${product.googleAccess}. The link works for about ${minutesLeft(info.expiresAt, now)} min.`,
  ].join('\n');
}

/** What a data tool returns while not connected yet. */
export function pendingMessage(product: Product, info: PendingConnect, now: number): string {
  const what = info.kind === 'device' ? 'Connect at the link below and check the code' : 'Sign in with Google at the link below';
  return [
    `Not connected yet. ${what}; show this to the user exactly:`,
    '',
    connectInstructions(product, info, now),
    '',
    'Ask the user to tell you when they have approved, then retry the original request (or call connection_status to check). ' +
      'Connecting keeps going in the background; do not ask the user to run terminal commands.',
  ].join('\n');
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
