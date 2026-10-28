// inspect_url: the URL Inspection API (Google's indexed version of one URL).
import { z } from 'zod';
import { normalizeSiteUrl } from './analytics.js';
import { READ_ONLY, safe, type ToolContext } from './common.js';
import { siteUrlSchema } from './schemas.js';

interface InspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: {
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
    googleCanonical?: string;
    userCanonical?: string;
    crawledAs?: string;
    sitemap?: string[];
    referringUrls?: string[];
  };
  richResultsResult?: { verdict?: string; detectedItems?: Array<{ richResultType?: string; items?: Array<{ name?: string; issues?: Array<{ issueMessage?: string; severity?: string }> }> }> };
  ampResult?: { verdict?: string; indexStatusVerdict?: string; ampUrl?: string };
}

export function compactInspection(r: InspectionResult) {
  const idx = r.indexStatusResult ?? {};
  const out: Record<string, unknown> = {
    verdict: idx.verdict,
    coverage_state: idx.coverageState,
    indexing_state: idx.indexingState,
    robots_txt_state: idx.robotsTxtState,
    page_fetch_state: idx.pageFetchState,
    last_crawl_time: idx.lastCrawlTime,
    crawled_as: idx.crawledAs,
    google_canonical: idx.googleCanonical,
    user_canonical: idx.userCanonical,
  };
  if (idx.googleCanonical && idx.userCanonical && idx.googleCanonical !== idx.userCanonical) out.canonical_mismatch = true;
  if (idx.sitemap?.length) out.sitemaps = idx.sitemap;
  if (idx.referringUrls?.length) out.referring_urls = idx.referringUrls.slice(0, 10);
  if (r.richResultsResult) {
    out.rich_results = {
      verdict: r.richResultsResult.verdict,
      types: (r.richResultsResult.detectedItems ?? []).map((d) => ({
        type: d.richResultType,
        items: d.items?.length ?? 0,
        issues: (d.items ?? []).flatMap((i) => (i.issues ?? []).map((x) => `${x.severity ?? 'ISSUE'}: ${x.issueMessage}`)).slice(0, 10),
      })),
    };
  }
  if (r.ampResult) out.amp = { verdict: r.ampResult.verdict, url: r.ampResult.ampUrl };
  out.inspection_result_link = r.inspectionResultLink;
  return out;
}

export function registerInspectTool({ server, api }: ToolContext): void {
  server.registerTool(
    'inspect_url',
    {
      title: 'Inspect a URL (index status)',
      description:
        "URL Inspection: Google's indexed version of one URL in the property: indexing verdict and coverage state, last crawl, " +
        'robots.txt and fetch state, Google-selected vs declared canonical, sitemaps and referring URLs, rich results. It is not a ' +
        'live test. Quota: 2,000 inspections per day and 600 per minute per property, so inspect a handful of important URLs, not whole sitemaps.',
      inputSchema: {
        site_url: siteUrlSchema,
        url: z.string().url().describe('Full URL to inspect; it must belong to site_url.'),
        language_code: z.string().optional().describe('Language for the messages (BCP-47, e.g. "pl"). Default "en-US".'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ site_url, url, language_code }) => {
      const site = normalizeSiteUrl(site_url);
      const res = await api.inspectUrl<{ inspectionResult?: InspectionResult }>({
        inspectionUrl: url,
        siteUrl: site,
        ...(language_code ? { languageCode: language_code } : {}),
      });
      return { url, site_url: site, ...compactInspection(res.inspectionResult ?? {}) };
    }),
  );
}
