#!/usr/bin/env node
// @tagpilot/gtm-mcp: stdio MCP server (default) plus login/logout/status.
import { runCli } from './core.js';
import { PRODUCT } from './product.js';
import { createServer } from './server.js';

const env = process.env;
await runCli(PRODUCT, {
  tagline: 'read-only Google Tag Manager MCP server by Tag Pilot',
  createServer: (tokens) =>
    createServer(tokens, {
      apiUrl: env.GTM_MCP_TAGMANAGER_API_URL?.trim().replace(/\/+$/, '') || undefined,
    }),
});
