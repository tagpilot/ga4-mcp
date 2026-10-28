# Tag Pilot Search Console MCP

A free, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for
**Google Search Console**. Ask Claude, Cursor or any MCP client about your organic search: clicks,
impressions, CTR and positions by query or page, what changed between two periods, SEO
opportunities, Google's index status for a URL, and your sitemaps.

**No Google Cloud setup, no API key to copy.** You don't need a GCP project, OAuth client,
service account or `gcloud`. Add the server, ask a question, and approve once in your browser.

```bash
claude mcp add search-console -- npx -y @tagpilot/search-console-mcp
```

## Get started

1. **Install** in your AI client (below). No configuration needed.
2. **Ask something**, e.g. *"Which queries lost the most clicks this month?"* The first time, a
   browser window opens (or your AI shows a link and a code like `ABCD-1234`):
   - sign in to your free [Tag Pilot](https://app.tagpilot.io) account, or create one;
   - check that the code matches and approve this computer;
   - sign in with the Google account that can see your Search Console properties and allow
     read-only Search Console access.
3. **Ask again.** You're connected; the computer shows up under **Connected devices** on the
   [Search Console MCP page](https://app.tagpilot.io/search-console-mcp).

Already use the [Tag Pilot GA4 MCP](../ga4-mcp)? This is a separate server with its own
connection (and its own Google consent), so you can install either or both.

## Install

| Client | How |
|---|---|
| Claude Desktop | [Download the extension](https://github.com/tagpilot/ga4-mcp/releases/latest/download/tagpilot-search-console-mcp.mcpb) and open it (no Node.js needed) |
| Claude Code | `claude mcp add search-console -- npx -y @tagpilot/search-console-mcp` |
| Cursor, VS Code, Windsurf, Zed, … | command `npx`, args `["-y", "@tagpilot/search-console-mcp"]` (stdio) |
| Gemini CLI | clone the repo, then `gemini extensions install ./ga4-mcp/packages/search-console-mcp` |

Everything except the Claude Desktop extension runs the npm package with `npx`, so it needs
Node.js 18 or newer. In the [MCP Registry](https://registry.modelcontextprotocol.io) it's
`io.github.tagpilot/search-console-mcp`.

Claude Desktop config file (`claude_desktop_config.json`), Cursor (`~/.cursor/mcp.json`) and
similar clients:

```json
{
  "mcpServers": {
    "search-console": {
      "command": "npx",
      "args": ["-y", "@tagpilot/search-console-mcp"]
    }
  }
}
```

**Headless and CI:** where nobody can approve in a browser, create a `gsc:mcp` key on the
[Search Console MCP page](https://app.tagpilot.io/search-console-mcp) and set
`TAGPILOT_API_KEY=tpk_…` in the server's environment. The device connect is then skipped and only
the Google sign-in link is shown.

## How connecting works, and what Tag Pilot sees

The same flow as the GA4 MCP (RFC 8628-style device connect, like `gh auth login`): it works from
any browser on any device, also over SSH, in containers or WSL, because nothing listens on your
machine.

- **Your Search Console data goes from your machine straight to Google**
  (`www.googleapis.com/webmasters/v3`, `searchconsole.googleapis.com`). It never passes through
  Tag Pilot.
- **Tag Pilot only brokers the token exchange.** It adds Tag Pilot's Google OAuth client
  credentials to Google's token endpoint and returns Google's answer. It **stores no Google
  tokens** and never logs them; it holds the one-time sign-in code for at most 10 minutes, and that
  code is useless without the PKCE verifier that stays on your machine.
- **Read-only.** The only Google scope requested is `webmasters.readonly`. None of the tools can
  change anything in Search Console (no sitemap submits, no deletes).
- **Your credentials stay on your machine**, in
  `~/.config/tagpilot/search-console-mcp/device.json` (readable only by you).
- **Disconnecting:** revoke the device on the
  [Search Console MCP page](https://app.tagpilot.io/search-console-mcp), run
  `npx -y @tagpilot/search-console-mcp logout`, and remove the app's access at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Tools

All tools are read-only. `site_url` is the property exactly as `list_sites` shows it:
`sc-domain:example.com` for a domain property, or a URL prefix with its trailing slash
(`https://www.example.com/`).

| Tool | What it does |
|---|---|
| `list_sites` | Properties you can read (domain and URL-prefix) with your permission level. Start here. |
| `search_analytics` | Clicks, impressions, CTR and position by `date`, `hour`, `query`, `page`, `country`, `device`, `searchAppearance`; filters; search type (web, image, video, news, Discover, Google News); data state; aggregation; paging (up to 25,000 rows per call). |
| `compare_periods` | Period-over-period by query or page: both periods, deltas, new/lost rows, and property totals. Default: last 28 days vs the 28 days before. |
| `find_opportunities` | **Tag Pilot analysis.** `low_ctr`: page-one rows with many impressions but under half a typical CTR for their position. `striking_distance`: rows at average positions ~5–20 with enough impressions. |
| `inspect_url` | URL Inspection: Google's indexed version of one URL (verdict, coverage, last crawl, robots.txt, canonical chosen by Google vs declared, sitemaps, rich results). |
| `list_sitemaps` / `get_sitemap` | Submitted sitemaps: type, last submitted/downloaded, errors, warnings, submitted URL counts. |

### Things to know about Search Console data

- **Lag:** data is typically available after 2–3 days. The default date range is the 28 days
  ending 3 days ago. `data_state: "all"` adds fresher, still-changing data; the result says from
  which date data is incomplete.
- **Dates are Pacific Time** (Search Console's day boundary). Relative dates (`"yesterday"`,
  `"7daysAgo"`) are computed in Pacific Time too.
- **Anonymised queries:** queries too rare to show (privacy) are left out of rows grouped or
  filtered by query, so per-query rows add up to less than the totals by date, country or device.
  `compare_periods` reports property totals separately for that reason.
- **Row limits:** a call returns up to 25,000 rows (use `start_row` to page), and Google exposes
  at most 50,000 rows per day per search type, sorted by clicks.
- **Aggregation:** grouping or filtering by page counts each URL separately (`byPage`), so totals
  differ from property-level totals.
- **Discover and Google News** don't support `aggregation_type: "byProperty"`.
- **Quotas (Google's):** Search Analytics allows 1,200 queries per minute per site and per user,
  plus a load quota that long, query-and-page-level requests use up faster. URL Inspection allows
  **2,000 inspections per day** and 600 per minute per property, so `inspect_url` is for a handful
  of important URLs, not whole sitemaps.

`find_opportunities` uses a rough benchmark CTR curve (position 1 ≈ 28%, 3 ≈ 10%, 10 ≈ 2%) to rank
rows. It's a rule of thumb for prioritising, not Google data or a forecast.

## Troubleshooting

**"Connect at … (code ABCD-1234), then ask again"**: open the link in any browser, sign in to Tag
Pilot, check the code, approve, and allow Search Console access. Then repeat the request. The code
is valid for 10 minutes. From a terminal (e.g. over SSH): `npx -y @tagpilot/search-console-mcp login`.

**"The signed-in Google account has no access to the Search Console property …"**: use
`list_sites` and pass `site_url` exactly as listed (`sc-domain:` for domain properties, trailing
slash for URL prefixes). To use another Google account, run
`npx -y @tagpilot/search-console-mcp logout` and connect again.

**"This computer was disconnected from Tag Pilot"**: the device was revoked; ask again to
reconnect. **"Your Google sign-in expired or was revoked"**: ask again and approve again.

**Quota errors**: wait a few minutes (Search Analytics) or until tomorrow (URL Inspection).

**Check the setup**: `npx -y @tagpilot/search-console-mcp status`. Logs go to stderr.

## Configuration

Nothing is required. All variables are optional:

| Variable | |
|---|---|
| `TAGPILOT_API_KEY` | A `gsc:mcp` key for headless/CI setups. Skips the device connect. |
| `TAGPILOT_API_URL` | Tag Pilot API base URL. Default `https://api.tagpilot.io`. |
| `SEARCH_CONSOLE_MCP_NO_BROWSER` | `1` to only print/return the link instead of opening a browser. |
| `SEARCH_CONSOLE_MCP_BROWSER` | Browser to open (macOS app name, or a command on Linux/Windows). |
| `SEARCH_CONSOLE_MCP_AUTH_WAIT_SECONDS` | How long a tool call waits for the connect before returning the link. Default 45. |
| `SEARCH_CONSOLE_MCP_CONFIG_DIR` | Credential directory. Default `~/.config/tagpilot/search-console-mcp`. |

Commands: `npx -y @tagpilot/search-console-mcp [serve|login|logout|status|--help|--version]`.

## Development

See the [repo README](../../README.md). `SEARCH_CONSOLE_MCP_WEBMASTERS_API_URL` and
`SEARCH_CONSOLE_MCP_INSPECTION_API_URL` point the Google calls at a mock (used by `npm run e2e`).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Tag Concierge sp. z o.o. The license does
not cover the Tag Pilot name or logo (see [NOTICE](NOTICE)).
