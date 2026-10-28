#!/usr/bin/env node
// @tagpilot/search-console-mcp: stdio MCP server (default) plus login/logout/status.
import { runCli } from './core.js';
import { PRODUCT } from './product.js';
import { createServer } from './server.js';

const env = process.env;
await runCli(PRODUCT, {
  tagline: 'read-only Google Search Console MCP server by Tag Pilot',
  createServer: (tokens) =>
    createServer(tokens, {
      webmastersApiUrl: env.SEARCH_CONSOLE_MCP_WEBMASTERS_API_URL?.trim().replace(/\/+$/, '') || undefined,
      inspectionApiUrl: env.SEARCH_CONSOLE_MCP_INSPECTION_API_URL?.trim().replace(/\/+$/, '') || undefined,
    }),
});
