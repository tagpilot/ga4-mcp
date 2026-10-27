// Data API report tools: run_report, run_realtime_report, run_funnel_report.
import { z } from 'zod';
import { InputError } from '../errors.js';
import { READ_ONLY, safe, type ToolContext } from './common.js';
import {
  compactReport,
  normalizePropertyId,
  reportNotes,
  toDateRanges,
  toFilterExpression,
  toMatcher,
  toOrderBys,
  toRows,
  type DateRangeInput,
  type OrderByInput,
  type ReportResponse,
} from './mapping.js';
import {
  conditionSchema,
  dateRangesSchema,
  filterSchema,
  limitSchema,
  orderBySchema,
  propertyIdSchema,
  returnQuotaSchema,
  OPS,
  type Filter,
} from './schemas.js';

export const DEFAULT_LIMIT = 100;
const SCHEMA_URL = 'https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema';
const REALTIME_SCHEMA_URL = 'https://developers.google.com/analytics/devguides/reporting/data/v1/realtime-api-schema';

// ---------- run_report ----------

export const runReportShape = {
  property_id: propertyIdSchema,
  date_ranges: dateRangesSchema,
  dimensions: z
    .array(z.string())
    .max(9)
    .optional()
    .describe(
      `Dimension API names, e.g. "date", "eventName", "sessionSourceMedium", "sessionDefaultChannelGroup", "pagePath", "country", "deviceCategory", "transactionId", "itemName". Full list: ${SCHEMA_URL}. Custom ones: get_custom_dimensions_and_metrics.`,
    ),
  metrics: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe('Metric API names, e.g. "activeUsers", "sessions", "eventCount", "keyEvents", "ecommercePurchases", "purchaseRevenue", "engagementRate", "screenPageViews".'),
  dimension_filter: filterSchema.optional().describe('Filter on dimensions (applied before aggregation), e.g. [{"field": "eventName", "op": "exact", "value": "purchase"}].'),
  metric_filter: filterSchema.optional().describe('Filter on metrics (applied after aggregation), e.g. [{"field": "sessions", "op": "gt", "value": 100}].'),
  order_bys: z.array(orderBySchema).optional().describe('Sort order, e.g. [{"field": "sessions", "desc": true}] or [{"field": "date"}].'),
  limit: limitSchema,
  offset: z.number().int().min(0).optional().describe('Row offset for paging (use next_offset from a previous result).'),
  metric_aggregations: z
    .array(z.enum(['total', 'maximum', 'minimum']))
    .optional()
    .describe('Also return totals / maximums / minimums across all rows.'),
  keep_empty_rows: z.boolean().optional().describe('Include rows whose metrics are all 0. Default false.'),
  currency_code: z.string().length(3).optional().describe('ISO 4217 code, e.g. "EUR". Default: the property currency.'),
  return_property_quota: returnQuotaSchema,
};

type RunReportArgs = {
  property_id: string | number;
  date_ranges?: DateRangeInput[];
  dimensions?: string[];
  metrics: string[];
  dimension_filter?: Filter;
  metric_filter?: Filter;
  order_bys?: OrderByInput[];
  limit?: number;
  offset?: number;
  metric_aggregations?: Array<'total' | 'maximum' | 'minimum'>;
  keep_empty_rows?: boolean;
  currency_code?: string;
  return_property_quota?: boolean;
};

const AGGREGATIONS = { total: 'TOTAL', maximum: 'MAXIMUM', minimum: 'MINIMUM' } as const;

export function buildRunReportRequest(a: RunReportArgs) {
  const body: Record<string, unknown> = {
    dateRanges: toDateRanges(a.date_ranges),
    dimensions: (a.dimensions ?? []).map((name) => ({ name })),
    metrics: a.metrics.map((name) => ({ name })),
    limit: String(a.limit ?? DEFAULT_LIMIT),
  };
  if (a.offset) body.offset = String(a.offset);
  if (a.dimension_filter) body.dimensionFilter = toFilterExpression(a.dimension_filter);
  if (a.metric_filter) body.metricFilter = toFilterExpression(a.metric_filter);
  if (a.order_bys?.length) body.orderBys = toOrderBys(a.order_bys, a.metrics);
  if (a.metric_aggregations?.length) body.metricAggregations = a.metric_aggregations.map((m) => AGGREGATIONS[m]);
  if (a.keep_empty_rows) body.keepEmptyRows = true;
  if (a.currency_code) body.currencyCode = a.currency_code.toUpperCase();
  if (a.return_property_quota) body.returnPropertyQuota = true;
  return { propertyId: normalizePropertyId(a.property_id), body };
}

