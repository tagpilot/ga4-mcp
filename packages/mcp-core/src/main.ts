// The shared command line: `serve` (default, stdio MCP server), `login`, `logout`, `status`.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTokenManager } from './auth/index.js';
import type { AccessTokenSource } from './auth/token-manager.js';
import { logout, status } from './cli.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import type { Product } from './product.js';

export interface CliOptions {
  createServer: (tokens: AccessTokenSource) => McpServer;
  /** One line describing what the server does, for --help. */
  tagline: string;
  /** Extra product-specific env var lines for --help. */
  extraEnvHelp?: string;
}

function help(p: Product, o: CliOptions): string {
  const e = p.envPrefix;
  return `${p.npmName} ${p.version}: ${o.tagline}

Usage:
  npx -y ${p.npmName}            Start the MCP server on stdio (what MCP clients run)
  npx -y ${p.npmName} login      Connect this computer now: prints a link and a code to
                                      confirm in any browser, then waits
  npx -y ${p.npmName} logout     Remove this computer's saved connection and sign-ins
                                      (only this key's when TAGPILOT_API_KEY is set)
  npx -y ${p.npmName} status     Show whether this computer is connected

No configuration is needed: the first question (or \`login\`) connects this computer to your
free Tag Pilot account in the browser, then asks Google for ${p.googleAccess}.

Environment (all optional):
  TAGPILOT_API_KEY     Use this ${p.keyScope} key instead of connecting the device (CI, headless)
  TAGPILOT_API_URL     Tag Pilot API base URL (default https://api.tagpilot.io)
  ${e}_NO_BROWSER   Set to 1 to only print the link instead of opening a browser
  ${e}_BROWSER      Browser to open the link with (app name on macOS, command elsewhere)
  ${e}_AUTH_WAIT_SECONDS
                       How long a tool call waits for the connect before answering with the
                       link (default 45; many MCP clients time out tool calls at 60)
  ${e}_CONFIG_DIR   Credential directory (default ~/.config/tagpilot/${p.slug})
${o.extraEnvHelp ?? ''}`;
}

export async function runCli(product: Product, opts: CliOptions, argv = process.argv.slice(2)): Promise<void> {
  try {
    await main(product, opts, argv);
  } catch (e) {
    log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

async function main(product: Product, opts: CliOptions, argv: string[]): Promise<void> {
  const command = argv[0] ?? 'serve';
  if (command === '--version' || command === '-v') {
    process.stdout.write(product.version + '\n');
    return;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(help(product, opts));
    return;
  }
  const config = loadConfig(product);

  switch (command) {
    case 'serve': {
      // The device connect labels the device with the MCP client's name, known after `initialize`.
      let clientName: () => string | undefined = () => undefined;
      const tokens = createTokenManager(product, config, { clientName: () => clientName() });
      const server = opts.createServer(tokens);
      clientName = () => server.server.getClientVersion()?.name;
      await server.connect(new StdioServerTransport());
      log(`ready (v${product.version}, ${config.apiUrl}, ${tokens.mode === 'key' ? 'TAGPILOT_API_KEY' : 'device connect'})`);
      return;
    }
    case 'login': {
      const manager = createTokenManager(product, config);
      process.stderr.write(
        manager.mode === 'key'
          ? 'Starting the Google sign-in for TAGPILOT_API_KEY. Open the link below in any browser, on any device; this waits until you approve.\n'
          : 'Connecting this computer to Tag Pilot. Open the link below in any browser, on any device; this waits until you approve.\n',
      );
      await manager.getAccessToken(Number.POSITIVE_INFINITY);
      process.stderr.write(`Connected. Saved to ${manager.cacheFile}\n`);
      return;
    }
    case 'logout':
      process.stderr.write(logout(product, config).join('\n') + '\n');
      return;
    case 'status':
      process.stdout.write(status(product, config).join('\n') + '\n');
      return;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${help(product, opts)}`);
      process.exit(2);
  }
}
