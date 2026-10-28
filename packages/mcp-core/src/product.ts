// What differs between the Tag Pilot MCP servers that share this core (auth, CLI, Google HTTP).
export interface Product {
  /** Sent to the broker as D1 `product`. */
  id: 'ga4' | 'gsc';
  /** npm package, e.g. "@tagpilot/ga4-mcp". */
  npmName: string;
  /** Short slug: user agent `tagpilot-<slug>/<version>` and config dir ~/.config/tagpilot/<slug>. */
  slug: string;
  version: string;
  /** e.g. "Tag Pilot GA4 MCP". */
  title: string;
  /** The tc-app page with Connected devices and keys, e.g. https://app.tagpilot.io/ga4-mcp. */
  pageUrl: string;
  /** What the Google consent grants, e.g. "read-only Google Analytics access". */
  googleAccess: string;
  /** Prefix of this product's own env vars, e.g. "GA4_MCP" → GA4_MCP_NO_BROWSER. */
  envPrefix: string;
  /** The broker key scope, e.g. "ga4:mcp". */
  keyScope: string;
}

export const userAgent = (p: Product) => `tagpilot-${p.slug}/${p.version}`;
