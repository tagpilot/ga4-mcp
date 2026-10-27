// Hands out Google access tokens: from the cache, by refreshing (through the broker), or by running the
// browser sign-in. A tool call waits up to `authWaitMs` for the browser; after that it returns a
// "finish signing in, then retry" message while the sign-in keeps listening in the background.
import { log } from '../log.js';
import type { CachedToken, TokenCache } from './cache.js';
import { OAuthGrantError, type AuthEndpoint, type TokenResponse } from './endpoints.js';
import { startLoopback } from './loopback.js';
import { createPkce, createState } from './pkce.js';

/** The saved refresh token was rejected; the cache was cleared and the next call signs in again. */
export class ReauthRequiredError extends Error {
  override name = 'ReauthRequiredError';
}

/** The browser sign-in is still in progress. */
export class AuthPendingError extends Error {
  override name = 'AuthPendingError';
  constructor(readonly authorizeUrl: string) {
    super(
      'Waiting for you to sign in with Google. A browser window should have opened; if it did not, open this URL:\n' +
        `${authorizeUrl}\n` +
        'After you approve read-only access to Google Analytics, call the tool again.',
    );
  }
}

export interface AccessTokenSource {
  getAccessToken(): Promise<string>;
  /** Forget the current access token (e.g. Google answered 401) so the next call refreshes. */
  invalidateAccessToken(): void;
}

export interface TokenManagerOptions {
  endpoint: AuthEndpoint;
  cache: TokenCache;
  authWaitMs: number;
  port?: number;
  openBrowser?: (url: string) => void;
  now?: () => number;
}

/** Refresh this long before the access token actually expires. */
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_SESSION_SECONDS = 600;

interface PendingAuth {
  url: string;
  done: Promise<string>;
}

export class TokenManager implements AccessTokenSource {
  private pending: Promise<PendingAuth> | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: TokenManagerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get cacheFile(): string {
    return this.opts.cache.file;
  }

  async getAccessToken(waitMs = this.opts.authWaitMs): Promise<string> {
    const cached = this.opts.cache.read();
    if (cached?.access_token && cached.expiry && cached.expiry - this.now() > EXPIRY_MARGIN_MS) {
      return cached.access_token;
    }
    if (cached?.refresh_token) return this.refresh(cached.refresh_token);
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

  private refresh(refreshToken: string): Promise<string> {
    this.refreshing ??= this.doRefresh(refreshToken).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(refreshToken: string): Promise<string> {
    let res: TokenResponse;
    try {
      res = await this.opts.endpoint.refresh(refreshToken);
    } catch (e) {
      if (e instanceof OAuthGrantError && e.error === 'invalid_grant') {
        this.opts.cache.clear();
        log('Google rejected the saved refresh token (invalid_grant); cleared the token cache.');
        throw new ReauthRequiredError(
          'Your Google sign-in for GA4 expired or was revoked, so the saved token was removed. ' +
            'Call the tool again: a browser window will open to sign in with Google again.',
        );
      }
      throw e;
    }
    const current = this.opts.cache.read() ?? {};
    this.save(res, current);
    return res.access_token;
  }

  private save(res: TokenResponse, previous: CachedToken): void {
    this.opts.cache.write({
      refresh_token: res.refresh_token ?? previous.refresh_token,
      access_token: res.access_token,
      expiry: this.now() + (res.expires_in ?? 3600) * 1000,
      scope: res.scope ?? previous.scope,
    });
  }

  private async authorize(waitMs: number): Promise<string> {
    if (!this.pending) {
      const started = this.startAuthorization();
      this.pending = started;
      // A failed start, or a finished/failed flow, lets the next call begin a fresh sign-in.
      started.then(
        (p) => p.done.finally(() => { if (this.pending === started) this.pending = null; }).catch(() => {}),
        () => { if (this.pending === started) this.pending = null; },
      );
    }
    const { url, done } = await this.pending;
    if (!Number.isFinite(waitMs)) return done;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AuthPendingError(url)), waitMs);
    });
    try {
      return await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async startAuthorization(): Promise<PendingAuth> {
    const { verifier, challenge } = createPkce();
    const state = createState();
    const loopback = await startLoopback<string>({
      state,
      port: this.opts.port,
      timeoutMs: DEFAULT_SESSION_SECONDS * 1000,
      onCode: async (code, redirectUri) => {
        const res = await this.opts.endpoint.exchangeCode({ code, codeVerifier: verifier, redirectUri });
        if (!res.refresh_token) {
          log('Warning: Google returned no refresh token; you will need to sign in again when the access token expires.');
        }
        this.save(res, {});
        log('Signed in with Google. Token cached at ' + this.opts.cache.file);
        return res.access_token;
      },
    });
    let authorizeUrl: string;
    try {
      ({ authorizeUrl } = await this.opts.endpoint.startSession({ port: loopback.port, codeChallenge: challenge, state }));
    } catch (e) {
      loopback.close();
      loopback.done.catch(() => {});
      throw e;
    }
    // Keep a rejection from becoming "unhandled" when no tool call is waiting any more.
    loopback.done.catch(() => {});
    log('Sign in with Google to give read-only access to Google Analytics. If no browser window opens, visit:\n' + authorizeUrl);
    this.opts.openBrowser?.(authorizeUrl);
    return { url: authorizeUrl, done: loopback.done };
  }
}