// ---------- run_realtime_report ----------

export const runRealtimeShape = {
  property_id: propertyIdSchema,
  dimensions: z
    .array(z.string())
    .max(9)
    .optional()
    .describe(
      `Realtime dimension API names (a limited set), e.g. "eventName", "unifiedScreenName", "country", "city", "deviceCategory", "platform", "minutesAgo". List: ${REALTIME_SCHEMA_URL}`,
    ),
  metrics: z.array(z.string()).min(1).max(10).describe('Realtime metrics: "activeUsers", "eventCount", "keyEvents", "screenPageViews".'),
  dimension_filter: filterSchema.optional(),
  metric_filter: filterSchema.optional(),
  order_bys: z.array(orderBySchema).optional(),
  limit: limitSchema,
  minute_ranges: z
    .array(
      z.object({
        start_minutes_ago: z.number().int().min(0).max(59).describe('e.g. 29 (standard properties: up to 29, 360: up to 59).'),
        end_minutes_ago: z.number().int().min(0).max(59).describe('e.g. 0 for now.'),
        name: z.string().optional(),
      }),
    )
    .max(2)
    .optional()
    .describe('Default: the last 30 minutes. Two ranges are allowed (e.g. last 5 vs last 30 minutes).'),
  return_property_quota: returnQuotaSchema,
};

type RunRealtimeArgs = Omit<RunReportArgs, 'date_ranges' | 'offset' | 'keep_empty_rows' | 'currency_code' | 'metric_aggregations'> & {
  minute_ranges?: Array<{ start_minutes_ago: number; end_minutes_ago: number; name?: string }>;
};

export function buildRealtimeRequest(a: RunRealtimeArgs) {
  const body: Record<string, unknown> = {
    dimensions: (a.dimensions ?? []).map((name) => ({ name })),
    metrics: a.metrics.map((name) => ({ name })),
    limit: String(a.limit ?? DEFAULT_LIMIT),
  };
  if (a.dimension_filter) body.dimensionFilter = toFilterExpression(a.dimension_filter);
  if (a.metric_filter) body.metricFilter = toFilterExpression(a.metric_filter);
  if (a.order_bys?.length) body.orderBys = toOrderBys(a.order_bys, a.metrics);
  if (a.minute_ranges?.length) {
    body.minuteRanges = a.minute_ranges.map((r) => ({
      startMinutesAgo: r.start_minutes_ago,
      endMinutesAgo: r.end_minutes_ago,
      ...(r.name ? { name: r.name } : {}),
    }));
  }
  if (a.return_property_quota) body.returnPropertyQuota = true;
  return { propertyId: normalizePropertyId(a.property_id), body };
}

// ---------- run_funnel_report ----------

const paramConditionSchema = z.object({
  param: z.string().describe('Event parameter name, e.g. "payment_type", or an item parameter with item_param: true.'),
  item_param: z.boolean().optional().describe('Match an item-level parameter (e.g. "item_category") instead of an event parameter.'),
  op: z.enum(OPS).describe('Same ops as filters (except "empty").'),
  value: z.union([z.string(), z.number()]).optional(),
  values: z.array(z.string()).optional(),
  from: z.number().optional(),
  to: z.number().optional(),
  case_sensitive: z.boolean().optional(),
});

