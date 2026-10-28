// compare_periods and find_opportunities: opinionated analyses built from a few Search Analytics queries.
import { z } from 'zod';
import { buildAnalyticsRequest, normalizeSiteUrl, round, toRows, type AnalyticsArgs, type AnalyticsResponse, type DimRow, type MetricRow } from './analytics.js';
import { READ_ONLY, safe, type ToolContext } from './common.js';
import { addDays, daysBetween, resolveRange } from './dates.js';
import { ANONYMIZED_NOTE, DATA_LAG_NOTE, endDateSchema, filtersSchema, searchTypeSchema, siteUrlSchema, startDateSchema, type FilterInput } from './schemas.js';
import type { SearchConsoleApi } from '../google/api.js';

type Dim = 'query' | 'page';
type Row = DimRow;

const dimensionSchema = z.enum(['query', 'page']).optional().describe('Compare by "query" (default) or "page".');
const scanSchema = z
  .number()
  .int()
  .min(1)
  .max(25000)
  .optional()
  .describe('How many rows (sorted by clicks) to fetch per period. Default 5,000, max 25,000. Rows beyond this are not considered.');

async function fetchRows(api: SearchConsoleApi, site: string, args: AnalyticsArgs, today: string): Promise<{ rows: Row[]; full: boolean }> {
  const body = buildAnalyticsRequest(args, today);
  const res = await api.searchAnalytics<AnalyticsResponse>(site, body);
  const rows = toRows(res, body.dimensions as string[]);
  return { rows, full: rows.length === body.rowLimit };
}

function totalsOf(rows: Row[]): MetricRow {
  return rows[0] ? { clicks: rows[0].clicks, impressions: rows[0].impressions, ctr: rows[0].ctr, position: rows[0].position } : { clicks: 0, impressions: 0, ctr: 0, position: 0 };
}

const pct = (cur: number, prev: number) => (prev ? round(((cur - prev) / prev) * 100, 1) : null);

/** Rough organic CTR by (rounded) average position: a rule-of-thumb benchmark, not Google data. */
export const EXPECTED_CTR: Record<number, number> = { 1: 0.28, 2: 0.15, 3: 0.1, 4: 0.07, 5: 0.05, 6: 0.04, 7: 0.03, 8: 0.025, 9: 0.02, 10: 0.018 };
export const expectedCtr = (position: number) => EXPECTED_CTR[Math.min(10, Math.max(1, Math.round(position)))];

export const SORTS = ['clicks_change', 'clicks_gain', 'clicks_loss', 'impressions_change', 'position_change'] as const;

export function comparePeriods(dim: Dim, current: Row[], previous: Row[], sort: (typeof SORTS)[number], top: number) {
  const prevBy = new Map(previous.map((r) => [r[dim], r]));
  const curBy = new Map(current.map((r) => [r[dim], r]));
  const keys = new Set([...curBy.keys(), ...prevBy.keys()]);
  const rows = [...keys].map((key) => {
    const c = curBy.get(key);
    const p = prevBy.get(key);
    return {
      [dim]: key,
      status: c && p ? 'both' : c ? 'new' : 'lost',
      clicks: c?.clicks ?? 0,
      clicks_prev: p?.clicks ?? 0,
      clicks_change: (c?.clicks ?? 0) - (p?.clicks ?? 0),
      impressions: c?.impressions ?? 0,
      impressions_prev: p?.impressions ?? 0,
      impressions_change: (c?.impressions ?? 0) - (p?.impressions ?? 0),
      ctr: c?.ctr ?? null,
      ctr_prev: p?.ctr ?? null,
      position: c?.position ?? null,
      position_prev: p?.position ?? null,
      // Negative = moved up (better).
      position_change: c && p ? round(c.position - p.position, 1) : null,
    };
  });
  const by: Record<(typeof SORTS)[number], (r: (typeof rows)[number]) => number> = {
    clicks_change: (r) => -Math.abs(r.clicks_change),
    clicks_gain: (r) => -r.clicks_change,
    clicks_loss: (r) => r.clicks_change,
    impressions_change: (r) => -Math.abs(r.impressions_change),
    position_change: (r) => (r.position_change === null ? Infinity : -Math.abs(r.position_change) * Math.log10(10 + r.impressions)),
  };
  rows.sort((a, b) => by[sort](a) - by[sort](b));
  return rows.slice(0, top);
}

