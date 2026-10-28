import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectionInstructions, registerConnectTools, type AccessTokenSource, type ConnectionManager } from './core.js';
import { PRODUCT } from './product.js';
import { SearchConsoleApi, type SearchConsoleApiOptions } from './google/api.js';
import { defaultToday } from './tools/common.js';
import { registerInsightTools } from './tools/insights.js';
import { registerInspectTool } from './tools/inspect.js';
import { registerSearchAnalyticsTool } from './tools/search-analytics.js';
import { registerSiteTools } from './tools/sites.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = `Read-only Google Search Console tools by Tag Pilot.
Start with list_sites and pass site_url exactly as listed ("sc-domain:example.com" or "https://www.example.com/").
Data lags 2–3 days; dates are Pacific Time and accept YYYY-MM-DD, "today", "yesterday" or "NdaysAgo". Grouping by query omits anonymised queries, so query rows sum to less than the totals.
compare_periods and find_opportunities are Tag Pilot analyses; inspect_url has a small daily quota (2,000 per property).
${connectionInstructions(PRODUCT)}`;

export function createServer(tokens: AccessTokenSource & ConnectionManager, apiOptions: SearchConsoleApiOptions = {}, today: () => string = defaultToday): McpServer {
  const server = new McpServer({ name: 'tagpilot-search-console', version: VERSION }, { instructions: INSTRUCTIONS });
  const ctx = { server, api: new SearchConsoleApi(tokens, apiOptions), today };
  registerSiteTools(ctx);
  registerSearchAnalyticsTool(ctx);
  registerInsightTools(ctx);
  registerInspectTool(ctx);
  registerConnectTools({ server, connection: tokens });
  return server;
}
