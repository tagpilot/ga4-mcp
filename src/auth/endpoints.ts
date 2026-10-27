// Client for the Tag Pilot token broker (explorations/ga4-mcp/api-contract.md, v2: polling sign-in).
// The broker holds the Google OAuth client secret; Google tokens are only passed through.
import { APP_URL } from '../config.js';
import { SetupError } from '../errors.js';
import { USER_AGENT } from '../version.js';

export interface TokenResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
}

export interface SignInSession {
  sessionId: string;
  authorizeUrl: string;
  /** Seconds between result polls. */
  pollInterval: number;
  /** Seconds until the session expires. */
  expiresIn: number;
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'complete'; code: string }
  | { status: 'error'; error: string }
  /** Unknown, expired or already collected. */
  | { status: 'not_found' }
  /** Temporary trouble (network, rate limit, 5xx): poll again later. */
  | { status: 'retry'; reason: string; afterSeconds?: number };

/** Google's OAuth error (`{error, error_description}`), e.g. invalid_grant. */
export class OAuthGrantError extends Error {
  override name = 'OAuthGrantError';
  constructor(readonly error: string, readonly description?: string) {
    super(`Google token request failed: ${error}${description ? ` (${description})` : ''}`);
  }
}

/** A broker answer that isn't a success; `message` is already user-facing. */
export class BrokerError extends Error {
  override name = 'BrokerError';
  constructor(message: string, readonly status: number, readonly retryAfter?: number) {
    super(message);
  }
}

export interface AuthEndpoint {
  startSession(p: { codeChallenge: string }): Promise<SignInSession>;
  pollResult(sessionId: string): Promise<PollResult>;
  exchangeCode(p: { code: string; codeVerifier: string }): Promise<TokenResponse>;
  refresh(refreshToken: string): Promise<TokenResponse>;
}

type FetchFn = typeof fetch;
type Json = Record<string, unknown>;

async function readJson(res: Response): Promise<Json | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

function asTokenResponse(json: Json | null): TokenResponse {
  if (!json || typeof json.access_token !== 'string') {
    throw new Error('Tag Pilot returned a token response without an access_token');
  }
  return json as unknown as TokenResponse;
}

export class BrokerEndpoint implements AuthEndpoint {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  async startSession(p: { codeChallenge: string }): Promise<SignInSession> {
    const json = await this.post('/integrations/v1/ga4/oauth/session', { code_challenge: p.codeChallenge });
    if (!json || typeof json.session_id !== 'string' || typeof json.authorize_url !== 'string') {
      throw new Error('Tag Pilot returned an incomplete sign-in session');
    }
    return {
      sessionId: json.session_id,
      authorizeUrl: json.authorize_url,
      pollInterval: typeof json.poll_interval === 'number' && json.poll_interval > 0 ? json.poll_interval : 2,
      expiresIn: typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 600,
    };
  }

  async pollResult(sessionId: string): Promise<PollResult> {
    let json: Json | null;
    try {
      json = await this.post(`/integrations/v1/ga4/oauth/session/${encodeURIComponent(sessionId)}/result`, {});
    } catch (e) {
      if (e instanceof BrokerError) {
        if (e.status === 404) return { status: 'not_found' };
        if (e.status === 429 || e.status >= 500) return { status: 'retry', reason: e.message, afterSeconds: e.retryAfter };
      }
      if (e instanceof BrokerError || e instanceof SetupError) throw e;
      return { status: 'retry', reason: (e as Error).message }; // network
    }
    switch (json?.status) {
      case 'pending':
        return { status: 'pending' };
      case 'complete':
        if (typeof json.code === 'string' && json.code) return { status: 'complete', code: json.code };
        break;
      case 'error':
        return { status: 'error', error: typeof json.error === 'string' ? json.error : 'unknown_error' };
    }
    throw new Error('Tag Pilot returned an unexpected sign-in status');
  }

  async exchangeCode(p: { code: string; codeVerifier: string }) {
    return asTokenResponse(
      await this.post('/integrations/v1/ga4/oauth/token', { grant_type: 'authorization_code', code: p.code, code_verifier: p.codeVerifier }),
    );
  }

  async refresh(refreshToken: string) {
    return asTokenResponse(await this.post('/integrations/v1/ga4/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken }));
  }

  private async post(path: string, body: Json): Promise<Json | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`Could not reach Tag Pilot at ${this.apiUrl} (${(e as Error).message}). Check your connection and TAGPILOT_API_URL.`);
    }
    const json = await readJson(res);
    if (res.ok) return json;

    const message = json && typeof json.message === 'string' ? json.message : undefined;
    const error = json && typeof json.error === 'string' ? json.error : undefined;
    switch (res.status) {
      case 400:
        if (error && error !== 'invalid_request') {
          throw new OAuthGrantError(error, typeof json?.error_description === 'string' ? json.error_description : undefined);
        }
        throw new BrokerError(`Tag Pilot rejected the request: ${message ?? 'invalid request'}`, 400);
      case 401:
        throw new SetupError(
          `Tag Pilot rejected TAGPILOT_API_KEY (invalid or revoked). Create a new key on the GA4 MCP page at ${APP_URL} and update this server's env.`,
        );
      case 403:
        throw new SetupError(
          `TAGPILOT_API_KEY does not have the "ga4:mcp" scope. Create a key on the GA4 MCP page at ${APP_URL} (it gets the right scope) and update this server's env.`,
        );
      case 404:
        throw new BrokerError('Not found', 404);
      case 429: {
        const retry = Number(res.headers.get('retry-after')) || undefined;
        throw new BrokerError(`Tag Pilot rate limit reached for this API key. Retry in ${retry ? `${retry} s` : 'a minute'}.`, 429, retry);
      }
      case 502:
        throw new BrokerError('Tag Pilot could not reach Google to exchange the sign-in token. This is usually temporary; try again shortly.', 502);
      case 503:
        throw new BrokerError('Google sign-in for the GA4 MCP is not available on this Tag Pilot server right now. Please try again later.', 503);
      default:
        throw new BrokerError(`Tag Pilot returned HTTP ${res.status}${message ? `: ${message}` : ''}. Please try again later.`, res.status);
    }
  }
}