export function findOpportunities(rows: Row[], o: { minImpressions: number; minPosition: number; maxPosition: number; top: number }) {
  const lowCtr = rows
    .filter((r) => r.impressions >= o.minImpressions && r.position <= 10.5)
    .map((r): Row & { expected_ctr: number; potential_extra_clicks: number } => {
      const expected = expectedCtr(r.position);
      return { ...r, expected_ctr: expected, potential_extra_clicks: Math.round(r.impressions * expected - r.clicks) };
    })
    .filter((r) => r.ctr < r.expected_ctr * 0.5)
    .sort((a, b) => b.potential_extra_clicks - a.potential_extra_clicks)
    .slice(0, o.top);
  const striking = rows
    .filter((r) => r.impressions >= o.minImpressions && r.position >= o.minPosition && r.position <= o.maxPosition)
    .map((r): Row & { potential_extra_clicks_at_position_3: number } => ({ ...r, potential_extra_clicks_at_position_3: Math.max(0, Math.round(r.impressions * EXPECTED_CTR[3] - r.clicks)) }))
    .sort((a, b) => b.potential_extra_clicks_at_position_3 - a.potential_extra_clicks_at_position_3)
    .slice(0, o.top);
  return { low_ctr: lowCtr, striking_distance: striking };
}

export function registerInsightTools({ server, api, today }: ToolContext): void {
  server.registerTool(
    'compare_periods',
    {
      title: 'Compare two periods',
      description:
        'Period-over-period change by query or page: clicks, impressions, CTR and position for both periods with deltas, plus property totals ' +
        '(which include anonymised queries). Default: the last 28 days of final data vs the 28 days before. Biggest movers first. ' +
        `${DATA_LAG_NOTE} ${ANONYMIZED_NOTE} Uses 4 Search Analytics queries.`,
      inputSchema: {
        site_url: siteUrlSchema,
        dimension: dimensionSchema,
        start_date: startDateSchema,
        end_date: endDateSchema,
        compare_start_date: z.string().optional().describe('Start of the earlier period. Default: the same number of days right before start_date.'),
        compare_end_date: z.string().optional().describe('End of the earlier period. Default: the day before start_date.'),
        filters: filtersSchema,
        search_type: searchTypeSchema,
        sort: z
          .enum(SORTS)
          .optional()
          .describe('"clicks_change" (default, biggest absolute change), "clicks_gain", "clicks_loss", "impressions_change", "position_change".'),
        top: z.number().int().min(1).max(500).optional().describe('Rows to return. Default 25.'),
        rows_per_period: scanSchema,
      },
      annotations: READ_ONLY,
    },
    safe(async (a: {
      site_url: string;
      dimension?: Dim;
      start_date?: string;
      end_date?: string;
      compare_start_date?: string;
      compare_end_date?: string;
      filters?: FilterInput[];
      search_type?: AnalyticsArgs['search_type'];
      sort?: (typeof SORTS)[number];
      top?: number;
      rows_per_period?: number;
    }) => {
      const site = normalizeSiteUrl(a.site_url);
      const t = today();
      const dim: Dim = a.dimension ?? 'query';
      const cur = resolveRange(a.start_date, a.end_date, t);
      const days = daysBetween(cur.startDate, cur.endDate);
      const prev = resolveRange(a.compare_start_date ?? addDays(cur.startDate, -(days + 1)), a.compare_end_date ?? addDays(cur.startDate, -1), t);
      const base = { filters: a.filters, search_type: a.search_type };
      const limit = a.rows_per_period ?? 5000;
      const [c, p, ct, pt] = await Promise.all([
        fetchRows(api, site, { ...base, start_date: cur.startDate, end_date: cur.endDate, dimensions: [dim], row_limit: limit }, t),
        fetchRows(api, site, { ...base, start_date: prev.startDate, end_date: prev.endDate, dimensions: [dim], row_limit: limit }, t),
        fetchRows(api, site, { ...base, start_date: cur.startDate, end_date: cur.endDate, row_limit: 1 }, t),
        fetchRows(api, site, { ...base, start_date: prev.startDate, end_date: prev.endDate, row_limit: 1 }, t),
      ]);
      const curT = totalsOf(ct.rows);
      const prevT = totalsOf(pt.rows);
      const notes = dim === 'query' ? [ANONYMIZED_NOTE] : [];
      if (c.full || p.full) {
        notes.push(`Only the top ${limit} rows by clicks were fetched per period, so "new"/"lost" can also mean "outside the top ${limit}". Raise rows_per_period to check.`);
      }
      return {
        site_url: site,
        current: { start_date: cur.startDate, end_date: cur.endDate, ...curT },
        previous: { start_date: prev.startDate, end_date: prev.endDate, ...prevT },
        change: {
          clicks: curT.clicks - prevT.clicks,
          clicks_pct: pct(curT.clicks, prevT.clicks),
          impressions: curT.impressions - prevT.impressions,
          impressions_pct: pct(curT.impressions, prevT.impressions),
          ctr: round(curT.ctr - prevT.ctr, 4),
          position: round(curT.position - prevT.position, 1),
        },
        rows: comparePeriods(dim, c.rows, p.rows, a.sort ?? 'clicks_change', a.top ?? 25),
        notes,
      };
    }),
  );

  server.registerTool(
    'find_opportunities',
    {
      title: 'Find SEO opportunities',
      description:
        'Tag Pilot SEO check over one period, by query (default) or page. low_ctr: rows on page one (avg position ≤ 10) with plenty of ' +
        'impressions but a CTR under half of a typical CTR for that position, so the title/snippet likely underperforms. ' +
        'striking_distance: rows ranking around positions 5–20 (configurable) with enough impressions, where a small ranking gain ' +
        'pays off. "Typical CTR" is a rough industry benchmark curve, not Google data. ' +
        `${DATA_LAG_NOTE} ${ANONYMIZED_NOTE}`,
      inputSchema: {
        site_url: siteUrlSchema,
        dimension: z.enum(['query', 'page']).optional().describe('"query" (default) or "page".'),
        start_date: startDateSchema,
        end_date: endDateSchema,
        filters: filtersSchema,
        search_type: searchTypeSchema,
        min_impressions: z.number().int().min(1).optional().describe('Ignore rows with fewer impressions. Default 100.'),
        min_position: z.number().min(1).optional().describe('Striking distance from this average position. Default 5.'),
        max_position: z.number().min(1).optional().describe('Striking distance up to this average position. Default 20.'),
        top: z.number().int().min(1).max(200).optional().describe('Rows per list. Default 25.'),
        rows_to_scan: scanSchema,
      },
      annotations: READ_ONLY,
    },
    safe(async (a: {
      site_url: string;
      dimension?: Dim;
      start_date?: string;
      end_date?: string;
      filters?: FilterInput[];
      search_type?: AnalyticsArgs['search_type'];
      min_impressions?: number;
      min_position?: number;
      max_position?: number;
      top?: number;
      rows_to_scan?: number;
    }) => {
      const site = normalizeSiteUrl(a.site_url);
      const t = today();
      const dim: Dim = a.dimension ?? 'query';
      const range = resolveRange(a.start_date, a.end_date, t);
      const limit = a.rows_to_scan ?? 5000;
      const { rows, full } = await fetchRows(
        api,
        site,
        { start_date: range.startDate, end_date: range.endDate, dimensions: [dim], filters: a.filters, search_type: a.search_type, row_limit: limit },
        t,
      );
      const result = findOpportunities(rows, {
        minImpressions: a.min_impressions ?? 100,
        minPosition: a.min_position ?? 5,
        maxPosition: a.max_position ?? 20,
        top: a.top ?? 25,
      });
      const notes = ['potential_extra_clicks estimates use a rough benchmark CTR curve (position 1 ≈ 28%, 3 ≈ 10%, 10 ≈ 2%); treat them as a ranking, not a forecast.'];
      if (dim === 'query') notes.push(ANONYMIZED_NOTE);
      if (full) notes.push(`Only the top ${limit} rows by clicks were scanned; rows with many impressions but few clicks beyond that are missed. Raise rows_to_scan.`);
      return { site_url: site, start_date: range.startDate, end_date: range.endDate, scanned_rows: rows.length, ...result, notes };
    }),
  );
}
