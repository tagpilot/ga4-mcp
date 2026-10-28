import type { Product } from './core.js';
import { VERSION } from './version.js';

export const PRODUCT: Product = {
  id: 'ga4',
  npmName: '@tagpilot/ga4-mcp',
  slug: 'ga4-mcp',
  version: VERSION,
  title: 'Tag Pilot GA4 MCP',
  label: 'GA4 MCP',
  pageUrl: 'https://app.tagpilot.io/ga4-mcp',
  googleAccess: 'read-only Google Analytics access',
  envPrefix: 'GA4_MCP',
  keyScope: 'ga4:mcp',
};
