// End-to-end through the MCP protocol (in-memory transport) with a mocked Google fetch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';
import type { AccessTokenSource } from '../src/core.js';
import { mockFetch, withConnection } from '../../mcp-core/test/helpers.js';
import { PRODUCT } from '../src/product.js';

function tokens(): AccessTokenSource & { invalidated: number; issued: number } {
  return {
    invalidated: 0,
    issued: 0,
    async getAccessToken() {
      this.issued++;
      return `tok-${this.issued}`;
    },
    invalidateAccessToken() {
      this.invalidated++;
    },
  };
}

async function connect(respond: Parameters<typeof mockFetch>[0], src = tokens()) {
  const f = mockFetch(respond);
  const server = createServer(withConnection(src, PRODUCT), { fetchImpl: f.fetch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = (res.content[0] as { text: string }).text;
    return { isError: res.isError ?? false, text, json: res.isError ? undefined : JSON.parse(text) };
  };
  return { client, call, calls: f.calls, src };
}

const report = (dims: string[], mets: string[], rows: Array<[string[], string[]]>, extra: Record<string, unknown> = {}) => ({
  dimensionHeaders: dims.map((name) => ({ name })),
  metricHeaders: mets.map((name) => ({ name, type: 'TYPE_INTEGER' })),
  rows: rows.map(([d, m]) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((value) => ({ value })) })),
  rowCount: rows.length,
  ...extra,
});