const funnelStepSchema = z.object({
  name: z.string().describe('Step label shown in the result, e.g. "1. View item".'),
  event_name: z.string().optional().describe('Event that completes this step, e.g. "view_item", "add_to_cart", "begin_checkout", "purchase".'),
  event_params: z.array(paramConditionSchema).optional().describe('Extra conditions on that event\'s parameters (all must match). Needs event_name.'),
  conditions: z
    .array(conditionSchema)
    .optional()
    .describe('Conditions on dimensions (all must match), e.g. [{"field": "pagePath", "op": "begins_with", "value": "/checkout"}]. Op "empty" is not supported.'),
  directly_followed_by: z.boolean().optional().describe('The next step must happen directly after this one (no events in between). Default false.'),
  within_seconds: z.number().int().positive().optional().describe('This step must happen within N seconds of the previous step.'),
});

export const runFunnelShape = {
  property_id: propertyIdSchema,
  date_ranges: dateRangesSchema,
  steps: z.array(funnelStepSchema).min(2).max(10).describe('Funnel steps in order (2–10). Each needs event_name and/or conditions.'),
  open_funnel: z.boolean().optional().describe('Open funnel: users can enter at any step. Default false (closed: everyone starts at step 1).'),
  breakdown_dimension: z.string().optional().describe('Split each step by a dimension, e.g. "deviceCategory" or "sessionDefaultChannelGroup".'),
  breakdown_limit: z.number().int().min(1).max(15).optional().describe('Max breakdown values. Default 5.'),
  next_action_dimension: z
    .string()
    .optional()
    .describe('Show what users did next after each step: "eventName", "pagePath", "pageTitle", "unifiedScreenName" (and a few more).'),
  trended: z.boolean().optional().describe('Also return a day-by-day (trended) funnel. Default false.'),
  dimension_filter: filterSchema.optional().describe('Limit the funnel to users matching these dimension conditions (e.g. a country).'),
  limit: limitSchema,
  return_property_quota: returnQuotaSchema,
};

type FunnelStepInput = z.infer<typeof funnelStepSchema>;
type RunFunnelArgs = {
  property_id: string | number;
  date_ranges?: DateRangeInput[];
  steps: FunnelStepInput[];
  open_funnel?: boolean;
  breakdown_dimension?: string;
  breakdown_limit?: number;
  next_action_dimension?: string;
  trended?: boolean;
  dimension_filter?: Filter;
  limit?: number;
  return_property_quota?: boolean;
};

function funnelStepExpression(step: FunnelStepInput, index: number): Record<string, unknown> {
  const where = `step ${index + 1} ("${step.name}")`;
  const parts: Record<string, unknown>[] = [];
  if (step.event_params?.length && !step.event_name) throw new InputError(`${where}: event_params needs event_name.`);
  if (step.event_name) {
    const params = (step.event_params ?? []).map((p) => ({
      funnelParameterFilter: {
        [p.item_param ? 'itemParameterName' : 'eventParameterName']: p.param,
        ...toMatcher(p, `${where} parameter "${p.param}"`, false),
      },
    }));
    parts.push({
      funnelEventFilter: {
        eventName: step.event_name,
        ...(params.length
          ? { funnelParameterFilterExpression: params.length === 1 ? params[0] : { andGroup: { expressions: params } } }
          : {}),
      },
    });
  }
  for (const c of step.conditions ?? []) {
    const field = { funnelFieldFilter: { fieldName: c.field, ...toMatcher(c, `${where} condition on "${c.field}"`, false) } };
    parts.push(c.not ? { notExpression: field } : field);
  }
  if (!parts.length) throw new InputError(`${where}: give an event_name and/or conditions.`);
  return parts.length === 1 ? parts[0] : { andGroup: { expressions: parts } };
}

