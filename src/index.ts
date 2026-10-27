#!/usr/bin/env node
// @tagpilot/ga4-mcp: stdio MCP server (default) plus a few auth helper commands.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAccessTokenSource, createTokenManager } from './auth/index.js';
import { loadConfig, MISSING_KEY_MESSAGE } from './config.js';
import { log } from './log.js';
import { createServer } from './server.js';
import { LOGIN_NEEDS_KEY, logout, status } from './cli.js';
import { VERSION } from './version.js';

const HELP = `@tagpilot/ga4-mcp ${VERSION}: read-only Google Analytics 4 MCP server by Tag Pilot

Usage:
  npx -y @tagpilot/ga4-mcp            Start the MCP server on stdio (what MCP clients run)
  npx -y @tagpilot/ga4-mcp login      Sign in with Google now: prints a link to open in any browser
  npx -y @tagpilot/ga4-mcp logout     Delete saved Google sign-ins (all of them, or only this key's
                                      when TAGPILOT_API_KEY is set)
  npx -y @tagpilot/ga4-mcp status     Show configuration and saved sign-ins

Environment:
  TAGPILOT_API_KEY     Required. Free key from the GA4 MCP page at https://app.tagpilot.io
  TAGPILOT_API_URL     Tag Pilot API base URL (default https://api.tagpilot.io)
  GA4_MCP_NO_BROWSER   Set to 1 to only print the sign-in URL instead of opening a browser
  GA4_MCP_BROWSER      Browser to open the sign-in with (app name on macOS, command elsewhere)
  GA4_MCP_AUTH_WAIT_SECONDS
                       How long a tool call waits for the sign-in before answering with the
                       link (default 45; many MCP clients time out tool calls at 60)
  GA4_MCP_CONFIG_DIR   Token cache directory (default ~/.config/tagpilot/ga4-mcp)

TAGPILOT_API_KEY is normally set in your MCP client's config, not your shell; logout and
status work without it.
`;

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

  switch (command) {
    case 'serve': {
      if (!config.apiKey) log(MISSING_KEY_MESSAGE);
      const server = createServer(createAccessTokenSource(config), {
        adminApiUrl: config.adminApiUrl,
        dataApiUrl: config.dataApiUrl,
      });
      await server.connect(new StdioServerTransport());
      log(`ready (v${VERSION}, ${config.apiUrl})`);
      return;
    }
    case 'login': {
      const manager = createTokenManager(config);
      if (!manager) {
        process.stderr.write(LOGIN_NEEDS_KEY + '\n');
        process.exit(1);
      }
      process.stderr.write('Starting the Google sign-in. Open the link below in any browser, on any device; this waits until you approve.\n');
      await manager.getAccessToken(Number.POSITIVE_INFINITY);
      process.stderr.write(`Signed in. Token saved to ${manager.cacheFile}\n`);
      return;
    }
    case 'logout': {
      const manager = createTokenManager(config);
      process.stderr.write(logout(config, manager?.cacheFile ?? null).join('\n') + '\n');
      return;
    }
    case 'status': {
      const manager = createTokenManager(config);
      process.stdout.write(status(config, manager?.cacheFile ?? null).join('\n') + '\n');
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
