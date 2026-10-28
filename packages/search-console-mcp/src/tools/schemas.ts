import { z } from 'zod';

export const DATA_LAG_NOTE =
  'Search Console data typically lags 2–3 days; the default range ends 3 days ago (Pacific Time). Pass data_state "all" to include fresher, still-changing data.';
export const ANONYMIZED_NOTE =
  'Grouping or filtering by query omits anonymised (rare) queries, so query rows add up to less than the totals by date, country or device.';

export const siteUrlSchema = z
  .string()
  .describe(
    'Search Console property exactly as list_sites shows it: "sc-domain:example.com" for a domain property, or a URL prefix with its trailing slash, e.g. "https://www.example.com/".',
  );

const dateSchema = z.string().describe('YYYY-MM-DD, or relative (Pacific Time): "today", "yesterday", "NdaysAgo".');
export const startDateSchema = dateSchema.optional().describe('Default "30daysAgo". YYYY-MM-DD or "NdaysAgo"/"yesterday"/"today" (Pacific Time).');
export const endDateSchema = dateSchema.optional().describe('Default "3daysAgo" (data lags 2–3 days). YYYY-MM-DD or "NdaysAgo"/"yesterday"/"today".');

export const DIMENSIONS = ['date', 'hour', 'query', 'page', 'country', 'device', 'searchAppearance'] as const;
export const FILTER_DIMENSIONS = ['query', 'page', 'country', 'device', 'searchAppearance'] as const;
export const OPERATORS = ['equals', 'contains', 'notEquals', 'notContains', 'includingRegex', 'excludingRegex'] as const;
export const SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const;

export const filterSchema = z.object({
  dimension: z.enum(FILTER_DIMENSIONS),
  operator: z.enum(OPERATORS).optional().describe('Default "equals". Regex operators use RE2 syntax.'),
  expression: z
    .string()
    .describe('Value to match. country: ISO 3166-1 alpha-3, lowercase (e.g. "pol", "usa"); device: "DESKTOP", "MOBILE" or "TABLET"; page: a full URL.'),
});
export type FilterInput = z.infer<typeof filterSchema>;

export const filtersSchema = z.array(filterSchema).optional().describe('All filters must match (AND). Example: [{"dimension": "query", "operator": "contains", "expression": "shoes"}, {"dimension": "country", "expression": "pol"}].');

export const searchTypeSchema = z
  .enum(SEARCH_TYPES)
  .optional()
  .describe('Default "web". "discover" and "googleNews" don\'t support grouping by query or aggregation_type "byProperty".');

export const dataStateSchema = z
  .enum(['final', 'all', 'hourly_all'])
  .optional()
  .describe('"final" (default): only finished days. "all": include fresh, still-changing data. "hourly_all": needed for the "hour" dimension.');
