import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GtmApi } from '../google/api.js';

export interface ToolContext {
  server: McpServer;
  api: GtmApi;
  /** Current time in ms (injectable for tests). */
  now: () => number;
}

export { READ_ONLY, ok, fail, safe } from '../core.js';
