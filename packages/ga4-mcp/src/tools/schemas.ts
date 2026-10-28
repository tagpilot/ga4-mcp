// Shared zod schemas for tool inputs. Filters are a flat "AND of conditions or OR-groups" list instead of
// GA4's verbose, recursive FilterExpression JSON: it can express any filter (conjunctive normal form, with
// "not" on conditions), needs no recursive $refs (some MCP clients can't handle them) and keeps the
// tool schemas small, since every copy of a union gets inlined into the JSON schema.
import { z } from 'zod';

export const propertyIdSchema = z
  .union([z.string(), z.number()])
  .describe('GA4 property ID, e.g. "123456789" or "properties/123456789" (not the G-XXXX measurement ID). get_account_summaries lists them.');

const dateSchema = z
  .string()
  .describe('YYYY-MM-DD, or relative: "today", "yesterday", "NdaysAgo" (e.g. "7daysAgo", "28daysAgo").');

export const dateRangeSchema = z.object({
  start_date: dateSchema,
  end_date: dateSchema,
  name: z.string().optional().describe('Optional label; shows up as the "dateRange" column when you pass several ranges.'),
});

export const dateRangesSchema = z
  .array(dateRangeSchema)
  .min(1)
  .max(4)
  .optional()
  .describe('Up to 4 date ranges. Default: last 28 full days (28daysAgo to yesterday). Several ranges add a "dateRange" column (e.g. for period comparisons).');

export const STRING_OPS = ['exact', 'contains', 'begins_with', 'ends_with', 'full_regex', 'partial_regex'] as const;
export const NUMERIC_OPS = ['eq', 'lt', 'lte', 'gt', 'gte'] as const;
export const OPS = [...STRING_OPS, 'in_list', ...NUMERIC_OPS, 'between', 'empty'] as const;

const matcherShape = {
  op: z
    .enum(OPS)
    .describe(
      'String ops: exact, contains, begins_with, ends_with, full_regex (RE2, whole value), partial_regex; in_list (uses "values"); ' +
        'numeric ops: eq, lt, lte, gt, gte (use a number "value"), between (uses "from"/"to"); empty (value is empty / not set).',
    ),
  value: z.union([z.string(), z.number()]).optional().describe('Value to compare with (string ops and numeric ops).'),
  values: z.array(z.string()).optional().describe('For in_list.'),
  from: z.number().optional().describe('For between (inclusive).'),
  to: z.number().optional().describe('For between (inclusive).'),
  case_sensitive: z.boolean().optional().describe('String ops and in_list only. Default false.'),
};

export const conditionSchema = z.object({
  field: z.string().describe('Dimension or metric API name, e.g. "eventName", "pagePath", "sessionDefaultChannelGroup", "sessions".'),
  ...matcherShape,
  not: z.boolean().optional().describe('Negate this condition.'),
});
export type Condition = z.infer<typeof conditionSchema>;
export type Matcher = Omit<Condition, 'field' | 'not'>;

export const anyGroupSchema = z.object({ any: z.array(conditionSchema).min(1).describe('At least one of these conditions must match (OR).') });

export const filterSchema = z
  .array(z.union([conditionSchema, anyGroupSchema]))
  .min(1)
  .describe(
    'List of conditions that must ALL match (AND). An item can also be {"any": [conditions]} for OR. Each condition: {field, op, value}, optionally "not": true. ' +
      'Example: [{"field": "eventName", "op": "exact", "value": "purchase"}, {"field": "country", "op": "in_list", "values": ["Poland"], "not": true}, ' +
      '{"any": [{"field": "pagePath", "op": "begins_with", "value": "/shop"}, {"field": "pagePath", "op": "contains", "value": "product"}]}]',
  );
export type Filter = z.infer<typeof filterSchema>;

export const orderBySchema = z.object({
  field: z.string().describe('A dimension or metric from this request.'),
  desc: z.boolean().optional().describe('Descending. Default false.'),
  dimension_order: z
    .enum(['alphanumeric', 'case_insensitive_alphanumeric', 'numeric'])
    .optional()
    .describe('For dimensions only. Use numeric for e.g. "date" or "hour"-like dimensions stored as strings.'),
});

export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(100000)
  .optional()
  .describe('Max rows to return. Default 100. The result says when more rows exist (next_offset).');

export const returnQuotaSchema = z.boolean().optional().describe('Include the property quota status in the result.');
