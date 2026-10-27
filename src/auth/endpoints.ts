// The two ways to get Google tokens:
//   BrokerEndpoint: the Tag Pilot API holds the OAuth client secret (normal use, see api-contract.md).
//   DirectGoogleEndpoint: your own Google "Desktop" OAuth client, for development only.
import { APP_URL, GA4_SCOPE } from '../config.js';
import { SetupError } from '../errors.js';
import { USER_AGENT } from '../version.js';

export interface TokenResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
}

/** Google's OAuth error (`{error, error_description}`), e.g. invalid_grant. */
export class OAuthGrantError extends Error {
  override name = 'OAuthGrantError';
  constructor(readonly error: string, readonly description?: string) {
    super(`Google token request failed: ${error}${description ? ` (${description})` : ''}`);
  }
}

export interface AuthEndpoint {
  /** Human-readable description for status output. */
  readonly label: string;
  startSession(p: { port: number; codeChallenge: string; state: string }): Promise<{ authorizeUrl: string; expiresIn?: number }>;
  exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenResponse>;
  refresh(refreshToken: string): Promise<TokenResponse>;
}

type FetchFn = typeof fetch;

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asTokenResponse(json: Record<string, unknown> | null, source: string): TokenResponse {
  if (!json || typeof json.access_token !== 'string') {
    throw new Error(`${source} returned a token response without an access_token`);
  }
  return json as unknown as TokenResponse;
}

function grantError(json: Record<string, unknown> | null): OAuthGrantError | null {
  if (json && typeof json.error === 'string') {
    return new OAuthGrantError(json.error, typeof json.error_description === 'string' ? json.error_description : undefined);
  }
  return null;
}

export class BrokerEndpoint implements AuthEndpoint {
  readonly label: string;

  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchFn = fetch,
  ) {
    this.label = `Tag Pilot broker at ${apiUrl}`;
  }

  async startSession(p: { port: number; codeChallenge: string; state: string }) {
    const json = await this.post('/integrations/v1/ga4/oauth/session', {
      redirect_port: p.port,
      code_challenge: p.codeChallenge,
      state: p.state,
    });
    if (!json || typeof json.authorize_url !== 'string') {
      throw new Error('Tag Pilot returned no authorize_url');
    }
    return {
      authorizeUrl: json.authorize_url,
      expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    };
  }

  async exchangeCode(p: { code: string; codeVerifier: string }) {
    const json = await this.post('/integrations/v1/ga4/oauth/token', {
      grant_type: 'authorization_code',
      code: p.code,
      code_verifier: p.codeVerifier,
    });
    return asTokenResponse(json, 'Tag Pilot');
  }

  async refresh(refreshToken: string) {
    const json = await this.post('/integrations/v1/ga4/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    return asTokenResponse(json, 'Tag Pilot');
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const url = `${this.apiUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
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
    switch (res.status) {
      case 400: {
        const grant = grantError(json);
        if (grant && grant.error !== 'invalid_request') throw grant;
        throw new Error(`Tag Pilot rejected the request: ${message ?? grant?.description ?? 'invalid request'}`);
      }
      case 401:
        throw new SetupError(
          `Tag Pilot rejected TAGPILOT_API_KEY (invalid or revoked). Create a new key on the GA4 MCP page at ${APP_URL} and update this server's env.`,
        );
      case 403:
        throw new SetupError(
          `TAGPILOT_API_KEY does not have the "ga4:mcp" scope. Create a key on the GA4 MCP page at ${APP_URL} (it gets the right scope) and update this server's env.`,
        );
      case 429: {
        const retry = res.headers.get('retry-after');
        throw new Error(`Tag Pilot rate limit reached for this API key. Retry in ${retry ? `${retry} s` : 'a minute'}.`);
      }
      case 502:
        throw new Error('Tag Pilot could not reach Google to exchange the sign-in token. This is usually temporary; try again shortly.');
      case 503:
        throw new SetupError('Google sign-in for the GA4 MCP is not available on this Tag Pilot server right now. Please try again later.');
      default:
        throw new Error(`Tag Pilot returned HTTP ${res.status}${message ? `: ${message}` : ''}. Please try again later.`);
    }
  }
}

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Development only: your own Google Cloud "Desktop app" OAuth client, no Tag Pilot involved. */
export class DirectGoogleEndpoint implements AuthEndpoint {
  readonly label = 'Google directly (development mode, your own OAuth client)';

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: FetchFn = fetch,
    private readonly authUrl = GOOGLE_AUTH_URL,
    private readonly tokenUrl = GOOGLE_TOKEN_URL,
  ) {}

  async startSession(p: { port: number; codeChallenge: string; state: string }) {
    const url = new URL(this.authUrl);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: `http://127.0.0.1:${p.port}/callback`,
      response_type: 'code',
      scope: GA4_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      state: p.state,
    }).toString();
    return { authorizeUrl: url.toString(), expiresIn: 600 };
  }

  exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string }) {
    return this.post({
      grant_type: 'authorization_code',
      code: p.code,
      code_verifier: p.codeVerifier,
      redirect_uri: p.redirectUri,
    });
  }

  refresh(refreshToken: string) {
    return this.post({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async post(params: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': USER_AGENT },
      body: new URLSearchParams({ ...params, client_id: this.clientId, client_secret: this.clientSecret }).toString(),
    });
    const json = await readJson(res);
    if (res.ok) return asTokenResponse(json, 'Google');
    throw grantError(json) ?? new Error(`Google token endpoint returned HTTP ${res.status}`);
  }
}
