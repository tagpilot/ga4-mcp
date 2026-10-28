import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectionInstructions, registerConnectTools, type AccessTokenSource, type ConnectionManager } from './core.js';
import { PRODUCT } from './product.js';
import { GoogleApi, type GoogleApiOptions } from './google/api.js';
import { registerAdminTools } from './tools/admin.js';
import { registerHealthTools } from './tools/health.js';
import { registerReportTools } from './tools/reports.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = `Read-only Google Analytics 4 tools by Tag Pilot.
Start with get_account_summaries to find property IDs (numeric, not G-XXXX measurement IDs).
Dates accept YYYY-MM-DD, "today", "yesterday" or "NdaysAgo". Use get_custom_dimensions_and_metrics for custom dimension API names.
check_duplicate_transactions and check_traffic_attribution are Tag Pilot tracking-health checks.
${connectionInstructions(PRODUCT)}`;

export function createServer(tokens: AccessTokenSource & ConnectionManager, apiOptions: GoogleApiOptions = {}): McpServer {
  const server = new McpServer({ name: 'tagpilot-ga4', version: VERSION }, { instructions: INSTRUCTIONS });
  const api = new GoogleApi(tokens, apiOptions);
  const ctx = { server, api };
  registerAdminTools(ctx);
  registerReportTools(ctx);
  registerHealthTools(ctx);
  registerConnectTools({ server, connection: tokens });
  return server;
}
