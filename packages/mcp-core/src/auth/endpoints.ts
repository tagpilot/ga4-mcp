// Clients for the Tag Pilot token broker (explorations/ga4-mcp/api-contract.md, v3):
//   DeviceEndpoint: keyless device connect (D1 start, D5 poll), which hands out a per-device key
//   (scope ga4:mcp or gsc:mcp, by the D1 `product`).
//   BrokerEndpoint: key-authenticated calls: token exchange/refresh (D6) and the §K sign-in fallback.
// The broker holds the Google OAuth client secret; Google tokens are only passed through.
import { SetupError } from '../errors.js';
import { userAgent, type Product } from '../product.js';

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

/** Tag Pilot rejected the API key (401: invalid or revoked; 403: lacks the product's scope). */
export class KeyRejectedError extends SetupError {
  override name = 'KeyRejectedError';
  constructor(message: string, readonly status: 401 | 403) {
    super(message);
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

/** Network errors become a readable "could not reach Tag Pilot" error. */
export class UnreachableError extends Error {
  override name = 'UnreachableError';
}

async function postJson(fetchImpl: FetchFn, ua: string, apiUrl: string, path: string, body: Json, apiKey?: string) {
  let res: Response;
  try {
    res = await fetchImpl(`${apiUrl}${path}`, {
      method: 'POST',
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': ua,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new UnreachableError(`Could not reach Tag Pilot at ${apiUrl} (${(e as Error).message}). Check your connection and TAGPILOT_API_URL.`);
  }
  return { res, json: await readJson(res) };
}

export class BrokerEndpoint implements AuthEndpoint {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly product: Product,
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
      if (e instanceof UnreachableError) return { status: 'retry', reason: e.message };
      throw e;
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
    const { res, json } = await postJson(this.fetchImpl, userAgent(this.product), this.apiUrl, path, body, this.apiKey);
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
        throw new KeyRejectedError(
          `Tag Pilot rejected TAGPILOT_API_KEY (invalid or revoked). Create a new key at ${this.product.pageUrl} and update this server's env, or remove TAGPILOT_API_KEY to connect this device in the browser instead.`,
          401,
        );
      case 403:
        throw new KeyRejectedError(
          `TAGPILOT_API_KEY does not have the "${this.product.keyScope}" scope. Create a key at ${this.product.pageUrl} (it gets the right scope) and update this server's env.`,
          403,
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
        throw new BrokerError(`Google sign-in for ${this.product.title} is not available on this Tag Pilot server right now. Please try again later.`, 503);
      default:
        throw new BrokerError(`Tag Pilot returned HTTP ${res.status}${message ? `: ${message}` : ''}. Please try again later.`, res.status);
    }
  }
}

// ---------- device connect (D1, D5) ----------

export interface DeviceClientInfo {
  name?: string;
  version?: string;
  hostname?: string;
}

export interface DeviceSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Seconds between polls. */
  interval: number;
  /** Seconds until the session expires. */
  expiresIn: number;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'complete'; apiKey: string; code: string }
  | { status: 'denied'; googleError?: string }
  | { status: 'expired' }
  | { status: 'retry'; reason: string; afterSeconds?: number };

const clip = (s: string | undefined) => (s ? s.slice(0, 64) : undefined);

export class DeviceEndpoint {
  constructor(
    private readonly apiUrl: string,
    private readonly product: Product,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  async start(p: { codeChallenge: string; client: DeviceClientInfo }): Promise<DeviceSession> {
    const client = Object.fromEntries(
      Object.entries({ name: clip(p.client.name), version: clip(p.client.version), hostname: clip(p.client.hostname) }).filter(([, v]) => v),
    );
    const { res, json } = await postJson(this.fetchImpl, userAgent(this.product), this.apiUrl, '/v3/public/ga4/device', {
      product: this.product.id,
      code_challenge: p.codeChallenge,
      client,
    });
    if (!res.ok) {
      if (res.status === 429) {
        throw new BrokerError('Too many connect attempts from this network. Wait a few minutes, then ask again.', 429, Number(res.headers.get('retry-after')) || undefined);
      }
      if (res.status === 503) {
        throw new BrokerError(`Connecting ${this.product.title} is not available right now. Please try again later.`, 503);
      }
      const message = json && typeof json.message === 'string' ? `: ${json.message}` : '';
      throw new BrokerError(`Tag Pilot returned HTTP ${res.status}${message} when starting the connect.`, res.status);
    }
    const str = (k: string) => (json && typeof json[k] === 'string' ? (json[k] as string) : undefined);
    const num = (k: string) => (json && typeof json[k] === 'number' && (json[k] as number) > 0 ? (json[k] as number) : undefined);
    const deviceCode = str('device_code');
    const userCode = str('user_code');
    const verificationUri = str('verification_uri');
    if (!deviceCode || !userCode || !verificationUri) throw new Error('Tag Pilot returned an incomplete device session');
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: str('verification_uri_complete') ?? verificationUri,
      interval: num('interval') ?? 2,
      expiresIn: num('expires_in') ?? 600,
    };
  }

  async poll(deviceCode: string): Promise<DevicePollResult> {
    let res: Response;
    let json: Json | null;
    try {
      ({ res, json } = await postJson(this.fetchImpl, userAgent(this.product), this.apiUrl, '/v3/public/ga4/device/token', { device_code: deviceCode }));
    } catch (e) {
      if (e instanceof UnreachableError) return { status: 'retry', reason: e.message };
      throw e;
    }
    if (res.ok && json?.status === 'complete' && typeof json.api_key === 'string' && typeof json.code === 'string') {
      return { status: 'complete', apiKey: json.api_key, code: json.code };
    }
    if (res.status === 400) {
      switch (json?.error) {
        case 'authorization_pending':
          return { status: 'pending' };
        case 'slow_down':
          return { status: 'slow_down' };
        case 'access_denied':
          return { status: 'denied', googleError: typeof json.google_error === 'string' ? json.google_error : undefined };
        case 'expired_token':
          return { status: 'expired' };
      }
    }
    if (res.status === 429 || res.status >= 500) {
      return { status: 'retry', reason: `HTTP ${res.status}`, afterSeconds: Number(res.headers.get('retry-after')) || undefined };
    }
    throw new Error(`Tag Pilot returned an unexpected answer while connecting (HTTP ${res.status}).`);
  }
}
