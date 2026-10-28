// list_sites, list_sitemaps, get_sitemap
import { z } from 'zod';
import { normalizeSiteUrl } from './analytics.js';
import { READ_ONLY, safe, type ToolContext } from './common.js';
import { siteUrlSchema } from './schemas.js';

interface SiteEntry {
  siteUrl?: string;
  permissionLevel?: string;
}

interface Sitemap {
  path?: string;
  type?: string;
  isSitemapsIndex?: boolean;
  isPending?: boolean;
  lastSubmitted?: string;
  lastDownloaded?: string;
  errors?: string | number;
  warnings?: string | number;
  contents?: Array<{ type?: string; submitted?: string | number }>;
}

const PERMISSIONS: Record<string, string> = {
  siteOwner: 'owner',
  siteFullUser: 'full',
  siteRestrictedUser: 'restricted',
  siteUnverifiedUser: 'unverified',
};

export function compactSitemap(s: Sitemap) {
  return {
    path: s.path,
    type: s.type,
    is_index: s.isSitemapsIndex ?? false,
    is_pending: s.isPending ?? false,
    last_submitted: s.lastSubmitted,
    last_downloaded: s.lastDownloaded,
    errors: Number(s.errors ?? 0),
    warnings: Number(s.warnings ?? 0),
    // contents[].indexed is deprecated by Google ("do not use"), so only submitted counts are shown.
    submitted: (s.contents ?? []).map((c) => ({ type: c.type, submitted: Number(c.submitted ?? 0) })),
  };
}

export function registerSiteTools({ server, api }: ToolContext): void {
  server.registerTool(
    'list_sites',
    {
      title: 'List Search Console properties',
      description:
        'Lists every Search Console property the signed-in Google account can see: domain properties ("sc-domain:example.com", ' +
        'covering all subdomains and protocols) and URL-prefix properties ("https://www.example.com/"), with the permission level ' +
        '(owner, full, restricted, unverified). Start here: other tools need site_url exactly as listed.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const res = await api.listSites<{ siteEntry?: SiteEntry[] }>();
      const sites = (res.siteEntry ?? []).map((s) => ({
        site_url: s.siteUrl,
        type: s.siteUrl?.startsWith('sc-domain:') ? 'domain' : 'url_prefix',
        permission: PERMISSIONS[s.permissionLevel ?? ''] ?? s.permissionLevel,
      }));
      sites.sort((a, b) => String(a.site_url).localeCompare(String(b.site_url)));
      return {
        sites,
        ...(sites.some((s) => s.permission === 'unverified')
          ? { note: 'Properties with permission "unverified" are listed but their data can\'t be read.' }
          : {}),
      };
    }),
  );

  server.registerTool(
    'list_sitemaps',
    {
      title: 'List sitemaps',
      description:
        'Sitemaps submitted for a property (or listed in a sitemap index): type, last submitted/downloaded, pending, errors, warnings and ' +
        'submitted URL counts per content type. Google no longer reports indexed counts per sitemap; use inspect_url for single URLs.',
      inputSchema: {
        site_url: siteUrlSchema,
        sitemap_index: z.string().optional().describe('Only list the sitemaps in this sitemap index URL.'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ site_url, sitemap_index }) => {
      const site = normalizeSiteUrl(site_url);
      const res = await api.listSitemaps<{ sitemap?: Sitemap[] }>(site, sitemap_index);
      return { site_url: site, sitemaps: (res.sitemap ?? []).map(compactSitemap) };
    }),
  );

  server.registerTool(
    'get_sitemap',
    {
      title: 'Get one sitemap',
      description: 'Details of one submitted sitemap (same fields as list_sitemaps).',
      inputSchema: {
        site_url: siteUrlSchema,
        sitemap_url: z.string().describe('Full sitemap URL, e.g. "https://www.example.com/sitemap.xml".'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ site_url, sitemap_url }) => {
      const site = normalizeSiteUrl(site_url);
      return { site_url: site, ...compactSitemap(await api.getSitemap<Sitemap>(site, sitemap_url)) };
    }),
  );
}
