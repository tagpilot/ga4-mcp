#!/usr/bin/env node
// @tagpilot/ga4-mcp: stdio MCP server (default) plus login/logout/status.
import { runCli } from './core.js';
import { PRODUCT } from './product.js';
import { createServer } from './server.js';

const env = process.env;
await runCli(PRODUCT, {
  tagline: 'read-only Google Analytics 4 MCP server by Tag Pilot',
  createServer: (tokens) =>
    createServer(tokens, {
      adminApiUrl: env.GA4_MCP_ADMIN_API_URL?.trim().replace(/\/+$/, '') || undefined,
      dataApiUrl: env.GA4_MCP_DATA_API_URL?.trim().replace(/\/+$/, '') || undefined,
    }),
});
