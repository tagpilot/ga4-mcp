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
- **Sign-in:** the first call opens a browser for Google sign-in. If a tool says "Finish signing
  in with Google at <link>", show the user the link (it works in any browser, on any device), ask
  them to approve, then retry. If it says `TAGPILOT_API_KEY` is not set, tell the user to get a free key at
  https://app.tagpilot.io/ga4-mcp and run `gemini extensions config tagpilot-ga4`.
- Mention the property and date range you used, and any sampling or thresholding `notes` in the
  result.
