# Tag Pilot MCP servers

Free, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) servers from
[Tag Pilot](https://tagpilot.io). No Google Cloud setup and no API key to copy: add a server, ask
a question, and approve once in your browser.

| Package | What it reads | Install (Claude Code) |
|---|---|---|
| [`@tagpilot/ga4-mcp`](packages/ga4-mcp) | Google Analytics 4: reports, funnels, realtime, property setup, tracking-health checks | `claude mcp add ga4 -- npx -y @tagpilot/ga4-mcp` |
| [`@tagpilot/search-console-mcp`](packages/search-console-mcp) | Google Search Console: search performance, period comparisons, SEO opportunities, URL inspection, sitemaps | `claude mcp add search-console -- npx -y @tagpilot/search-console-mcp` |

Each package README has the install options for Claude Desktop (`.mcpb`), Cursor, VS Code and
Gemini CLI, how connecting works and what Tag Pilot sees, the tools and troubleshooting.
`gemini extensions install https://github.com/tagpilot/ga4-mcp` installs the GA4 server (Gemini
CLI only installs from a repo root).

## Repository layout

```
packages/mcp-core            shared, not published: device connect, PKCE, token cache, broker
                             endpoints, CLI (serve/login/logout/status), Google HTTP client
packages/ga4-mcp             @tagpilot/ga4-mcp
packages/search-console-mcp  @tagpilot/search-console-mcp
scripts/                     build (esbuild), .mcpb build and smoke test
```

The published packages bundle the core into `dist/index.js` with esbuild; the MCP SDK and zod
stay npm dependencies. The `.mcpb` extensions are one fully bundled file each.

## Development

```bash
npm install
npm run check      # typecheck + lint + unit tests (all packages)
npm run build      # → packages/*/dist/index.js
npm run e2e        # built servers over stdio against a mock broker and mock Google
npm run mcpb       # → packages/*/tagpilot-<name>-<version>.mcpb
npm run mcpb:smoke # unpack each bundle, check its tools, run the e2e against it
```

## Releasing

Per package, from its directory: bump the version in `package.json`, `src/version.ts`,
`server.json`, `mcpb/manifest.json` and the Gemini extension (GA4: repo-root
`gemini-extension.json`); `npm test` checks they match. Then `npm publish --access public`, build
the `.mcpb`, and push a tag **`<package>-v<version>`** (`ga4-mcp-v0.3.1`,
`search-console-mcp-v0.1.0`): the *Publish to MCP Registry* workflow publishes that package's
`server.json`.

## License

[Apache License 2.0](LICENSE). The license does not cover the Tag Pilot name or logo (see
[NOTICE](NOTICE)).
