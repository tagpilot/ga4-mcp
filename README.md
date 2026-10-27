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
   **GA4 MCP** page. It creates a key (`tpk_…`) and shows the install snippet.
2. **Add the server** to your MCP client (below). It needs Node.js 18 or newer.
3. **Ask something**, e.g. *"Which GA4 properties do I have?"* On the first call a browser window
   opens. Sign in with the Google account that can see your GA4 properties and approve
   *"See and download your Google Analytics data"*. Then ask again.

### Claude Code

```bash
claude mcp add ga4 --env TAGPILOT_API_KEY=tpk_... -- npx -y @tagpilot/ga4-mcp
```

### Claude Desktop

In `claude_desktop_config.json` (Settings → Developer → Edit Config):

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

### Cursor

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

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

Other clients (VS Code, Windsurf, Zed, …) take the same `command`, `args` and `env`.

## How sign-in works, and what Tag Pilot sees

```
your machine                                  Tag Pilot API                Google
─────────────────────────────────────────    ─────────────────────        ─────────────────
ga4-mcp starts a listener on 127.0.0.1  ──►  POST …/ga4/oauth/session
(PKCE verifier stays on your machine)        returns a Google sign-in URL
browser: Google consent (read-only)   ─────────────────────────────────►  accounts.google.com
                                     ◄──── 302 to 127.0.0.1/callback ◄──  (via api.tagpilot.io)
ga4-mcp exchanges the code             ──►  POST …/ga4/oauth/token  ──►   oauth2.googleapis.com
token saved in ~/.config/tagpilot/ga4-mcp (mode 600)
GA4 API calls  ───────────────────────────────────────────────────────►  analytics*.googleapis.com
```

- **Your GA4 data goes from your machine straight to Google.** Reports, property settings and
  everything else the tools read never pass through Tag Pilot.
- **Tag Pilot only brokers the token exchange.** Its API adds Tag Pilot's Google OAuth client
  credentials to Google's token endpoint and returns Google's answer. It **stores no Google
  tokens** and never logs them; it records only that an exchange happened and for which API key
  (the "last used" time on your GA4 MCP page).
- **Read-only.** The only Google scope requested is `analytics.readonly`. None of the tools can
  change anything in GA4.
- **The refresh token stays on your machine**, in `~/.config/tagpilot/ga4-mcp/<id>.json`
  (readable only by you). Access tokens are refreshed through Tag Pilot about once an hour.
- **Revoking:** delete the key on app.tagpilot.io to stop refreshes, run
  `npx -y @tagpilot/ga4-mcp logout` to delete the local token, and remove the app's access at
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
`transactionId`, and `check_traffic_attribution` flags Unassigned traffic above 5%. They cost the
same GA4 quota as the equivalent reports (3–4 report calls).

## Troubleshooting

**"TAGPILOT_API_KEY is not set"**: add the key to the server's `env` in your MCP client config
(see above) and restart or reconnect the server.

**"Tag Pilot rejected TAGPILOT_API_KEY" / "does not have the ga4:mcp scope"**: create a new key on
the GA4 MCP page at [app.tagpilot.io](https://app.tagpilot.io). Keys made elsewhere in the app have
other scopes.

**"Waiting for you to sign in with Google"**: finish the sign-in in the browser window that opened
(or open the URL from the message), then repeat the request. The sign-in link is valid for 10
minutes. No browser opened? Over SSH or in a container, run the sign-in in a terminal on the same
machine with `npx -y @tagpilot/ga4-mcp login` (with the same `TAGPILOT_API_KEY`). If the browser
runs on another machine, set a fixed port with `GA4_MCP_OAUTH_PORT=53682` and forward it
(`ssh -L 53682:127.0.0.1:53682 host`).

**"Your Google sign-in for GA4 expired or was revoked"**: the saved token was removed. Call any
tool again and sign in again. Google expires refresh tokens after 6 months without use, when you
revoke access, or when you change your password.

**"The signed-in Google account has no access to property …"**: that Google account needs at
least the Viewer role on the GA4 property. Use `get_account_summaries` to see what it can read. To
use a different Google account, run `npx -y @tagpilot/ga4-mcp logout` and sign in again.

**"Google hasn't verified this app"**: shown while Tag Pilot's Google verification is pending
(beta). Click *Advanced → Go to Tag Pilot*.

**Quota errors**: GA4 Data API quotas are per property and refill hourly and daily. Use shorter
date ranges, fewer dimensions or lower limits, and pass `return_property_quota: true` to see what's
left.

**Check the setup**: `npx -y @tagpilot/ga4-mcp status` shows the API URL, whether a key is set,
the token file and whether you're signed in. Logs go to stderr (stdout is the MCP channel); in
Claude Code see `claude --debug` or `/mcp`.

## Configuration

| Variable | |
|---|---|
| `TAGPILOT_API_KEY` | **Required.** Your `tpk_…` key from the GA4 MCP page. |
| `TAGPILOT_API_URL` | Tag Pilot API base URL. Default `https://api.tagpilot.io`. |
| `GA4_MCP_OAUTH_PORT` | Fixed local port for the sign-in callback (1024–65535). Default: random. |
| `GA4_MCP_NO_BROWSER` | `1` to only print/return the sign-in URL. |
| `GA4_MCP_BROWSER` | Browser to open (macOS app name, or a command on Linux/Windows). |
| `GA4_MCP_AUTH_WAIT_SECONDS` | How long a tool call waits for the browser sign-in before returning "finish signing in". Default 45 (MCP clients often time out at 60 s). |
| `GA4_MCP_CONFIG_DIR` | Token directory. Default `~/.config/tagpilot/ga4-mcp`. |

Commands: `npx -y @tagpilot/ga4-mcp [serve|login|logout|status|--help|--version]`. Without a
command it runs the MCP server on stdio.

## Development

```bash
npm install
npm run check      # typecheck + lint + unit tests
npm run build      # → dist/
npm run e2e        # built server over stdio against a mock broker and mock Google
```

The broker contract with the Tag Pilot API is in the Tag Pilot repo,
`explorations/ga4-mcp/api-contract.md`.

**Development mode (no broker).** To work without the Tag Pilot API, use your own Google Cloud
**Desktop app** OAuth client (with the Google Analytics Admin API and Data API enabled):

```bash
GA4_MCP_DEV_GOOGLE_CLIENT_ID=… GA4_MCP_DEV_GOOGLE_CLIENT_SECRET=… node dist/index.js login
```

Then the server talks to Google directly and doesn't need `TAGPILOT_API_KEY`. It's for development
only and not a supported way to run the published package. `GA4_MCP_ADMIN_API_URL` and
`GA4_MCP_DATA_API_URL` point the API calls at a mock (used by `npm run e2e`).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Tag Concierge sp. z o.o. The license does
not cover the Tag Pilot name or logo (see [NOTICE](NOTICE)).
