// Hands out Google access tokens: from the cache, by refreshing (through the broker), or by running the
// browser sign-in. Sign-in polls the broker for the result, so the browser can be on any machine.
// A tool call waits up to `authWaitMs` for the sign-in; after that it returns a "finish signing in,
// then ask again" message while polling continues in the background until the session expires.
import { log } from '../log.js';
import type { CachedToken, TokenCache } from './cache.js';
import { OAuthGrantError, type AuthEndpoint, type TokenResponse } from './endpoints.js';
import { createPkce } from './pkce.js';

/** The saved refresh token was rejected; the cache was cleared and the next call signs in again. */
export class ReauthRequiredError extends Error {
  override name = 'ReauthRequiredError';
}

/** The browser sign-in is still in progress. */
export class AuthPendingError extends Error {
  override name = 'AuthPendingError';
  constructor(readonly authorizeUrl: string) {
    super(
      `Finish signing in with Google at ${authorizeUrl} , then ask again.\n` +
        'A browser window should have opened; if not, open the link in any browser, on any device, and approve read-only access to Google Analytics.',
    );
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

export interface TokenManagerOptions {
  endpoint: AuthEndpoint;
  cache: TokenCache;
  authWaitMs: number;
  openBrowser?: (url: string) => void;
  now?: () => number;
  /** Overrides the broker's poll_interval (tests). */
  pollIntervalMs?: number;
}

/** Refresh this long before the access token actually expires. */
const EXPIRY_MARGIN_MS = 60_000;

interface PendingAuth {
  url: string;
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

  /** Stops any background sign-in polling. */
  close(): void {
    this.abort.abort();
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
            'Ask again: the next request starts a new Google sign-in (a browser window opens).',
        );
      }
      throw e;
    }
    this.save(res, this.opts.cache.read() ?? {});
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
      const started = this.startSignIn();
      this.pending = started;
      // A failed start, or a finished/failed sign-in, lets the next call begin a fresh one.
      const clear = () => {
        if (this.pending === started) this.pending = null;
      };
      started.then((p) => p.done.then(clear, clear), clear);
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

  private async startSignIn(): Promise<PendingAuth> {
    const { verifier, challenge } = createPkce();
    const session = await this.opts.endpoint.startSession({ codeChallenge: challenge });
    log(`Sign in with Google to give read-only access to Google Analytics. Open this link in any browser:\n${session.authorizeUrl}`);
    this.opts.openBrowser?.(session.authorizeUrl);
    const done = this.pollUntilDone(session.sessionId, session.pollInterval, session.expiresIn, verifier);
    done.catch(() => {}); // nobody may be waiting any more; the next call sees the outcome via `pending`
    return { url: session.authorizeUrl, done };
  }

  private async pollUntilDone(sessionId: string, pollInterval: number, expiresIn: number, verifier: string): Promise<string> {
    const deadline = this.now() + expiresIn * 1000;
    const intervalMs = this.opts.pollIntervalMs ?? pollInterval * 1000;
    let delayMs = intervalMs;
    for (;;) {
      await sleep(delayMs, this.abort.signal);
      if (this.now() >= deadline) {
        throw new SignInFailedError('The Google sign-in link expired before it was used. Ask again to get a new link.');
      }
      const result = await this.opts.endpoint.pollResult(sessionId);
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
          throw new SignInFailedError(
            `Google sign-in was not completed (${result.error}). Ask again to get a new sign-in link.`,
          );
        case 'complete': {
          const res = await this.opts.endpoint.exchangeCode({ code: result.code, codeVerifier: verifier });
          if (!res.refresh_token) {
            log('Warning: Google returned no refresh token; you will need to sign in again when the access token expires.');
          }
          this.save(res, {});
          log(`Signed in with Google. Token cached at ${this.opts.cache.file}`);
          return res.access_token;
        }
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
