import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GoogleApi } from '../google/api.js';

export interface ToolContext {
  server: McpServer;
  api: GoogleApi;
}

export { READ_ONLY, ok, fail, safe } from '../core.js';

export const stripPrefix = (s: string | undefined, prefix: string) => (s?.startsWith(prefix) ? s.slice(prefix.length) : s);
export const idOf = (resourceName: string | undefined) => resourceName?.split('/').pop();
