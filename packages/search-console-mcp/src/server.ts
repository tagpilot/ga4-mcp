import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccessTokenSource } from './core.js';
import { SearchConsoleApi, type SearchConsoleApiOptions } from './google/api.js';
import { defaultToday } from './tools/common.js';
import { registerInsightTools } from './tools/insights.js';
import { registerInspectTool } from './tools/inspect.js';
import { registerSearchAnalyticsTool } from './tools/search-analytics.js';
import { registerSiteTools } from './tools/sites.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = `Read-only Google Search Console tools by Tag Pilot.
Start with list_sites and pass site_url exactly as listed ("sc-domain:example.com" or "https://www.example.com/").
The first call connects this computer: if a tool says "Connect at <link> (code XXXX-XXXX)" or "Finish signing in with Google at <link>", show the user the link and code (any browser, any device), ask them to approve, then call the tool again.
Data lags 2–3 days; dates are Pacific Time and accept YYYY-MM-DD, "today", "yesterday" or "NdaysAgo". Grouping by query omits anonymised queries, so query rows sum to less than the totals.
compare_periods and find_opportunities are Tag Pilot analyses; inspect_url has a small daily quota (2,000 per property).`;

export function createServer(tokens: AccessTokenSource, apiOptions: SearchConsoleApiOptions = {}, today: () => string = defaultToday): McpServer {
  const server = new McpServer({ name: 'tagpilot-search-console', version: VERSION }, { instructions: INSTRUCTIONS });
  const ctx = { server, api: new SearchConsoleApi(tokens, apiOptions), today };
  registerSiteTools(ctx);
  registerSearchAnalyticsTool(ctx);
  registerInsightTools(ctx);
  registerInspectTool(ctx);
  return server;
}
