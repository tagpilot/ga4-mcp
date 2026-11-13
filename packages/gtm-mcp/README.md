# Tag Pilot GTM MCP

A free, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for
**Google Tag Manager**. Ask Claude, Cursor or any MCP client about your GTM containers: which tags
fire on which triggers, how a variable is set up and what uses it, what publishing a workspace
would change, the version history, and a Tag Pilot audit of the container.

**No Google Cloud setup, no API key to copy.** You don't need a GCP project, OAuth client,
service account or `gcloud`. Add the server, ask a question, and approve once in your browser.

```bash
claude mcp add gtm -- npx -y @tagpilot/gtm-mcp
```

## Get started

1. **Install** in your AI client (below). No configuration needed.
2. **Ask something**, e.g. *"Audit my GTM container GTM-ABC1234"* or *"What changes in the
   Default Workspace aren't published yet?"* The first time, a browser window opens (or your AI
   shows a link and a code like `ABCD-1234`):
   - sign in to your free [Tag Pilot](https://app.tagpilot.io) account, or create one;
   - check that the code matches and approve this computer;
   - sign in with the Google account that can see your Tag Manager containers and allow
     read-only Tag Manager access.
3. **Ask again.** You're connected; the computer shows up under **Connected devices** on the
   [GTM MCP page](https://app.tagpilot.io/gtm-mcp).

Already use the [Tag Pilot GA4 MCP](../ga4-mcp) or [Search Console MCP](../search-console-mcp)?
This is a separate server with its own connection (and its own Google consent), so you can install
any of them.

## Install

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=gtm&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB0YWdwaWxvdC9ndG0tbWNwIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_server-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=gtm&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40tagpilot%2Fgtm-mcp%22%5D%7D)

| Client | How |
|---|---|
| Claude Desktop | [Download the extension](https://github.com/tagpilot/ga4-mcp/releases/latest/download/tagpilot-gtm-mcp.mcpb) and open it (no Node.js needed) |
| Claude Code | `claude mcp add gtm -- npx -y @tagpilot/gtm-mcp` |
| Cursor | [Add to Cursor](https://cursor.com/install-mcp?name=gtm&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB0YWdwaWxvdC9ndG0tbWNwIl19), or the `mcp.json` below |
| VS Code | [Install in VS Code](https://vscode.dev/redirect/mcp/install?name=gtm&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40tagpilot%2Fgtm-mcp%22%5D%7D) |
| Windsurf, Zed, … | command `npx`, args `["-y", "@tagpilot/gtm-mcp"]` (stdio) |
| Gemini CLI | clone the repo, then `gemini extensions install ./ga4-mcp/packages/gtm-mcp` |

Everything except the Claude Desktop extension runs the npm package with `npx`, so it needs
Node.js 18 or newer. In the [MCP Registry](https://registry.modelcontextprotocol.io) it's
`io.github.tagpilot/gtm-mcp`.

Claude Desktop config file (`claude_desktop_config.json`), Cursor (`~/.cursor/mcp.json`) and
similar clients:

```json
{
  "mcpServers": {
    "gtm": {
      "command": "npx",
      "args": ["-y", "@tagpilot/gtm-mcp"]
    }
  }
}
```

**Headless and CI:** where nobody can approve in a browser, create a `gtm:mcp` key on the
[GTM MCP page](https://app.tagpilot.io/gtm-mcp) and set `TAGPILOT_API_KEY=tpk_…` in the server's
environment. The device connect is then skipped and only the Google sign-in link is shown.

## How connecting works, and what Tag Pilot sees

The same flow as the GA4 MCP (RFC 8628-style device connect, like `gh auth login`): it works from
any browser on any device, also over SSH, in containers or WSL, because nothing listens on your
machine.

- **Your Tag Manager data goes from your machine straight to Google**
  (`tagmanager.googleapis.com`). It never passes through Tag Pilot.
- **Tag Pilot only brokers the token exchange.** It adds Tag Pilot's Google OAuth client
  credentials to Google's token endpoint and returns Google's answer. It **stores no Google
  tokens** and never logs them; it holds the one-time sign-in code for at most 10 minutes, and that
  code is useless without the PKCE verifier that stays on your machine.
- **Read-only.** The only Google scope requested is `tagmanager.readonly`. None of the tools can
  create, change, publish or delete anything, and the server only sends GET requests.
- **Your credentials stay on your machine**, in `~/.config/tagpilot/gtm-mcp/device.json`
  (readable only by you).
- **Disconnecting:** revoke the device on the [GTM MCP page](https://app.tagpilot.io/gtm-mcp), run
  `npx -y @tagpilot/gtm-mcp logout`, and remove the app's access at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Tools

All tools are read-only. `container_id` is the numeric container ID from `list_containers`; the
public ID (`GTM-XXXXXXX`) works too. Tools that read container contents read the **live
(published) version** by default; pass `workspace_id` (from `list_workspaces`) for a workspace
with its unpublished changes, or `version_id` (from `list_versions`) for an older version.

| Tool | What it does |
|---|---|
| `list_accounts` | Tag Manager accounts you can read. Start here. |
| `list_containers` | Containers in an account: ID, public ID, name, usage context (web, server, …), domains. |
| `list_workspaces` | Workspaces of a container. |
| `get_container` | Tags (with firing/blocking triggers by name, paused state), triggers, variables, custom templates, folders and built-in variables; clients and transformations of server containers. Compact by default; `detail: "full"` returns every entity body. |
| `get_tag` / `get_trigger` / `get_variable` | One entity in full, by id or name: parameters, conditions, consent settings, sequencing, the variables it uses and what uses it. Built-in variables (`Page URL`) by name. |
| `find_references` | What uses a variable (`{{Name}}` anywhere), trigger (firing, blocking, trigger groups), tag (sequencing), custom template or folder. |
| `list_versions` | Versions, newest first, with entity counts and which one is live. |
| `get_live_version` | The published version: name, description and contents. |
| `diff` | Workspace vs the live version (or another version): entities added, changed (with the changed fields and renames; `include_values` for before/after) and deleted. |
| `audit_container` | **Tag Pilot check** (below). |
| `connect` | Connects this computer: returns a link and a code for you to approve in the browser (your AI shows them; clients that support MCP URL elicitation offer to open the link). Say *"connect my GTM"* to start it explicitly. |
| `connection_status` | Connected (with the device name), waiting for approval (link and code again), not connected, or what went wrong. Waits up to 25 s for an open sign-in to finish. |

### `audit_container`

Offline checks over one read of the container. They are rules of thumb, not GTM errors:

| Check | Severity | What it flags |
|---|---|---|
| `missing_triggers` | high | Tags, trigger groups or variables pointing at triggers that don't exist. |
| `duplicate_google_tags` | high | A Google tag (`googtag`) or GA4 configuration ID loaded by more than one active tag: double page views if they fire on the same page. |
| `tags_without_triggers` | medium | Active tags with no firing trigger that aren't fired by tag sequencing. |
| `tags_without_consent_settings` | medium | Web containers: active non-Google tags with consent settings "Not set". Google tags are skipped (built-in consent checks). |
| `unpublished_changes` | info | Workspace audits: changes not live yet (or a container that was never published). |
| `unused_triggers` / `unused_variables` | low | Not used by any tag, trigger or variable. Code reading variables through `google_tag_manager[…]` isn't detected. |
| `expired_schedules` | low | Tags whose schedule ended. |
| `paused_tags` | info | Paused tags. |

### Rate limits and caching

The Tag Manager API allows only a few requests per second per user and has a daily quota, so
the server is frugal:

- a container version (live or numbered) is **one** request; a workspace is one list request per
  entity kind (tags, triggers, variables, built-ins, templates, folders, plus clients and
  transformations for server containers), never one request per tag;
- `get_tag`, `get_trigger`, `get_variable`, `find_references` and `audit_container` reuse the same
  read, which is **cached for a minute** (numbered versions for 30 minutes);
- rate-limit errors (429, or 403 with a quota reason) and server errors are retried with backoff.

Workspace reads skip zones (Tag Manager 360); version reads include them.

## Troubleshooting

**"Not connected yet" (a link and a code like `ABCD-1234`)**: your AI shows them. Open the link in any browser (it doesn't
have to be on this machine), sign in to Tag Pilot, check that the code matches, approve, and allow Tag Manager
access, then tell your AI you're done: it retries your question (or calls `connection_status`). The server keeps
checking in the background, so nothing needs restarting. The code is valid for 10 minutes; after that, ask again (or
say "connect GTM") for a new one. To connect from a terminal instead (e.g. over SSH), run
`npx -y @tagpilot/gtm-mcp login`: it shows the link, the code in a box and a countdown, and waits until you approve.

**"The signed-in Google account has no access to …"**: use `list_accounts` and `list_containers`
to see what it can read. To use another Google account, run `npx -y @tagpilot/gtm-mcp logout`
and connect again.

**"… has no live (published) version"**: the container was never published; pass `workspace_id`.

**"This computer was disconnected from Tag Pilot"**: the device was revoked; ask again to
reconnect. **"Your Google sign-in expired or was revoked"**: ask again and approve again.

**Rate limit or quota errors**: wait a minute and ask again.

**Check the setup**: `npx -y @tagpilot/gtm-mcp status`. Logs go to stderr.

## Configuration

Nothing is required. All variables are optional:

| Variable | |
|---|---|
| `TAGPILOT_API_KEY` | A `gtm:mcp` key for headless/CI setups. Skips the device connect. |
| `TAGPILOT_API_URL` | Tag Pilot API base URL. Default `https://api.tagpilot.io`. |
| `GTM_MCP_NO_BROWSER` | `1` to only print/return the link instead of opening a browser. |
| `GTM_MCP_BROWSER` | Browser to open (macOS app name, or a command on Linux/Windows). |
| `GTM_MCP_AUTH_WAIT_SECONDS` | How long a tool call waits for the connect before returning the link. Default 45. |
| `GTM_MCP_CONFIG_DIR` | Credential directory. Default `~/.config/tagpilot/gtm-mcp`. |

Commands: `npx -y @tagpilot/gtm-mcp [serve|login|logout|status|--help|--version]`.

## Development

See the [repo README](../../README.md). `GTM_MCP_TAGMANAGER_API_URL` points the Google calls at a
mock (used by `npm run e2e`).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Tag Concierge sp. z o.o. The license does
not cover the Tag Pilot name or logo (see [NOTICE](NOTICE)).
