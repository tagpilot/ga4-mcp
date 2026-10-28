#!/usr/bin/env node
// @tagpilot/ga4-mcp: stdio MCP server (default) plus a few auth helper commands.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTokenManager } from './auth/index.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { createServer } from './server.js';
import { logout, status } from './cli.js';
import { VERSION } from './version.js';

const HELP = `@tagpilot/ga4-mcp ${VERSION}: read-only Google Analytics 4 MCP server by Tag Pilot

Usage:
  npx -y @tagpilot/ga4-mcp            Start the MCP server on stdio (what MCP clients run)
  npx -y @tagpilot/ga4-mcp login      Connect this computer now: prints a link and a code to
                                      confirm in any browser, then waits
  npx -y @tagpilot/ga4-mcp logout     Remove this computer's saved connection and sign-ins
                                      (only this key's when TAGPILOT_API_KEY is set)
  npx -y @tagpilot/ga4-mcp status     Show whether this computer is connected

No configuration is needed: the first GA4 question (or \`login\`) connects this computer to
your free Tag Pilot account in the browser, then asks Google for read-only access.

Environment (all optional):
  TAGPILOT_API_KEY     Use this ga4:mcp key instead of connecting the device (CI, headless)
  TAGPILOT_API_URL     Tag Pilot API base URL (default https://api.tagpilot.io)
  GA4_MCP_NO_BROWSER   Set to 1 to only print the link instead of opening a browser
  GA4_MCP_BROWSER      Browser to open the link with (app name on macOS, command elsewhere)
  GA4_MCP_AUTH_WAIT_SECONDS
                       How long a tool call waits for the connect before answering with the
                       link (default 45; many MCP clients time out tool calls at 60)
  GA4_MCP_CONFIG_DIR   Credential directory (default ~/.config/tagpilot/ga4-mcp)
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
      // The device connect labels the device with the MCP client's name, known after `initialize`.
      let clientName: () => string | undefined = () => undefined;
      const tokens = createTokenManager(config, { clientName: () => clientName() });
      const server = createServer(tokens, {
        adminApiUrl: config.adminApiUrl,
        dataApiUrl: config.dataApiUrl,
      });
      clientName = () => server.server.getClientVersion()?.name;
      await server.connect(new StdioServerTransport());
      log(`ready (v${VERSION}, ${config.apiUrl}, ${tokens.mode === 'key' ? 'TAGPILOT_API_KEY' : 'device connect'})`);
      return;
    }
    case 'login': {
      const manager = createTokenManager(config);
      process.stderr.write(
        manager.mode === 'key'
          ? 'Starting the Google sign-in for TAGPILOT_API_KEY. Open the link below in any browser, on any device; this waits until you approve.\n'
          : 'Connecting this computer to Tag Pilot. Open the link below in any browser, on any device; this waits until you approve.\n',
      );
      await manager.getAccessToken(Number.POSITIVE_INFINITY);
      process.stderr.write(`Connected. Saved to ${manager.cacheFile}\n`);
      return;
    }
    case 'logout': {
      process.stderr.write(logout(config).join('\n') + '\n');
      return;
    }
    case 'status': {
      process.stdout.write(status(config).join('\n') + '\n');
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
