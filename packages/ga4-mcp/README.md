# Tag Pilot GA4 MCP

A free, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for
**Google Analytics 4**. Ask Claude, Cursor or any MCP client about your GA4 data: reports,
funnels, realtime, property setup, and Tag Pilot tracking-health checks.

**No Google Cloud setup, no API key to copy.** You don't need a GCP project, OAuth client,
service account or `gcloud`. Add the server, ask a GA4 question, and approve once in your browser.

```bash
claude mcp add ga4 -- npx -y @tagpilot/ga4-mcp
```

## Get started

1. **Install** in your AI client (below). No configuration needed.
2. **Ask something**, e.g. *"Which GA4 properties do I have?"* The first time, a browser window
   opens (or your AI shows a link and a code like `ABCD-1234`):
   - sign in to your free [Tag Pilot](https://app.tagpilot.io) account, or create one;
   - check that the code matches and approve this computer;
   - sign in with the Google account that can see your GA4 properties and allow
     *"See and download your Google Analytics data"*.
3. **Ask again.** You're connected; the computer shows up under **Connected devices** on the
   [GA4 MCP page](https://app.tagpilot.io/ga4-mcp).

## Install

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=ga4&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB0YWdwaWxvdC9nYTQtbWNwIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_server-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=ga4&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40tagpilot%2Fga4-mcp%22%5D%7D)

| Client | How |
|---|---|
| Claude Desktop | [Download the extension](https://github.com/tagpilot/ga4-mcp/releases/latest/download/tagpilot-ga4-mcp.mcpb) and open it (no Node.js needed) |
| Claude Code | `claude mcp add ga4 -- npx -y @tagpilot/ga4-mcp` |
| Cursor | [Add to Cursor](https://cursor.com/install-mcp?name=ga4&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB0YWdwaWxvdC9nYTQtbWNwIl19), or `mcp.json` below |
| VS Code | [Install in VS Code](https://vscode.dev/redirect/mcp/install?name=ga4&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40tagpilot%2Fga4-mcp%22%5D%7D) |
| Gemini CLI | `gemini extensions install https://github.com/tagpilot/ga4-mcp` |
| Anything else | `npx -y @tagpilot/ga4-mcp` (stdio) |

Everything except the Claude Desktop extension runs the npm package with `npx`, so it needs
Node.js 18 or newer. The server is also listed in the
[MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.tagpilot/ga4-mcp`.

### Claude Desktop

Download [`tagpilot-ga4-mcp.mcpb`](https://github.com/tagpilot/ga4-mcp/releases/latest/download/tagpilot-ga4-mcp.mcpb)
and double-click it (or drag it into Settings → Extensions), click **Install** and enable it. Leave
the optional API key field empty. The extension bundles the server and runs on Claude Desktop's
built-in Node.js.

Prefer the config file? In `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "ga4": {
      "command": "npx",
      "args": ["-y", "@tagpilot/ga4-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add ga4 -- npx -y @tagpilot/ga4-mcp
```

### Cursor

Use [Add to Cursor](https://cursor.com/install-mcp?name=ga4&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB0YWdwaWxvdC9nYTQtbWNwIl19), or add to `~/.cursor/mcp.json` (or
`.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "ga4": {
      "command": "npx",
      "args": ["-y", "@tagpilot/ga4-mcp"]
    }
  }
}
```

### VS Code

Use [Install in VS Code](https://vscode.dev/redirect/mcp/install?name=ga4&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40tagpilot%2Fga4-mcp%22%5D%7D), or run **MCP: Add Server** → *Command (stdio)* with
`npx -y @tagpilot/ga4-mcp`.

### Gemini CLI

```bash
gemini extensions install https://github.com/tagpilot/ga4-mcp
```

Other clients (Windsurf, Zed, …) take the same `command` and `args`.

### Headless and CI: an API key instead

Where nobody can approve in a browser, create a key on the
[GA4 MCP page](https://app.tagpilot.io/ga4-mcp) and set `TAGPILOT_API_KEY=tpk_…` in the server's
environment (e.g. `claude mcp add ga4 --env TAGPILOT_API_KEY=tpk_... -- npx -y @tagpilot/ga4-mcp`).
With a key, the device connect is skipped and only the Google sign-in link is shown.

## How connecting works, and what Tag Pilot sees

```
your machine                              Tag Pilot                          Google
──────────────────────────────────────   ───────────────────────────       ──────────────────────
ga4-mcp makes a PKCE verifier       ──►  POST /v3/public/ga4/device
(it never leaves your machine)           returns a link + code ABCD-1234
any browser, any device: app.tagpilot.io/connect: log in, check the code, approve
  → creates a ga4:mcp key for this device → Google consent (read-only) ─►  accounts.google.com
                                         …/ga4/oauth/callback  ◄──────  one-time code
ga4-mcp polls for the result        ──►  POST /v3/public/ga4/device/token
                                         returns the device key + code
ga4-mcp exchanges code + verifier   ──►  POST …/ga4/oauth/token  ──►    oauth2.googleapis.com
device key + Google tokens saved in ~/.config/tagpilot/ga4-mcp/device.json (mode 600)
GA4 API calls  ─────────────────────────────────────────────────────►  analytics*.googleapis.com
```

**It works from any browser**, like `gh auth login`: nothing listens on your machine, so it also
works over SSH, in containers, in WSL or on a remote dev box. Open the link wherever you have a
browser (even your phone) and approve; the server notices within a couple of seconds.

- **Your GA4 data goes from your machine straight to Google.** Reports, property settings and
  everything else the tools read never pass through Tag Pilot.
- **Tag Pilot only brokers the token exchange.** Its API adds Tag Pilot's Google OAuth client
  credentials to Google's token endpoint and returns Google's answer. It **stores no Google
  tokens** and never logs them. The only thing it holds is the one-time sign-in code from the
  Google callback, for at most 10 minutes until your machine collects it; that code is useless
  without the PKCE verifier that stays on your machine. It records only that an exchange
  happened and for which device (the "last used" time on your GA4 MCP page).
- **Read-only.** The only Google scope requested is `analytics.readonly`. None of the tools can
  change anything in GA4.
- **Your credentials stay on your machine**, in `~/.config/tagpilot/ga4-mcp/device.json`
  (readable only by you): the device's own Tag Pilot key and the Google refresh token. Access
  tokens are refreshed through Tag Pilot about once an hour.
- **Disconnecting:** revoke the device under **Connected devices** on the
  [GA4 MCP page](https://app.tagpilot.io/ga4-mcp) to stop refreshes, run
  `npx -y @tagpilot/ga4-mcp logout` to delete the local credential, and remove the app's access at
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

**"Connect at … (code ABCD-1234), then ask again"**: open the link in any browser (it doesn't
have to be on this machine), sign in to Tag Pilot, check that the code matches, approve, and allow
Google Analytics access. Then repeat the request. The server keeps checking in the background, so
you don't need to restart anything. The code is valid for 10 minutes; after that, ask again to get
a new one. To connect from a terminal instead (e.g. over SSH), run
`npx -y @tagpilot/ga4-mcp login`: it prints the link and code and waits until you approve.

**"This computer was disconnected from Tag Pilot"**: the device was revoked on the GA4 MCP page,
so its saved credential was removed. Ask again to connect it again.

**"Your Google sign-in for GA4 expired or was revoked"**: the saved sign-in was removed. Ask again
and approve again. Google expires refresh tokens after 6 months without use or when you revoke
access, and may also expire them after a password change.

**"The signed-in Google account has no access to property …"**: that Google account needs at
least the Viewer role on the GA4 property. Use `get_account_summaries` to see what it can read. To
use a different Google account, run `npx -y @tagpilot/ga4-mcp logout` and connect again.

**"Google hasn't verified this app"**: shown while Tag Pilot's Google verification is pending
(beta). Click *Advanced → Go to Tag Pilot*.

**Quota errors**: GA4 Data API quotas are per property and refill hourly and daily. Use shorter
date ranges, fewer dimensions or lower limits, and pass `return_property_quota: true` to see what's
left.

**With `TAGPILOT_API_KEY`**: "Tag Pilot rejected TAGPILOT_API_KEY" / "does not have the ga4:mcp
scope" means the key was revoked or made elsewhere in the app; create one on the GA4 MCP page, or
remove the variable to use the device connect. Sign-in then shows "Finish signing in with Google at
…, then ask again".

**Check the setup**: `npx -y @tagpilot/ga4-mcp status` shows whether this computer is connected
(with the first characters of its Tag Pilot key) and the Google sign-in state. Logs go to stderr
(stdout is the MCP channel); in Claude Code see `claude --debug` or `/mcp`.

## Configuration

Nothing is required. All variables are optional:

| Variable | |
|---|---|
| `TAGPILOT_API_KEY` | A `ga4:mcp` key (`tpk_…`) from the GA4 MCP page, for headless/CI setups. Skips the device connect; its sign-in is saved per key. |
| `TAGPILOT_API_URL` | Tag Pilot API base URL. Default `https://api.tagpilot.io`. |
| `GA4_MCP_NO_BROWSER` | `1` to only print/return the link instead of opening a browser. |
| `GA4_MCP_BROWSER` | Browser to open (macOS app name, or a command on Linux/Windows). |
| `GA4_MCP_AUTH_WAIT_SECONDS` | How long a tool call waits for the connect before returning the link (connecting keeps going in the background). Default 45 (MCP clients often time out at 60 s). |
| `GA4_MCP_CONFIG_DIR` | Credential directory. Default `~/.config/tagpilot/ga4-mcp`. |

Commands: `npx -y @tagpilot/ga4-mcp [serve|login|logout|status|--help|--version]`. Without a
command it runs the MCP server on stdio. `logout` removes this computer's connection (and any
saved `TAGPILOT_API_KEY` sign-ins); with `TAGPILOT_API_KEY` set, only that key's. Revoke the
device itself on the GA4 MCP page.

## Development

This package lives in the [tagpilot/ga4-mcp](https://github.com/tagpilot/ga4-mcp) monorepo next to
[`@tagpilot/search-console-mcp`](../search-console-mcp); both share the Tag Pilot connect and
CLI code in `packages/mcp-core`. From the repo root:

```bash
npm install
npm run check      # typecheck + lint + unit tests (all packages)
npm run build      # → packages/*/dist/index.js (esbuild bundles the shared core in)
npm run e2e        # built servers over stdio against a mock broker and mock Google
npm run mcpb       # Claude Desktop extensions → packages/*/tagpilot-<name>-<version>.mcpb
npm run mcpb:smoke # unpack each bundle, check its tools, run the e2e against it
```

The version lives in `package.json`, `src/version.ts`, `server.json` (MCP Registry),
`mcpb/manifest.json` and the repo-root `gemini-extension.json` (Gemini CLI installs extensions
from a repo root); `npm test` fails if they drift apart. Release steps are in the Tag Pilot repo,
`explorations/ga4-mcp/distribution.md`.

The broker contract with the Tag Pilot API is in the Tag Pilot repo,
`explorations/ga4-mcp/api-contract.md`.

For local testing, point `TAGPILOT_API_URL` at a local or beta tc-api (`http://localhost:8000`,
`https://beta-api.tagpilot.io`). `GA4_MCP_ADMIN_API_URL` and `GA4_MCP_DATA_API_URL` point the GA4
calls at a mock (used by `npm run e2e`).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Tag Concierge sp. z o.o. The license does
not cover the Tag Pilot name or logo (see [NOTICE](NOTICE)).
