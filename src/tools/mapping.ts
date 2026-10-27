// Tool input → GA4 REST request bodies, and GA4 responses → compact rows.
import { InputError } from '../errors.js';
import type { Condition, Filter, Matcher } from './schemas.js';
import { NUMERIC_OPS, STRING_OPS } from './schemas.js';

export function normalizePropertyId(id: string | number): string {
  const s = String(id).trim().replace(/^properties\//, '');
  if (!/^\d+$/.test(s)) {
    throw new InputError(
      `"${id}" is not a GA4 property ID. Use the numeric property ID (e.g. "123456789"); measurement IDs like G-XXXX won't work. get_account_summaries lists the IDs.`,
    );
  }
  return s;
}

export interface DateRangeInput {
  start_date: string;
  end_date: string;
  name?: string;
}

export const DEFAULT_DATE_RANGES: DateRangeInput[] = [{ start_date: '28daysAgo', end_date: 'yesterday' }];

const DATE_RE = /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d+daysAgo)$/;

export function toDateRanges(ranges: DateRangeInput[] | undefined) {
  return (ranges?.length ? ranges : DEFAULT_DATE_RANGES).map((r) => {
    for (const d of [r.start_date, r.end_date]) {
      if (!DATE_RE.test(d)) throw new InputError(`Invalid date "${d}". Use YYYY-MM-DD, "today", "yesterday" or "NdaysAgo".`);
    }
    return { startDate: r.start_date, endDate: r.end_date, ...(r.name ? { name: r.name } : {}) };
  });
}

const STRING_MATCH: Record<(typeof STRING_OPS)[number], string> = {
  exact: 'EXACT',
  contains: 'CONTAINS',
  begins_with: 'BEGINS_WITH',
  ends_with: 'ENDS_WITH',
  full_regex: 'FULL_REGEXP',
  partial_regex: 'PARTIAL_REGEXP',
};

const NUMERIC_MATCH: Record<(typeof NUMERIC_OPS)[number], string> = {
  eq: 'EQUAL',
  lt: 'LESS_THAN',
  lte: 'LESS_THAN_OR_EQUAL',
  gt: 'GREATER_THAN',
  gte: 'GREATER_THAN_OR_EQUAL',
};

export function numericValue(v: number | string | undefined, what: string) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n === undefined || !Number.isFinite(n)) throw new InputError(`${what} needs a numeric value.`);
  return Number.isInteger(n) ? { int64Value: String(n) } : { doubleValue: n };
}

/** The type-specific part of a GA4 Filter (stringFilter, inListFilter, ...). */
export function toMatcher(m: Matcher, what: string, allowEmpty = true): Record<string, unknown> {
  const op = m.op;
  if ((STRING_OPS as readonly string[]).includes(op)) {
    if (m.value === undefined || m.value === '') throw new InputError(`${what}: op "${op}" needs a "value".`);
    return {
      stringFilter: {
        matchType: STRING_MATCH[op as (typeof STRING_OPS)[number]],
        value: String(m.value),
        caseSensitive: m.case_sensitive ?? false,
      },
    };
  }
  if ((NUMERIC_OPS as readonly string[]).includes(op)) {
    return { numericFilter: { operation: NUMERIC_MATCH[op as (typeof NUMERIC_OPS)[number]], value: numericValue(m.value, `${what} (${op})`) } };
  }
  switch (op) {
    case 'in_list':
      if (!m.values?.length) throw new InputError(`${what}: op "in_list" needs "values".`);
      return { inListFilter: { values: m.values, caseSensitive: m.case_sensitive ?? false } };
    case 'between':
      return { betweenFilter: { fromValue: numericValue(m.from, `${what} (between from)`), toValue: numericValue(m.to, `${what} (between to)`) } };
    case 'empty':
      if (!allowEmpty) throw new InputError(`${what}: op "empty" is not supported here.`);
      return { emptyFilter: {} };
  }
  throw new InputError(`${what}: unknown op "${op}".`);
}

function conditionExpression(c: Condition): Record<string, unknown> {
  const filter = { filter: { fieldName: c.field, ...toMatcher(c, `filter on "${c.field}"`) } };
  return c.not ? { notExpression: filter } : filter;
}

/** Compact filter list (AND of conditions / {any} OR-groups) → GA4 FilterExpression. */
export function toFilterExpression(items: Filter): Record<string, unknown> {
  if (!Array.isArray(items) || !items.length) throw new InputError('A filter is a non-empty list of conditions.');
  const exprs = items.map((item) => {
    if ('any' in item) {
      const ors = item.any.map(conditionExpression);
      return ors.length === 1 ? ors[0] : { orGroup: { expressions: ors } };
    }
    return conditionExpression(item);
  });
  return exprs.length === 1 ? exprs[0] : { andGroup: { expressions: exprs } };
}

