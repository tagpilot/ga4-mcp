# Tag Pilot GA4 MCP

A free, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for
**Google Analytics 4**. Ask Claude, Cursor or any MCP client about your GA4 data: reports,
funnels, realtime, property setup, and Tag Pilot tracking-health checks.

**No Google Cloud setup.** You don't need your own GCP project, OAuth client, service account or
`gcloud`. Add the server, sign in with Google in your browser once, and you're done.

```bash
claude mcp add ga4 --env TAGPILOT_API_KEY=tpk_... -- npx -y @tagpilot/ga4-mcp
```

## Get started

1. **Get a free API key.** Sign up at [app.tagpilot.io](https://app.tagpilot.io) and open the
   [**GA4 MCP**](https://app.tagpilot.io/ga4-mcp) page. It creates a key (`tpk_…`) and, right
   after that, shows install buttons and snippets with the key filled in.
2. **Install** in your AI client (below).
3. **Ask something**, e.g. *"Which GA4 properties do I have?"* On the first call a browser window
   opens. Sign in with the Google account that can see your GA4 properties and approve
   *"See and download your Google Analytics data"*. Then ask again.

## Install

| Client | How |
|---|---|
| Claude Desktop | [Download the extension](https://github.com/tagpilot/ga4-mcp/releases/latest/download/tagpilot-ga4-mcp.mcpb) and open it (no Node.js needed) |
| Claude Code | `claude mcp add ga4 --env TAGPILOT_API_KEY=tpk_... -- npx -y @tagpilot/ga4-mcp` |
| Cursor | **Add to Cursor** button on [app.tagpilot.io/ga4-mcp](https://app.tagpilot.io/ga4-mcp), or `mcp.json` below |
| VS Code | **Install in VS Code** button on [app.tagpilot.io/ga4-mcp](https://app.tagpilot.io/ga4-mcp) or [tagpilot.io/ga4-mcp](https://tagpilot.io/ga4-mcp) |
| Gemini CLI | `gemini extensions install https://github.com/tagpilot/ga4-mcp` |
| Anything else | `npx -y @tagpilot/ga4-mcp` with `TAGPILOT_API_KEY` in its environment |

Everything except the Claude Desktop extension runs the npm package with `npx`, so it needs
Node.js 18 or newer. The server is also listed in the
[MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.tagpilot/ga4-mcp`.

### Claude Desktop

Download [`tagpilot-ga4-mcp.mcpb`](https://github.com/tagpilot/ga4-mcp/releases/latest/download/tagpilot-ga4-mcp.mcpb)
and double-click it (or drag it into Settings → Extensions). Click **Install**, paste your
`tpk_…` key, and enable it. The extension bundles the server and runs on Claude Desktop's
built-in Node.js.

Prefer the config file? In `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "ga4": {
      "command": "npx",
      "args": ["-y", "@tagpilot/ga4-mcp"],
      "env": { "TAGPILOT_API_KEY": "tpk_..." }
    }
  }
}
```

### Claude Code

```bash
claude mcp add ga4 --env TAGPILOT_API_KEY=tpk_... -- npx -y @tagpilot/ga4-mcp
```

### Cursor

Use the **Add to Cursor** button on the GA4 MCP page, or add to `~/.cursor/mcp.json` (or
`.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "ga4": {
      "command": "npx",
      "args": ["-y", "@tagpilot/ga4-mcp"],
      "env": { "TAGPILOT_API_KEY": "tpk_..." }
    }
  }
}
```

### VS Code

Use the **Install in VS Code** button, or run **MCP: Add Server** → *Command (stdio)* with
`npx -y @tagpilot/ga4-mcp` and set `TAGPILOT_API_KEY` in the server's `env` in `mcp.json`.

### Gemini CLI

```bash
gemini extensions install https://github.com/tagpilot/ga4-mcp
```

It asks for your Tag Pilot API key (stored in your system keychain). Change it later with
`gemini extensions config tagpilot-ga4`.

Other clients (Windsurf, Zed, …) take the same `command`, `args` and `env`.

## How sign-in works, and what Tag Pilot sees

```
your machine                              Tag Pilot API                     Google
──────────────────────────────────────   ──────────────────────────        ──────────────────────
ga4-mcp makes a PKCE verifier       ──►  POST …/ga4/oauth/session
(it never leaves your machine)           returns a Google sign-in link
any browser, any device: Google consent (read-only) ─────────────────►  accounts.google.com
                                         …/ga4/oauth/callback  ◄──────  one-time code
ga4-mcp polls for the result        ──►  POST …/session/{id}/result
ga4-mcp exchanges the code + verifier ►  POST …/ga4/oauth/token  ──►    oauth2.googleapis.com
token saved in ~/.config/tagpilot/ga4-mcp (mode 600)
GA4 API calls  ─────────────────────────────────────────────────────►  analytics*.googleapis.com
```

**Sign-in works from any browser**, like `npm login`: nothing listens on your machine, so it also
works over SSH, in containers, in WSL or on a remote dev box. Open the link wherever you have a
browser (even your phone) and approve; the server notices within a couple of seconds.

- **Your GA4 data goes from your machine straight to Google.** Reports, property settings and
  everything else the tools read never pass through Tag Pilot.
- **Tag Pilot only brokers the token exchange.** Its API adds Tag Pilot's Google OAuth client
  credentials to Google's token endpoint and returns Google's answer. It **stores no Google
  tokens** and never logs them. The only thing it holds is the one-time sign-in code from the
  Google callback, for at most 10 minutes until your machine collects it; that code is useless
  without the PKCE verifier that stays on your machine. It it records only that an exchange happened and for which API key
  (the "last used" time on your GA4 MCP page).
- **Read-only.** The only Google scope requested is `analytics.readonly`. None of the tools can
  change anything in GA4.
- **The refresh token stays on your machine**, in `~/.config/tagpilot/ga4-mcp/<id>.json`
  (readable only by you). Access tokens are refreshed through Tag Pilot about once an hour.
- **Revoking:** delete the key on app.tagpilot.io to stop refreshes, run
  `npx -y @tagpilot/ga4-mcp logout` to delete the local tokens, and remove the app's access at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Tools

All tools are read-only. Property IDs are the numeric GA4 IDs (e.g. `123456789`), not `G-XXXX`
measurement IDs.

| Tool | What it does |
|---|---|
| `get_account_summaries` | All GA4 accounts and properties you can read, with property IDs. Start here. |
| `get_property_details` | Time zone, currency, industry, standard/360, and data streams with measurement IDs. |
| `list_google_ads_links` | Linked Google Ads accounts. |
| `list_property_annotations` | Reporting annotations (releases, tracking changes, campaigns). |
| `get_custom_dimensions_and_metrics` | Custom dimensions/metrics with API names (`customEvent:…`); optionally the standard ones, searchable. |
| `run_report` | The Data API report: dimensions, metrics, date ranges, filters, ordering, paging, totals. |
| `run_realtime_report` | The last 30 minutes (60 on GA4 360). Handy to check a tracking change is live. |
| `run_funnel_report` | Funnels from event steps (with parameter and dimension conditions), open or closed, breakdowns, next actions, trended. Uses Google's v1alpha API. |
| `check_duplicate_transactions` | **Tag Pilot check.** Purchase events per `transaction_id`: duplicate rate, worst duplicated IDs, purchases without an ID. |
| `check_traffic_attribution` | **Tag Pilot check.** Sessions per channel group plus the share of Unassigned, `(not set)` source, `(not set)` landing page and Direct, with likely causes. |

### Report inputs

- **Dates:** `YYYY-MM-DD`, `today`, `yesterday` or `NdaysAgo` (e.g. `28daysAgo`). Default: the last
  28 full days. Up to 4 ranges; several ranges add a `dateRange` column.
- **Dimensions and metrics:** GA4 API names, e.g. `date`, `eventName`, `sessionSourceMedium`,
  `pagePath`, `sessions`, `activeUsers`, `purchaseRevenue`
  ([full list](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)).
- **Filters:** a list of conditions that must all match; `{"any": [...]}` groups conditions with
  OR, and `"not": true` negates one:

  ```json
  [
    {"field": "eventName", "op": "exact", "value": "purchase"},
    {"field": "country", "op": "in_list", "values": ["Poland", "Germany"], "not": true},
    {"any": [
      {"field": "pagePath", "op": "begins_with", "value": "/shop"},
      {"field": "pagePath", "op": "partial_regex", "value": "product"}
    ]}
  ]
  ```

  Ops: `exact`, `contains`, `begins_with`, `ends_with`, `full_regex`, `partial_regex`, `in_list`,
  `eq`, `lt`, `lte`, `gt`, `gte`, `between` (`from`/`to`), `empty`. Dimension and metric filters
  are separate inputs, like in the GA4 API.
- **Ordering:** `[{"field": "sessions", "desc": true}]`. Use `dimension_order: "numeric"` for
  numeric-looking dimensions.
- **Output:** rows are objects such as `{"date": "20261026", "sessions": 321}`. Default limit is
  100 rows; `next_offset` tells you when there are more. Thresholding, sampling and `(other)` rows
  are reported in `notes`.

### About the tracking-health checks

They're opinionated rules of thumb built from a few `run_report` calls, and each result shows what
it measured. For example, `check_duplicate_transactions` counts `purchase` events grouped by
`transactionId`, and `check_traffic_attribution` flags Unassigned traffic at 5% or more. They cost the
same GA4 quota as the equivalent reports (3–4 report calls).

## Troubleshooting

**"TAGPILOT_API_KEY is not set"**: add the key to the server's `env` in your MCP client config
(see above) and restart or reconnect the server.

**"Tag Pilot rejected TAGPILOT_API_KEY" / "does not have the ga4:mcp scope"**: create a new key on
the GA4 MCP page at [app.tagpilot.io](https://app.tagpilot.io). Keys made elsewhere in the app have
other scopes.

**"Finish signing in with Google at …, then ask again"**: open the link in any browser (it
doesn't have to be on this machine), approve read-only access, then repeat the request. The
server keeps checking in the background, so you don't need to restart anything. The link is
valid for 10 minutes; after that, ask again to get a new one. To sign in from a terminal instead
(e.g. over SSH), run `TAGPILOT_API_KEY=tpk_… npx -y @tagpilot/ga4-mcp login`: it prints the link
and waits until you approve.

**"Your Google sign-in for GA4 expired or was revoked"**: the saved token was removed. Call any
tool again and sign in again. Google expires refresh tokens after 6 months without use or when you
revoke access, and may also expire them after a password change.

**"The signed-in Google account has no access to property …"**: that Google account needs at
least the Viewer role on the GA4 property. Use `get_account_summaries` to see what it can read. To
use a different Google account, run `npx -y @tagpilot/ga4-mcp logout` and sign in again.

**"Google hasn't verified this app"**: shown while Tag Pilot's Google verification is pending
(beta). Click *Advanced → Go to Tag Pilot*.

**Quota errors**: GA4 Data API quotas are per property and refill hourly and daily. Use shorter
date ranges, fewer dimensions or lower limits, and pass `return_property_quota: true` to see what's
left.

**Check the setup**: `npx -y @tagpilot/ga4-mcp status` shows the API URL and every saved Google
sign-in on this machine. Your key normally lives only in your MCP client's config, so `status` and
`logout` don't need it. Add `TAGPILOT_API_KEY=tpk_…` in front to check or log out one key only.
`login` does need the key (`TAGPILOT_API_KEY=tpk_… npx -y @tagpilot/ga4-mcp login`), but you
rarely need it: the first GA4 question in your AI tool opens the sign-in. Logs go to stderr (stdout is the MCP channel); in
Claude Code see `claude --debug` or `/mcp`.

## Configuration

| Variable | |
|---|---|
| `TAGPILOT_API_KEY` | **Required** for the server and `login` (set it in your MCP client's config). Your `tpk_…` key from the GA4 MCP page. |
| `TAGPILOT_API_URL` | Tag Pilot API base URL. Default `https://api.tagpilot.io`. |
| `GA4_MCP_NO_BROWSER` | `1` to only print/return the sign-in link instead of opening a browser. |
| `GA4_MCP_BROWSER` | Browser to open (macOS app name, or a command on Linux/Windows). |
| `GA4_MCP_AUTH_WAIT_SECONDS` | How long a tool call waits for the sign-in before returning "finish signing in" with the link (sign-in keeps going in the background). Default 45 (MCP clients often time out at 60 s). |
| `GA4_MCP_CONFIG_DIR` | Token directory. Default `~/.config/tagpilot/ga4-mcp`. |

Commands: `npx -y @tagpilot/ga4-mcp [serve|login|logout|status|--help|--version]`. Without a
command it runs the MCP server on stdio. `logout` without a key removes every saved sign-in;
with `TAGPILOT_API_KEY` set, only that key's. Each key has its own token file, so after switching
keys the old key's sign-in stays until you run `logout` without a key.

## Development

```bash
npm install
npm run check      # typecheck + lint + unit tests
npm run build      # → dist/
npm run e2e        # built server over stdio against a mock broker and mock Google
npm run mcpb       # Claude Desktop extension → tagpilot-ga4-mcp-<version>.mcpb (+ tagpilot-ga4-mcp.mcpb)
npm run mcpb:smoke # unpack the bundle, check its tools, run the e2e against it
```

The version lives in `package.json`, `src/version.ts`, `server.json` (MCP Registry),
`gemini-extension.json` and `mcpb/manifest.json`; `npm test` fails if they drift apart. Release
steps are in the Tag Pilot repo, `explorations/ga4-mcp/distribution.md`.

The broker contract with the Tag Pilot API is in the Tag Pilot repo,
`explorations/ga4-mcp/api-contract.md`.

For local testing, point `TAGPILOT_API_URL` at a local or beta tc-api (`http://localhost:8000`,
`https://beta-api.tagpilot.io`). `GA4_MCP_ADMIN_API_URL` and `GA4_MCP_DATA_API_URL` point the GA4
calls at a mock (used by `npm run e2e`).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Tag Concierge sp. z o.o. The license does
not cover the Tag Pilot name or logo (see [NOTICE](NOTICE)).
