import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccessTokenSource } from './core.js';
import { GoogleApi, type GoogleApiOptions } from './google/api.js';
import { registerAdminTools } from './tools/admin.js';
import { registerHealthTools } from './tools/health.js';
import { registerReportTools } from './tools/reports.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = `Read-only Google Analytics 4 tools by Tag Pilot.
Start with get_account_summaries to find property IDs (numeric, not G-XXXX measurement IDs).
The first call connects this computer: if a tool says "Connect at <link> (code XXXX-XXXX)" or "Finish signing in with Google at <link>", show the user the link and code (any browser, any device), ask them to approve, then call the tool again.
Dates accept YYYY-MM-DD, "today", "yesterday" or "NdaysAgo". Use get_custom_dimensions_and_metrics for custom dimension API names.
check_duplicate_transactions and check_traffic_attribution are Tag Pilot tracking-health checks.`;

export function createServer(tokens: AccessTokenSource, apiOptions: GoogleApiOptions = {}): McpServer {
  const server = new McpServer({ name: 'tagpilot-ga4', version: VERSION }, { instructions: INSTRUCTIONS });
  const api = new GoogleApi(tokens, apiOptions);
  const ctx = { server, api };
  registerAdminTools(ctx);
  registerReportTools(ctx);
  registerHealthTools(ctx);
  return server;
}
