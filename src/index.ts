#!/usr/bin/env node
// @tagpilot/ga4-mcp: stdio MCP server (default) plus a few auth helper commands.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAccessTokenSource, createTokenManager } from './auth/index.js';
import { loadConfig, MISSING_KEY_MESSAGE, type Config } from './config.js';
import { log } from './log.js';
import { createServer } from './server.js';
import { VERSION } from './version.js';

const HELP = `@tagpilot/ga4-mcp ${VERSION}: read-only Google Analytics 4 MCP server by Tag Pilot

Usage:
  npx -y @tagpilot/ga4-mcp            Start the MCP server on stdio (what MCP clients run)
  npx -y @tagpilot/ga4-mcp login      Sign in with Google now, in this terminal
  npx -y @tagpilot/ga4-mcp logout     Delete the saved Google token for this API key
  npx -y @tagpilot/ga4-mcp status     Show configuration and token status

Environment:
  TAGPILOT_API_KEY     Required. Free key from the GA4 MCP page at https://app.tagpilot.io
  TAGPILOT_API_URL     Tag Pilot API base URL (default https://api.tagpilot.io)
  GA4_MCP_OAUTH_PORT   Fixed local port for the Google sign-in callback (default: random)
  GA4_MCP_NO_BROWSER   Set to 1 to only print the sign-in URL instead of opening a browser
  GA4_MCP_CONFIG_DIR   Token cache directory (default ~/.config/tagpilot/ga4-mcp)
`;

function managerOrExit(config: Config) {
  const manager = createTokenManager(config);
  if (!manager) {
    process.stderr.write(MISSING_KEY_MESSAGE + '\n');
    process.exit(1);
  }
  return manager;
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? 'serve';
  if (command === '--version' || command === '-v') {
    process.stdout.write(VERSION + '\n');
    return;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const config = loadConfig();
  if (config.mode === 'dev') log('Development mode: using GA4_MCP_DEV_GOOGLE_CLIENT_ID/SECRET directly with Google (no Tag Pilot broker).');

  switch (command) {
    case 'serve': {
      if (config.mode === 'broker' && !config.apiKey) log(MISSING_KEY_MESSAGE);
      const server = createServer(createAccessTokenSource(config), {
        adminApiUrl: config.adminApiUrl,
        dataApiUrl: config.dataApiUrl,
      });
      await server.connect(new StdioServerTransport());
      log(`ready (v${VERSION}, ${config.mode === 'dev' ? 'development mode' : config.apiUrl})`);
      return;
    }
    case 'login': {
      const manager = managerOrExit(config);
      await manager.getAccessToken(Number.POSITIVE_INFINITY);
      process.stderr.write(`Signed in. Token saved to ${manager.cacheFile}\n`);
      return;
    }
    case 'logout': {
      const manager = managerOrExit(config);
      const { TokenCache } = await import('./auth/cache.js');
      const removed = new TokenCache(manager.cacheFile).clear();
      process.stderr.write(removed ? `Removed ${manager.cacheFile}\n` : 'No saved token.\n');
      process.stderr.write('To also revoke the access at Google, visit https://myaccount.google.com/permissions\n');
      return;
    }
    case 'status': {
      const manager = createTokenManager(config);
      const lines = [`version: ${VERSION}`, `mode: ${config.mode}`];
      if (config.mode === 'broker') {
        lines.push(`api url: ${config.apiUrl}`, `api key: ${config.apiKey ? `set (${config.apiKey.slice(0, 8)}…)` : 'NOT SET'}`);
      }
      if (manager) {
        const { TokenCache } = await import('./auth/cache.js');
        const token = new TokenCache(manager.cacheFile).read();
        lines.push(`token file: ${manager.cacheFile}`);
        lines.push(
          token?.refresh_token
            ? `signed in: yes (access token ${token.expiry && token.expiry > Date.now() ? `valid until ${new Date(token.expiry).toISOString()}` : 'expired, will refresh'})`
            : 'signed in: no (the first tool call or `login` opens the Google sign-in)',
        );
      }
      process.stdout.write(lines.join('\n') + '\n');
      return;
    }
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
