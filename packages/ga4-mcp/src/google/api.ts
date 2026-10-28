// Thin fetch-based client for the GA4 Admin and Data REST APIs. Requests go straight from this
// machine to Google with the user's own access token.
import { GoogleApiError, GoogleHttp, userAgent, type AccessTokenSource, type GoogleErrorBody } from '../core.js';
import { PRODUCT } from '../product.js';

export interface GoogleApiOptions {
  adminApiUrl?: string;
  dataApiUrl?: string;
  fetchImpl?: typeof fetch;
}


export interface RequestContext {
  /** Numeric property ID, used to make 403/404 errors specific. */
  propertyId?: string;
}

const SCHEMA_URL = 'https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema';

export function describeGoogleError(status: number, body: GoogleErrorBody | null, ctx: RequestContext = {}): GoogleApiError {
  const gStatus = body?.error?.status;
  const gMessage = body?.error?.message ?? `HTTP ${status}`;
  const prop = ctx.propertyId ? `property ${ctx.propertyId}` : 'this resource';
  const disabledApi = body?.error?.details?.some((d) => d.reason === 'SERVICE_DISABLED') || /has not been used in project|is disabled/i.test(gMessage);

  let message: string;
  if (status === 429 || gStatus === 'RESOURCE_EXHAUSTED') {
    message =
      `GA4 quota exhausted for ${prop}: ${gMessage}\n` +
      'GA4 Data API quotas are per property and refill hourly and daily. Retry in a few minutes, or make the request cheaper ' +
      '(shorter date range, fewer dimensions, lower limit). Pass return_property_quota: true to see the remaining tokens.';
  } else if (status === 403 && disabledApi) {
    message = `Google API not enabled: ${gMessage}\n(Development mode: enable the Google Analytics Admin API and Data API in your own Google Cloud project.)`;
  } else if (status === 403 || gStatus === 'PERMISSION_DENIED') {
    message =
      `The signed-in Google account has no access to ${prop} (${gMessage}). ` +
      'It needs at least the Viewer role on that GA4 property. Use get_account_summaries to list the properties this account can read; ' +
      'to switch accounts run `npx -y @tagpilot/ga4-mcp logout` and call a tool again.';
  } else if (status === 404 || gStatus === 'NOT_FOUND') {
    message = `Not found: ${gMessage}. Pass the numeric GA4 property ID (e.g. "123456789"), not the measurement ID (G-XXXX); get_account_summaries lists them.`;
  } else if (status === 400 || gStatus === 'INVALID_ARGUMENT') {
    message =
      `GA4 rejected the request: ${gMessage}\n` +
      `Check the dimension and metric API names (standard ones: ${SCHEMA_URL}; custom ones: get_custom_dimensions_and_metrics) ` +
      'and that they can be used together.';
  } else if (status === 401) {
    message = `Google rejected the access token (${gMessage}). Call the tool again; if it keeps failing, run \`npx -y @tagpilot/ga4-mcp logout\` and sign in again.`;
  } else if (status >= 500) {
    message = `Google Analytics API error (HTTP ${status}): ${gMessage}. This is usually temporary; retry shortly.`;
  } else {
    message = `Google Analytics API error (HTTP ${status}): ${gMessage}`;
  }
  return new GoogleApiError(message, status, gStatus);
}

export class GoogleApi {
  private readonly adminApiUrl: string;
  private readonly dataApiUrl: string;
  private readonly http: GoogleHttp<RequestContext>;

  constructor(tokens: AccessTokenSource, opts: GoogleApiOptions = {}) {
    this.adminApiUrl = opts.adminApiUrl ?? 'https://analyticsadmin.googleapis.com';
    this.dataApiUrl = opts.dataApiUrl ?? 'https://analyticsdata.googleapis.com';
    this.http = new GoogleHttp(tokens, describeGoogleError, userAgent(PRODUCT), opts.fetchImpl);
  }

  /** GET on the Admin API, e.g. admin('v1beta', '/accountSummaries'). */
  admin<T>(version: 'v1beta' | 'v1alpha', path: string, query?: Record<string, string>, ctx?: RequestContext): Promise<T> {
    const url = new URL(`${this.adminApiUrl}/${version}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return this.request<T>('GET', url.toString(), undefined, ctx);
  }

  /** Follows nextPageToken and concatenates `field` across pages. */
  async adminList<T>(version: 'v1beta' | 'v1alpha', path: string, field: string, ctx?: RequestContext, maxPages = 50): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.admin<Record<string, unknown>>(version, path, { pageSize: '200', ...(pageToken ? { pageToken } : {}) }, ctx);
      const items = page[field];
      if (Array.isArray(items)) out.push(...(items as T[]));
      pageToken = typeof page.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : undefined;
      if (!pageToken) break;
    }
    return out;
  }

  /** GET on the Data API (metadata). */
  dataGet<T>(version: 'v1beta' | 'v1alpha', path: string, ctx?: RequestContext): Promise<T> {
    return this.request<T>('GET', `${this.dataApiUrl}/${version}${path}`, undefined, ctx);
  }

  /** POST on the Data API, e.g. data('v1beta', '/properties/1:runReport', body). */
  data<T>(version: 'v1beta' | 'v1alpha', path: string, body: unknown, ctx?: RequestContext): Promise<T> {
    return this.request<T>('POST', `${this.dataApiUrl}/${version}${path}`, body, ctx);
  }

  private request<T>(method: string, url: string, body: unknown, ctx: RequestContext = {}): Promise<T> {
    return this.http.request<T>(method, url, body, ctx);
  }
}
