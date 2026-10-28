import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchConsoleApi } from '../google/api.js';
import { pacificToday } from './dates.js';

export interface ToolContext {
  server: McpServer;
  api: SearchConsoleApi;
  /** Today in Pacific Time (injectable for tests). */
  today: () => string;
}

export const defaultToday = () => pacificToday();

export { READ_ONLY, ok, fail, safe } from '../core.js';
