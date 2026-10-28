// search_analytics: the Search Analytics query with compact rows.
import { z } from 'zod';
import { analyticsNotes, buildAnalyticsRequest, normalizeSiteUrl, toRows, type AnalyticsArgs, type AnalyticsResponse } from './analytics.js';
import { READ_ONLY, safe, type ToolContext } from './common.js';
import {
  ANONYMIZED_NOTE,
  DATA_LAG_NOTE,
  DIMENSIONS,
  dataStateSchema,
  endDateSchema,
  filtersSchema,
  searchTypeSchema,
  siteUrlSchema,
  startDateSchema,
} from './schemas.js';

export const searchAnalyticsShape = {
  site_url: siteUrlSchema,
  start_date: startDateSchema,
  end_date: endDateSchema,
  dimensions: z
    .array(z.enum(DIMENSIONS))
    .max(7)
    .optional()
    .describe('Group by these, e.g. ["query"], ["page"], ["date"], ["query", "page"]. None: one row with the property totals. "hour" needs data_state "hourly_all".'),
  filters: filtersSchema,
  search_type: searchTypeSchema,
  data_state: dataStateSchema,
  aggregation_type: z
    .enum(['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'])
    .optional()
    .describe('"auto" (default): by property, or by page when grouping/filtering by page. "byPage" counts each URL separately (totals differ from by property).'),
  row_limit: z.number().int().min(1).max(25000).optional().describe('Rows to return, 1–25,000. Default 100.'),
  start_row: z.number().int().min(0).optional().describe('Zero-based row offset for paging (use next_start_row from a previous result).'),
};

export function registerSearchAnalyticsTool({ server, api, today }: ToolContext): void {
  server.registerTool(
    'search_analytics',
    {
      title: 'Search performance (Search Analytics)',
      description:
        'Clicks, impressions, CTR (0–1) and average position from Google Search, grouped by date, query, page, country, device or search ' +
        `appearance, with filters and paging. Defaults: last 28 days of final data, web search, 100 rows sorted by clicks. ${DATA_LAG_NOTE} ` +
        `${ANONYMIZED_NOTE} Google exposes at most 50,000 rows per day per search type.`,
      inputSchema: searchAnalyticsShape,
      annotations: READ_ONLY,
    },
    safe(async (args: AnalyticsArgs & { site_url: string }) => {
      const site = normalizeSiteUrl(args.site_url);
      const body = buildAnalyticsRequest(args, today());
      const res = await api.searchAnalytics<AnalyticsResponse>(site, body);
      const rows = toRows(res, body.dimensions as string[]);
      const out: Record<string, unknown> = {
        site_url: site,
        start_date: body.startDate,
        end_date: body.endDate,
        search_type: body.type,
        returned: rows.length,
      };
      if (rows.length === body.rowLimit) out.next_start_row = (args.start_row ?? 0) + rows.length;
      out.rows = rows;
      if (res.responseAggregationType) out.aggregation = res.responseAggregationType;
      const notes = analyticsNotes(body, res);
      if (notes.length) out.notes = notes;
      return out;
    }),
  );
}
