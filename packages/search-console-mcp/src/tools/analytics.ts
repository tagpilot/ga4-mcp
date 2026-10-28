// search_analytics request mapping and compact rows (shared by compare_periods and find_opportunities).
import { InputError } from '../core.js';
import { resolveRange } from './dates.js';
import type { FilterInput } from './schemas.js';
import { DIMENSIONS, SEARCH_TYPES } from './schemas.js';

/** "sc-domain:example.com" stays; a URL prefix gets its trailing slash; anything else is rejected with a hint. */
export function normalizeSiteUrl(input: string): string {
  const s = input.trim();
  if (/^sc-domain:[^\s/]+$/i.test(s)) return `sc-domain:${s.slice('sc-domain:'.length).toLowerCase()}`;
  if (/^https?:\/\/[^\s]+$/i.test(s)) return s.endsWith('/') ? s : `${s}/`;
  throw new InputError(
    `"${input}" is not a Search Console property. Use "sc-domain:${s.replace(/^www\./, '')}" for a domain property or ` +
      `"https://${s}/" for a URL-prefix property, exactly as list_sites shows it.`,
  );
}

export interface AnalyticsArgs {
  start_date?: string;
  end_date?: string;
  dimensions?: Array<(typeof DIMENSIONS)[number]>;
  filters?: FilterInput[];
  search_type?: (typeof SEARCH_TYPES)[number];
  data_state?: 'final' | 'all' | 'hourly_all';
  aggregation_type?: 'auto' | 'byPage' | 'byProperty' | 'byNewsShowcasePanel';
  row_limit?: number;
  start_row?: number;
}

export const DEFAULT_ROW_LIMIT = 100;

export function buildAnalyticsRequest(a: AnalyticsArgs, today: string) {
  const { startDate, endDate } = resolveRange(a.start_date, a.end_date, today);
  const dims = a.dimensions ?? [];
  const type = a.search_type ?? 'web';
  if (dims.includes('hour') && a.data_state !== 'hourly_all') {
    throw new InputError('The "hour" dimension needs data_state "hourly_all".');
  }
  if ((type === 'discover' || type === 'googleNews') && a.aggregation_type === 'byProperty') {
    throw new InputError(`aggregation_type "byProperty" isn't supported for search_type "${type}".`);
  }
  if (new Set(dims).size !== dims.length) throw new InputError('Each dimension can appear only once.');
  const body: Record<string, unknown> = {
    startDate,
    endDate,
    dimensions: dims,
    type,
    rowLimit: a.row_limit ?? DEFAULT_ROW_LIMIT,
  };
  if (a.start_row) body.startRow = a.start_row;
  if (a.filters?.length) {
    body.dimensionFilterGroups = [
      {
        groupType: 'and',
        filters: a.filters.map((f) => ({ dimension: f.dimension, operator: f.operator ?? 'equals', expression: f.expression })),
      },
    ];
  }
  if (a.data_state && a.data_state !== 'final') body.dataState = a.data_state;
  if (a.aggregation_type && a.aggregation_type !== 'auto') body.aggregationType = a.aggregation_type;
  return body;
}

export interface AnalyticsResponse {
  rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>;
  responseAggregationType?: string;
  metadata?: { first_incomplete_date?: string; first_incomplete_hour?: string };
}

export interface MetricRow {
  clicks: number;
  impressions: number;
  /** 0–1, 4 decimals. */
  ctr: number;
  /** Average position, 1 decimal. */
  position: number;
}

/** A Search Analytics row: dimension values by name plus the metrics. */
export type DimRow = MetricRow & Record<string, string | number>;

export const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

export function toRows(res: AnalyticsResponse, dimensions: readonly string[]): DimRow[] {
  return (res.rows ?? []).map((r) => {
    const out: Record<string, string | number> = {};
    dimensions.forEach((d, i) => (out[d] = r.keys?.[i] ?? ''));
    out.clicks = r.clicks ?? 0;
    out.impressions = r.impressions ?? 0;
    out.ctr = round(r.ctr ?? 0, 4);
    out.position = round(r.position ?? 0, 1);
    return out as DimRow;
  });
}

export function analyticsNotes(body: Record<string, unknown>, res: AnalyticsResponse): string[] {
  const notes: string[] = [];
  const dims = body.dimensions as string[];
  const filters = (body.dimensionFilterGroups as Array<{ filters: Array<{ dimension: string }> }> | undefined)?.[0]?.filters ?? [];
  if (dims.includes('query') || filters.some((f) => f.dimension === 'query')) {
    notes.push('Anonymised (rare) queries are omitted when grouping or filtering by query, so these rows add up to less than the totals by date.');
  }
  if (res.metadata?.first_incomplete_date) notes.push(`Data from ${res.metadata.first_incomplete_date} on is incomplete and may still change.`);
  if (res.metadata?.first_incomplete_hour) notes.push(`Data from ${res.metadata.first_incomplete_hour} on is incomplete and may still change.`);
  return notes;
}