export function buildFunnelRequest(a: RunFunnelArgs) {
  const body: Record<string, unknown> = {
    dateRanges: toDateRanges(a.date_ranges),
    funnel: {
      isOpenFunnel: a.open_funnel ?? false,
      steps: a.steps.map((s, i) => ({
        name: s.name,
        filterExpression: funnelStepExpression(s, i),
        ...(s.directly_followed_by ? { isDirectlyFollowedBy: true } : {}),
        ...(s.within_seconds ? { withinDurationFromPriorStep: `${s.within_seconds}s` } : {}),
      })),
    },
    funnelVisualizationType: a.trended ? 'TRENDED_FUNNEL' : 'STANDARD_FUNNEL',
    limit: String(a.limit ?? DEFAULT_LIMIT),
  };
  if (a.breakdown_dimension) {
    body.funnelBreakdown = { breakdownDimension: { name: a.breakdown_dimension }, limit: String(a.breakdown_limit ?? 5) };
  }
  if (a.next_action_dimension) {
    body.funnelNextAction = { nextActionDimension: { name: a.next_action_dimension }, limit: '5' };
  }
  if (a.dimension_filter) body.dimensionFilter = toFilterExpression(a.dimension_filter);
  if (a.return_property_quota) body.returnPropertyQuota = true;
  return { propertyId: normalizePropertyId(a.property_id), body };
}

interface FunnelSubReport extends ReportResponse {
  metadata?: ReportResponse['metadata'];
}

export function compactFunnel(res: { funnelTable?: FunnelSubReport; funnelVisualization?: FunnelSubReport; propertyQuota?: unknown }, trended: boolean) {
  const out: Record<string, unknown> = { steps: toRows(res.funnelTable ?? {}, res.funnelTable?.rows) };
  if (trended && res.funnelVisualization) out.trended = toRows(res.funnelVisualization, res.funnelVisualization.rows);
  const notes = reportNotes(res.funnelTable?.metadata);
  if (notes.length) out.notes = notes;
  if (res.propertyQuota) out.property_quota = res.propertyQuota;
  return out;
}

// ---------- registration ----------

export function registerReportTools({ server, api }: ToolContext): void {
  server.registerTool(
    'run_report',
    {
      title: 'Run a GA4 report',
      description:
        'Runs a Google Analytics 4 report (Data API runReport): metrics broken down by dimensions over date ranges, with optional filters, sorting and paging. ' +
        'Rows come back as objects keyed by dimension/metric name. Default: last 28 days, 100 rows. ' +
        'Tips: put "date" in dimensions for a time series; use order_bys + limit for top-N lists; event-scoped custom dimensions are "customEvent:<param>".',
      inputSchema: runReportShape,
      annotations: READ_ONLY,
    },
    safe(async (args: RunReportArgs) => {
      const { propertyId, body } = buildRunReportRequest(args);
      const res = await api.data<ReportResponse>('v1beta', `/properties/${propertyId}:runReport`, body, { propertyId });
      return compactReport(res, { offset: args.offset });
    }),
  );

  server.registerTool(
    'run_realtime_report',
    {
      title: 'Run a GA4 realtime report',
      description:
        'Realtime data for the last 30 minutes (60 on GA4 360): active users and events right now. Good for checking that a tracking change is live. ' +
        'Only realtime dimensions/metrics are allowed (see the dimensions description).',
      inputSchema: runRealtimeShape,
      annotations: READ_ONLY,
    },
    safe(async (args: RunRealtimeArgs) => {
      const { propertyId, body } = buildRealtimeRequest(args);
      const res = await api.data<ReportResponse>('v1beta', `/properties/${propertyId}:runRealtimeReport`, body, { propertyId });
      return compactReport(res);
    }),
  );

  server.registerTool(
    'run_funnel_report',
    {
      title: 'Run a GA4 funnel report',
      description:
        'Funnel exploration (Data API v1alpha runFunnelReport): how many users reach each step and where they drop off. ' +
        'Steps are events (e.g. view_item → add_to_cart → begin_checkout → purchase), optionally with parameter or dimension conditions. ' +
        'Result rows per step: activeUsers, funnelStepCompletionRate, funnelStepAbandonments, funnelStepAbandonmentRate. Note: this Google API is in alpha.',
      inputSchema: runFunnelShape,
      annotations: READ_ONLY,
    },
    safe(async (args: RunFunnelArgs) => {
      const { propertyId, body } = buildFunnelRequest(args);
      const res = await api.data<Parameters<typeof compactFunnel>[0]>('v1alpha', `/properties/${propertyId}:runFunnelReport`, body, { propertyId });
      return compactFunnel(res, args.trended ?? false);
    }),
  );
}