export interface OrderByInput {
  field: string;
  desc?: boolean;
  dimension_order?: 'alphanumeric' | 'case_insensitive_alphanumeric' | 'numeric';
}

const DIMENSION_ORDER = {
  alphanumeric: 'ALPHANUMERIC',
  case_insensitive_alphanumeric: 'CASE_INSENSITIVE_ALPHANUMERIC',
  numeric: 'NUMERIC',
} as const;

export function toOrderBys(orderBys: OrderByInput[] | undefined, metrics: string[]) {
  return orderBys?.map((o) =>
    metrics.includes(o.field)
      ? { metric: { metricName: o.field }, desc: o.desc ?? false }
      : {
          dimension: { dimensionName: o.field, ...(o.dimension_order ? { orderType: DIMENSION_ORDER[o.dimension_order] } : {}) },
          desc: o.desc ?? false,
        },
  );
}

// ---- responses ----

interface Header {
  name: string;
  type?: string;
}
interface Row {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
}
export interface ReportResponse {
  dimensionHeaders?: Header[];
  metricHeaders?: Header[];
  rows?: Row[];
  totals?: Row[];
  maximums?: Row[];
  minimums?: Row[];
  rowCount?: number;
  metadata?: {
    currencyCode?: string;
    timeZone?: string;
    subjectToThresholding?: boolean;
    dataLossFromOtherRow?: boolean;
    emptyReason?: string;
    samplingMetadatas?: Array<{ samplesReadCount?: string; samplingSpaceSize?: string }>;
  };
  propertyQuota?: Record<string, unknown>;
}

export function parseMetric(value: string | undefined, type: string | undefined): number | string | null {
  if (value === undefined) return null;
  const n = type === 'TYPE_INTEGER' ? Number.parseInt(value, 10) : Number.parseFloat(value);
  return Number.isNaN(n) ? value : n;
}

export type CompactRow = Record<string, string | number | null>;

export function toRows(res: Pick<ReportResponse, 'dimensionHeaders' | 'metricHeaders'>, rows: Row[] | undefined): CompactRow[] {
  const dims = res.dimensionHeaders ?? [];
  const mets = res.metricHeaders ?? [];
  return (rows ?? []).map((r) => {
    const out: CompactRow = {};
    dims.forEach((h, i) => (out[h.name] = r.dimensionValues?.[i]?.value ?? null));
    mets.forEach((h, i) => (out[h.name] = parseMetric(r.metricValues?.[i]?.value, h.type)));
    return out;
  });
}

/** Human-readable caveats from response metadata. */
export function reportNotes(meta: ReportResponse['metadata']): string[] {
  const notes: string[] = [];
  if (!meta) return notes;
  if (meta.subjectToThresholding) {
    notes.push('Subject to thresholding: GA4 may withhold rows with few users (Google signals / demographics). Totals can be lower than in the GA4 UI.');
  }
  if (meta.dataLossFromOtherRow) {
    notes.push('High cardinality: some values were grouped into "(other)". Narrow the date range or add filters.');
  }
  for (const s of meta.samplingMetadatas ?? []) {
    notes.push(`Sampled: based on ${s.samplesReadCount} of ${s.samplingSpaceSize} events.`);
  }
  if (meta.emptyReason) notes.push(`Empty result: ${meta.emptyReason}`);
  return notes;
}

/** Shared compact result shape for run_report and run_realtime_report. */
export function compactReport(res: ReportResponse, opts: { offset?: number } = {}) {
  const rows = toRows(res, res.rows);
  const rowCount = res.rowCount ?? rows.length;
  const offset = opts.offset ?? 0;
  const out: Record<string, unknown> = { row_count: rowCount, returned: rows.length };
  if (offset + rows.length < rowCount) out.next_offset = offset + rows.length;
  out.rows = rows;
  if (res.totals?.length) out.totals = toRows(res, res.totals);
  if (res.maximums?.length) out.maximums = toRows(res, res.maximums);
  if (res.minimums?.length) out.minimums = toRows(res, res.minimums);
  if (res.metadata?.currencyCode) out.currency_code = res.metadata.currencyCode;
  if (res.metadata?.timeZone) out.time_zone = res.metadata.timeZone;
  const notes = reportNotes(res.metadata);
  if (notes.length) out.notes = notes;
  if (res.propertyQuota) out.property_quota = res.propertyQuota;
  return out;
}
