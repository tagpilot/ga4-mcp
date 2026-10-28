// Authenticated JSON calls to Google APIs, straight from this machine with the user's access token.
// A 401 refreshes the token once and retries; other errors go through a product-specific describer.
import type { AccessTokenSource } from './auth/token-manager.js';

export interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: Array<Record<string, unknown>> };
}

export class GoogleApiError extends Error {
  override name = 'GoogleApiError';
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly googleStatus?: string,
  ) {
    super(message);
  }
}

export type ErrorDescriber<C> = (status: number, body: GoogleErrorBody | null, ctx: C) => Error;

export class GoogleHttp<C = Record<string, never>> {
  constructor(
    private readonly tokens: AccessTokenSource,
    private readonly describe: ErrorDescriber<C>,
    private readonly userAgent: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T>(method: string, url: string, body: unknown, ctx: C): Promise<T> {
    const send = async (token: string) => {
      try {
        return await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            'user-agent': this.userAgent,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw new Error(`Could not reach Google (${new URL(url).host}): ${(e as Error).message}`);
      }
    };

    let res = await send(await this.tokens.getAccessToken());
    if (res.status === 401) {
      // Access token revoked or expired early: refresh once and retry.
      this.tokens.invalidateAccessToken();
      res = await send(await this.tokens.getAccessToken());
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) throw this.describe(res.status, json as GoogleErrorBody | null, ctx);
    return json as T;
  }
}
