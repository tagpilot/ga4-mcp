import type { Product } from './core.js';
import { VERSION } from './version.js';

export const PRODUCT: Product = {
  id: 'gtm',
  npmName: '@tagpilot/gtm-mcp',
  slug: 'gtm-mcp',
  version: VERSION,
  title: 'Tag Pilot GTM MCP',
  label: 'GTM MCP',
  pageUrl: 'https://app.tagpilot.io/gtm-mcp',
  googleAccess: 'read-only Google Tag Manager access',
  envPrefix: 'GTM_MCP',
  keyScope: 'gtm:mcp',
};
