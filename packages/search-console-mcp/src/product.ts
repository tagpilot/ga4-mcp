import type { Product } from './core.js';
import { VERSION } from './version.js';

export const PRODUCT: Product = {
  id: 'gsc',
  npmName: '@tagpilot/search-console-mcp',
  slug: 'search-console-mcp',
  version: VERSION,
  title: 'Tag Pilot Search Console MCP',
  label: 'Search Console MCP',
  pageUrl: 'https://app.tagpilot.io/search-console-mcp',
  googleAccess: 'read-only Google Search Console access',
  envPrefix: 'SEARCH_CONSOLE_MCP',
  keyScope: 'gsc:mcp',
};
