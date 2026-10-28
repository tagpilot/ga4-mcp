// All tools through the MCP protocol (in-memory transport) with a mocked Google fetch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';
import { mockFetch } from '../../mcp-core/test/helpers.js';

const TODAY = '2026-10-28';

async function connect(respond: Parameters<typeof mockFetch>[0]) {
  const f = mockFetch(respond);
  let issued = 0;
  const tokens = { getAccessToken: async () => `tok-${++issued}`, invalidateAccessToken: () => {} };
  const server = createServer(tokens, { fetchImpl: f.fetch }, () => TODAY);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = (res.content[0] as { text: string }).text;
    return { isError: res.isError ?? false, text, json: res.isError ? undefined : JSON.parse(text) };
  };
  return { client, call, calls: f.calls };
}

const WM = 'https://www.googleapis.com/webmasters/v3';

describe('Search Console MCP server', () => {
  test('lists the read-only tools; list_sites first', async () => {
    const { client } = await connect(() => ({ body: {} }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), [
      'list_sites',
      'list_sitemaps',
      'get_sitemap',
      'search_analytics',
      'compare_periods',
      'find_opportunities',
      'inspect_url',
    ]);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
    const sa = tools.find((t) => t.name === 'search_analytics')!;
    assert.match(sa.description!, /2–3 days/);
    assert.match(sa.description!, /anonymised/);
    assert.match(tools.find((t) => t.name === 'inspect_url')!.description!, /2,000 inspections per day/);
    assert.ok(JSON.stringify(tools).length < 30_000, `tool list stays compact (${JSON.stringify(tools).length} bytes)`);
  });

  test('list_sites', async () => {
    const { call, calls } = await connect(() => ({
      body: {
        siteEntry: [
          { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
          { siteUrl: 'https://blog.example.com/', permissionLevel: 'siteRestrictedUser' },
          { siteUrl: 'https://old.example.com/', permissionLevel: 'siteUnverifiedUser' },
        ],
      },
    }));
    const res = await call('list_sites');
    assert.equal(calls[0].url, `${WM}/sites`);
    assert.equal((calls[0].init.headers as Record<string, string>)['user-agent'], 'tagpilot-search-console-mcp/0.1.0');
    assert.deepEqual(res.json.sites, [
      { site_url: 'https://blog.example.com/', type: 'url_prefix', permission: 'restricted' },
      { site_url: 'https://old.example.com/', type: 'url_prefix', permission: 'unverified' },
      { site_url: 'sc-domain:example.com', type: 'domain', permission: 'owner' },
    ]);
    assert.match(res.json.note, /unverified/);
  });

  test('search_analytics: URL-encoded site, mapped body, compact rows, paging hint', async () => {
    const { call, calls } = await connect(() => ({
      body: { rows: [{ keys: ['shoes'], clicks: 12, impressions: 340, ctr: 0.0352941, position: 4.567 }], responseAggregationType: 'byProperty' },
    }));
    const res = await call('search_analytics', { site_url: 'sc-domain:example.com', dimensions: ['query'], row_limit: 1 });
    assert.equal(res.isError, false, res.text);
    assert.equal(calls[0].url, `${WM}/sites/sc-domain%3Aexample.com/searchAnalytics/query`);
    assert.deepEqual(calls[0].body, { startDate: '2026-09-28', endDate: '2026-10-25', dimensions: ['query'], type: 'web', rowLimit: 1 });
    assert.deepEqual(res.json.rows, [{ query: 'shoes', clicks: 12, impressions: 340, ctr: 0.0353, position: 4.6 }]);
    assert.equal(res.json.next_start_row, 1);
    assert.equal(res.json.aggregation, 'byProperty');
    assert.match(res.json.notes[0], /Anonymised/);
  });

  test('compare_periods: previous period defaults to the 28 days before', async () => {
    const { call, calls } = await connect((_url, init) => {
      const b = JSON.parse(String(init.body));
      const current = b.startDate === '2026-09-28';
      if (!b.dimensions.length) return { body: { rows: [{ keys: [], clicks: current ? 200 : 100, impressions: 4000, ctr: 0.05, position: 7 }] } };
      return { body: { rows: [{ keys: ['shoes'], clicks: current ? 150 : 50, impressions: 2000, ctr: 0.075, position: current ? 3 : 5 }] } };
    });
    const res = await call('compare_periods', { site_url: 'https://www.example.com' });
    assert.equal(res.isError, false, res.text);
    assert.equal(calls.length, 4);
    assert.ok(calls.every((c) => c.url.startsWith(`${WM}/sites/https%3A%2F%2Fwww.example.com%2F/`)), 'trailing slash added');
    assert.deepEqual(res.json.previous, { start_date: '2026-08-31', end_date: '2026-09-27', clicks: 100, impressions: 4000, ctr: 0.05, position: 7 });
    assert.equal(res.json.change.clicks_pct, 100);
    assert.deepEqual(res.json.rows[0], {
      query: 'shoes', status: 'both', clicks: 150, clicks_prev: 50, clicks_change: 100, impressions: 2000, impressions_prev: 2000,
      impressions_change: 0, ctr: 0.075, ctr_prev: 0.075, position: 3, position_prev: 5, position_change: -2,
    });
  });

  test('find_opportunities scans rows and returns both lists', async () => {
    const { call, calls } = await connect(() => ({
      body: { rows: [{ keys: ['weak'], clicks: 5, impressions: 5000, ctr: 0.001, position: 2.2 }, { keys: ['near'], clicks: 10, impressions: 3000, ctr: 0.0033, position: 11.6 }] },
    }));
    const res = await call('find_opportunities', { site_url: 'sc-domain:example.com', dimension: 'query' });
    assert.equal((calls[0].body as { rowLimit: number }).rowLimit, 5000);
    assert.deepEqual(res.json.low_ctr.map((r: { query: string }) => r.query), ['weak']);
    assert.deepEqual(res.json.striking_distance.map((r: { query: string }) => r.query), ['near']);
  });

  test('inspect_url posts to the URL Inspection API', async () => {
    const { call, calls } = await connect(() => ({ body: { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } } } }));
    const res = await call('inspect_url', { site_url: 'sc-domain:example.com', url: 'https://www.example.com/a', language_code: 'pl' });
    assert.equal(calls[0].url, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect');
    assert.deepEqual(calls[0].body, { inspectionUrl: 'https://www.example.com/a', siteUrl: 'sc-domain:example.com', languageCode: 'pl' });
    assert.equal(res.json.verdict, 'PASS');
  });

  test('list_sitemaps and get_sitemap', async () => {
    const { call, calls } = await connect((url) =>
      url.includes('/sitemaps/') ? { body: { path: 'https://x.test/s.xml', type: 'sitemap', errors: '1' } } : { body: { sitemap: [{ path: 'https://x.test/s.xml' }] } },
    );
    const list = await call('list_sitemaps', { site_url: 'https://x.test/', sitemap_index: 'https://x.test/index.xml' });
    assert.equal(calls[0].url, `${WM}/sites/https%3A%2F%2Fx.test%2F/sitemaps?sitemapIndex=https%3A%2F%2Fx.test%2Findex.xml`);
    assert.equal(list.json.sitemaps.length, 1);
    const one = await call('get_sitemap', { site_url: 'https://x.test/', sitemap_url: 'https://x.test/s.xml' });
    assert.equal(calls[1].url, `${WM}/sites/https%3A%2F%2Fx.test%2F/sitemaps/https%3A%2F%2Fx.test%2Fs.xml`);
    assert.equal(one.json.errors, 1);
  });

  test('errors are readable tool results', async () => {
    const { call, calls } = await connect(() => ({ status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } } }));
    const res = await call('inspect_url', { site_url: 'sc-domain:example.com', url: 'https://www.example.com/a' });
    assert.equal(res.isError, true);
    assert.match(res.text, /2,000 inspections per day/);
    const bad = await call('search_analytics', { site_url: 'example.com' });
    assert.match(bad.text, /sc-domain:example\.com/);
    assert.equal(calls.length, 1, 'bad site_url never reaches Google');
  });
});
