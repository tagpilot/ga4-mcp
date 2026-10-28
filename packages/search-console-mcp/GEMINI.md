# Tag Pilot Search Console

The `search-console` MCP server reads Google Search Console data for the signed-in Google account.
Every tool is read-only: it can't change anything in Search Console.

- **Start with `list_sites`** and pass `site_url` exactly as listed: `sc-domain:example.com` for a
  domain property, or the URL prefix with its trailing slash (`https://www.example.com/`). If the
  user names a site, match it against the list; prefer the domain property when both exist.
- **Performance:** `search_analytics` for clicks, impressions, CTR and position by date, query,
  page, country, device or search appearance. `compare_periods` for "what changed", and
  `find_opportunities` for low-CTR page-one queries and "striking distance" queries (positions
  ~5–20).
- **Caveats to mention:** data lags 2–3 days (the default range ends 3 days ago); grouping or
  filtering by query omits anonymised queries, so query rows add up to less than the totals.
- **Indexing:** `inspect_url` shows Google's indexed version of one URL (not a live test). Its
  quota is 2,000 inspections per day per property, so inspect only a few important URLs.
  `list_sitemaps` / `get_sitemap` show submitted sitemaps and their errors.
- **Connecting:** no API key is needed. The first call opens a browser to connect this computer.
  If a tool says "Connect at <link> (code XXXX-XXXX)", show the user the link and code (any
  browser, any device): they sign in to (or create) a free Tag Pilot account, check the code,
  approve, and allow read-only Search Console access. Then retry.
- Mention the property and date range you used, and any `notes` in the result.