describe('MCP server', () => {
  test('lists all tools as read-only', async () => {
    const { client } = await connect(() => ({ body: {} }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'check_duplicate_transactions',
      'check_traffic_attribution',
      'connect',
      'connection_status',
      'get_account_summaries',
      'get_custom_dimensions_and_metrics',
      'get_property_details',
      'list_google_ads_links',
      'list_property_annotations',
      'run_funnel_report',
      'run_realtime_report',
      'run_report',
    ]);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
    const runReport = tools.find((t) => t.name === 'run_report')!;
    assert.deepEqual(runReport.inputSchema.required?.sort(), ['metrics', 'property_id']);
  });

  test('get_account_summaries pages and compacts', async () => {
    const { call, calls } = await connect((url) =>
      url.includes('pageToken=p2')
        ? { body: { accountSummaries: [{ account: 'accounts/2', displayName: 'B', propertySummaries: [] }] } }
        : {
            body: {
              accountSummaries: [
                {
                  account: 'accounts/1',
                  displayName: 'A',
                  propertySummaries: [{ property: 'properties/11', displayName: 'Shop', propertyType: 'PROPERTY_TYPE_ORDINARY', parent: 'accounts/1' }],
                },
              ],
              nextPageToken: 'p2',
            },
          },
    );
    const res = await call('get_account_summaries');
    assert.deepEqual(res.json, [
      { account_id: '1', account_name: 'A', properties: [{ property_id: '11', name: 'Shop', type: 'ordinary' }] },
      { account_id: '2', account_name: 'B', properties: [] },
    ]);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.startsWith('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200'));
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer tok-1');
  });

  test('run_report sends the mapped body and returns compact rows', async () => {
    const { call, calls } = await connect(() => ({
      body: report(['eventName'], ['eventCount'], [[['purchase'], ['42']]], { metadata: { currencyCode: 'USD', timeZone: 'UTC' } }),
    }));
    const res = await call('run_report', {
      property_id: '123',
      dimensions: ['eventName'],
      metrics: ['eventCount'],
      dimension_filter: [{ field: 'eventName', op: 'exact', value: 'purchase' }],
      date_ranges: [{ start_date: '7daysAgo', end_date: 'today' }],
    });
    assert.equal(res.isError, false, res.text);
    assert.equal(calls[0].url, 'https://analyticsdata.googleapis.com/v1beta/properties/123:runReport');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual((calls[0].body as { dimensionFilter: unknown }).dimensionFilter, {
      filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'purchase', caseSensitive: false } },
    });
    assert.deepEqual(res.json, { row_count: 1, returned: 1, rows: [{ eventName: 'purchase', eventCount: 42 }], currency_code: 'USD', time_zone: 'UTC' });
  });

  test('Google 401 → token invalidated and request retried once', async () => {
    let n = 0;
    const { call, src } = await connect(() => (++n === 1 ? { status: 401, body: { error: { code: 401, message: 'expired' } } } : { body: { accountSummaries: [] } }));
    const res = await call('get_account_summaries');
    assert.equal(res.isError, false, res.text);
    assert.equal(src.invalidated, 1);
    assert.equal(src.issued, 2);
  });

  test('403 becomes a readable tool error', async () => {
    const { call } = await connect(() => ({ status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'nope' } } }));
    const res = await call('run_report', { property_id: '555', metrics: ['sessions'] });
    assert.equal(res.isError, true);
    assert.match(res.text, /no access to property 555/);
  });

  test('invalid input is reported, not thrown', async () => {
    const { call, calls } = await connect(() => ({ body: {} }));
    const res = await call('get_property_details', { property_id: 'G-12345' });
    assert.equal(res.isError, true);
    assert.match(res.text, /measurement IDs/);
    assert.equal(calls.length, 0);
  });

  test('auth errors reach the user verbatim', async () => {
    const src: AccessTokenSource = {
      getAccessToken: () => Promise.reject(new Error('Waiting for you to sign in with Google. ... https://accounts.example/x')),
      invalidateAccessToken: () => {},
    };
    const { call } = await connect(() => ({ body: {} }), src as ReturnType<typeof tokens>);
    const res = await call('get_account_summaries');
    assert.equal(res.isError, true);
    assert.match(res.text, /sign in with Google/);
  });

  test('get_property_details includes data streams', async () => {
    const { call } = await connect((url) =>
      url.includes('dataStreams')
        ? {
            body: {
              dataStreams: [
                { name: 'properties/7/dataStreams/99', type: 'WEB_DATA_STREAM', displayName: 'Web', webStreamData: { measurementId: 'G-AAA', defaultUri: 'https://shop.example' } },
              ],
            },
          }
        : { body: { name: 'properties/7', displayName: 'Shop', timeZone: 'Europe/Warsaw', currencyCode: 'PLN', serviceLevel: 'GOOGLE_ANALYTICS_STANDARD', account: 'accounts/3' } },
    );
    const res = await call('get_property_details', { property_id: 7 });
    assert.equal(res.json.service_level, 'standard');
    assert.deepEqual(res.json.data_streams[0], { stream_id: '99', name: 'Web', type: 'web', measurement_id: 'G-AAA', default_uri: 'https://shop.example' });
  });

  test('get_custom_dimensions_and_metrics filters custom definitions', async () => {
    const { call, calls } = await connect(() => ({
      body: {
        dimensions: [
          { apiName: 'country', uiName: 'Country', category: 'Geography' },
          { apiName: 'customEvent:payment_type', uiName: 'Payment type', customDefinition: true },
          { apiName: 'customUser:plan', uiName: 'Plan', customDefinition: true },
        ],
        metrics: [{ apiName: 'customEvent:shipping', uiName: 'Shipping', type: 'TYPE_CURRENCY', customDefinition: true }],
      },
    }));
    const res = await call('get_custom_dimensions_and_metrics', { property_id: '1' });
    assert.equal(calls[0].url, 'https://analyticsdata.googleapis.com/v1beta/properties/1/metadata');
    assert.deepEqual(res.json, {
      custom_dimensions: [
        { api_name: 'customEvent:payment_type', ui_name: 'Payment type', scope: 'event' },
        { api_name: 'customUser:plan', ui_name: 'Plan', scope: 'user' },
      ],
      custom_metrics: [{ api_name: 'customEvent:shipping', ui_name: 'Shipping', type: 'currency' }],
    });
  });

  test('run_funnel_report uses the v1alpha endpoint', async () => {
    const { call, calls } = await connect(() => ({ body: { funnelTable: report(['funnelStepName'], ['activeUsers'], [[['1. a'], ['10']]]) } }));
    const res = await call('run_funnel_report', {
      property_id: '1',
      steps: [{ name: '1. a', event_name: 'view_item' }, { name: '2. b', event_name: 'purchase' }],
    });
    assert.equal(calls[0].url, 'https://analyticsdata.googleapis.com/v1alpha/properties/1:runFunnelReport');
    assert.deepEqual(res.json, { steps: [{ funnelStepName: '1. a', activeUsers: 10 }] });
  });

  test('check_duplicate_transactions computes duplicate and missing rates', async () => {
    const { call, calls } = await connect((_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.limit === '1') {
        // all purchases: 110 events, 100 distinct transactionId values incl. (not set)
        return { body: { ...report(['transactionId'], ['eventCount'], [[['A'], ['3']]]), rowCount: 100, totals: [{ metricValues: [{ value: '110' }] }] } };
      }
      if (body.metricFilter) {
        return { body: { ...report(['transactionId'], ['eventCount', 'purchaseRevenue'], [[['A'], ['3', '30']], [['B'], ['2', '20']]]), rowCount: 6 } };
      }
      return { body: report(['transactionId'], ['eventCount', 'purchaseRevenue'], [[['(not set)'], ['5', '50']]]) };
    });
    const res = await call('check_duplicate_transactions', { property_id: '1' });
    assert.equal(res.isError, false, res.text);
    assert.equal(calls.length, 3);
    // 110 events − 5 without ID = 105 with ID over 99 distinct IDs → 6 extra (5.71%)
    assert.deepEqual(res.json.summary, {
      purchase_events: 110,
      distinct_transaction_ids: 99,
      duplicated_transaction_ids: 6,
      extra_purchase_events: 6,
      duplicate_rate_pct: 5.71,
      purchases_without_transaction_id: 5,
      without_transaction_id_pct: 4.55,
    });
    assert.deepEqual(res.json.top_duplicates[0], { transaction_id: 'A', purchase_events: 3, revenue: 30 });
    assert.equal(res.json.findings.length, 2);
  });

  test('check_traffic_attribution flags unassigned and (not set)', async () => {
    const { call } = await connect((_url, init) => {
      const body = JSON.parse(String(init.body));
      const dim = body.dimensions.map((d: { name: string }) => d.name).join(',');
      if (dim === 'sessionDefaultChannelGroup') {
        return {
          body: {
            ...report(['sessionDefaultChannelGroup'], ['sessions'], [[['Organic Search'], ['700']], [['Direct'], ['200']], [['Unassigned'], ['100']]]),
            totals: [{ metricValues: [{ value: '1000' }] }],
          },
        };
      }
      if (dim === 'sessionSource,sessionMedium') return { body: report(['sessionSource', 'sessionMedium'], ['sessions'], [[['newsletter'], ['mail']]]) };
      if (dim === 'sessionSource') return { body: report(['sessionSource'], ['sessions'], [[['(not set)'], ['30']]]) };
      return { body: report(['landingPage'], ['sessions'], []) };
    });
    const res = await call('check_traffic_attribution', { property_id: '1' });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(res.json.shares_pct, { unassigned: 10, direct: 20, not_set_source: 3, not_set_landing_page: 0 });
    assert.equal(res.json.findings.length, 2);
  });
});
