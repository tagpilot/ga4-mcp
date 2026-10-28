# Tag Pilot GA4

The `ga4` MCP server reads Google Analytics 4 data for the signed-in Google account. Every tool is
read-only: it can't change anything in GA4.

- **Start with `get_account_summaries`** to list the accounts and properties the user can read.
  Tools take the numeric property ID (e.g. `123456789`), not a `G-XXXX` measurement ID. If the
  user names a site or property, match it against the summaries; if several match, ask which
  one. Use `get_property_details` for the time zone, currency and data streams.
- **Reports:** `run_report` for most questions, `run_realtime_report` for the last 30 minutes
  (e.g. "is my new tag firing?"), `run_funnel_report` for step-by-step conversion. Use GA4 API
  names for dimensions and metrics (`sessionDefaultChannelGroup`, `sessions`, `purchaseRevenue`);
  call `get_custom_dimensions_and_metrics` for custom ones (`customEvent:…`). Keep date ranges
  and row limits small and follow `next_offset` only when needed; quotas are per property.
- **Tracking health:** `check_duplicate_transactions` and `check_traffic_attribution` are quick
  audits of purchase deduplication and Unassigned / `(not set)` traffic.
- **Connecting:** no API key is needed. If the user asks to connect, call `connect`; a data tool that
  isn't connected yet says "Not connected yet" with the same link and code. Show the user the link
  (clickable) and the code exactly as given: they open it in any browser, sign in to (or create) a
  free Tag Pilot account, check the code, approve, and allow read-only Google Analytics access. When they
  say they're done, call `connection_status` or retry their original question. Never ask the user
  to run terminal commands.
- Mention the property and date range you used, and any sampling or thresholding `notes` in the
  result.
