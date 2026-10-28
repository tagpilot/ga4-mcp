// Thin fetch-based client for the Search Console API: webmasters/v3 (sites, searchAnalytics, sitemaps)
// and searchconsole/v1 (URL Inspection). Requests go straight from this machine to Google.
import { GoogleApiError, GoogleHttp, userAgent, type AccessTokenSource, type GoogleErrorBody } from '../core.js';
import { PRODUCT } from '../product.js';

export interface SearchConsoleApiOptions {
  /** Default https://www.googleapis.com/webmasters/v3 */
  webmastersApiUrl?: string;
  /** Default https://searchconsole.googleapis.com/v1 */
  inspectionApiUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface RequestContext {
  siteUrl?: string;
  /** Which quota a 429 is about. */
  kind?: 'analytics' | 'inspection' | 'other';
}

const QUOTA_HINT: Record<NonNullable<RequestContext['kind']>, string> = {
  analytics:
    'Search Analytics allows 1,200 queries per minute per site and per user, plus a "load" quota that heavy queries ' +
    '(long date ranges, grouping by query and page) use up faster. Wait a few minutes, or narrow the date range or dimensions.',
  inspection: 'URL Inspection allows 2,000 inspections per day and 600 per minute per Search Console property. Try again tomorrow or after a minute.',
  other: 'Wait a minute and try again.',
};

export function describeSearchConsoleError(status: number, body: GoogleErrorBody | null, ctx: RequestContext = {}): GoogleApiError {
  const gStatus = body?.error?.status;
  const gMessage = body?.error?.message ?? `HTTP ${status}`;
  const site = ctx.siteUrl ? `the Search Console property "${ctx.siteUrl}"` : 'this resource';
  let message: string;
  if (status === 429 || gStatus === 'RESOURCE_EXHAUSTED') {
    message = `Search Console quota exceeded for ${site}: ${gMessage}\n${QUOTA_HINT[ctx.kind ?? 'other']}`;
  } else if (status === 403 || gStatus === 'PERMISSION_DENIED') {
    message =
      `The signed-in Google account has no access to ${site} (${gMessage}). ` +
      'Use list_sites to see the properties it can read, and pass site_url exactly as listed: "sc-domain:example.com" for a domain ' +
      'property, or the URL prefix with its trailing slash ("https://www.example.com/"). To switch Google accounts run ' +
      '`npx -y @tagpilot/search-console-mcp logout` and ask again.';
  } else if (status === 404 || gStatus === 'NOT_FOUND') {
    message = `Not found: ${gMessage}. Check site_url against list_sites (exact form, including "sc-domain:" or the trailing slash).`;
  } else if (status === 400 || gStatus === 'INVALID_ARGUMENT') {
    message = `Search Console rejected the request: ${gMessage}`;
  } else if (status === 401) {
    message = `Google rejected the access token (${gMessage}). Ask again; if it keeps failing, run \`npx -y @tagpilot/search-console-mcp logout\` and connect again.`;
  } else if (status >= 500) {
    message = `Search Console API error (HTTP ${status}): ${gMessage}. This is usually temporary; retry shortly.`;
  } else {
    message = `Search Console API error (HTTP ${status}): ${gMessage}`;
  }
  return new GoogleApiError(message, status, gStatus);
}

export class SearchConsoleApi {
  private readonly webmasters: string;
  private readonly inspection: string;
  private readonly http: GoogleHttp<RequestContext>;

  constructor(tokens: AccessTokenSource, opts: SearchConsoleApiOptions = {}) {
    this.webmasters = opts.webmastersApiUrl ?? 'https://www.googleapis.com/webmasters/v3';
    this.inspection = opts.inspectionApiUrl ?? 'https://searchconsole.googleapis.com/v1';
    this.http = new GoogleHttp(tokens, describeSearchConsoleError, userAgent(PRODUCT), opts.fetchImpl);
  }

  private site(siteUrl: string): string {
    return `${this.webmasters}/sites/${encodeURIComponent(siteUrl)}`;
  }

  listSites<T>(): Promise<T> {
    return this.http.request<T>('GET', `${this.webmasters}/sites`, undefined, {});
  }

  searchAnalytics<T>(siteUrl: string, body: unknown): Promise<T> {
    return this.http.request<T>('POST', `${this.site(siteUrl)}/searchAnalytics/query`, body, { siteUrl, kind: 'analytics' });
  }

  listSitemaps<T>(siteUrl: string, sitemapIndex?: string): Promise<T> {
    const q = sitemapIndex ? `?sitemapIndex=${encodeURIComponent(sitemapIndex)}` : '';
    return this.http.request<T>('GET', `${this.site(siteUrl)}/sitemaps${q}`, undefined, { siteUrl });
  }

  getSitemap<T>(siteUrl: string, feedpath: string): Promise<T> {
    return this.http.request<T>('GET', `${this.site(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, undefined, { siteUrl });
  }

  inspectUrl<T>(body: { inspectionUrl: string; siteUrl: string; languageCode?: string }): Promise<T> {
    return this.http.request<T>('POST', `${this.inspection}/urlInspection/index:inspect`, body, { siteUrl: body.siteUrl, kind: 'inspection' });
  }
}
