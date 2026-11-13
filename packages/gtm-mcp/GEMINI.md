# Tag Pilot GTM

The `gtm` MCP server reads Google Tag Manager containers for the signed-in Google account. Every
tool is read-only: it can't create, change, publish or delete anything in Tag Manager.

- **Start with `list_accounts`**, then `list_containers` (the numeric `container_id`; a public ID
  like `GTM-XXXXXXX` works too). If the user names a site or a GTM ID, match it against the lists.
- **What is read:** the live (published) version by default. Pass `workspace_id` (from
  `list_workspaces`) for unpublished changes, or `version_id` (from `list_versions`) for an older
  version. Say which one you read.
- **Overview, then detail:** `get_container` lists tags (with their triggers), triggers, variables,
  templates and folders compactly. `get_tag`, `get_trigger` and `get_variable` return one entity in
  full; `find_references` shows what uses a variable, trigger, tag or template. Check it before
  suggesting a change, rename or deletion.
- **Changes and health:** `diff` shows what publishing a workspace would add, change or delete
  compared with the live version. `audit_container` is a Tag Pilot health check (tags that never
  fire, unused triggers/variables, missing consent settings, duplicate Google tag IDs, unpublished
  changes); its findings are rules of thumb, so explain them rather than treat them as errors.
- **Rate limits:** the Tag Manager API allows few requests. Results are cached for a minute, so
  prefer one `get_container` and the `get_*` tools over repeated lists.
- **Connecting:** no API key is needed. If the user asks to connect, call `connect`; a data tool that
  isn't connected yet says "Not connected yet" with the same link and code. Show the user the link
  (clickable) and the code exactly as given: they open it in any browser, sign in to (or create) a
  free Tag Pilot account, check the code, approve, and allow read-only Tag Manager access. When they
  say they're done, call `connection_status` or retry their original question. Never ask the user
  to run terminal commands.
