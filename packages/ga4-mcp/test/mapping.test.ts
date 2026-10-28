import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildFunnelRequest, buildRealtimeRequest, buildRunReportRequest, compactFunnel } from '../src/tools/reports.js';
import { compactReport, normalizePropertyId, toFilterExpression } from '../src/tools/mapping.js';
import { describeGoogleError } from '../src/google/api.js';

describe('run_report request mapping', () => {
  test('defaults: last 28 days, limit 100', () => {
    const { propertyId, body } = buildRunReportRequest({ property_id: 'properties/123', metrics: ['sessions'] });
    assert.equal(propertyId, '123');
    assert.deepEqual(body, {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
      dimensions: [],
      metrics: [{ name: 'sessions' }],
      limit: '100',
    });
  });

  test('full mapping: dates, filters, ordering, paging, aggregations', () => {
    const { body } = buildRunReportRequest({
      property_id: 987,
      date_ranges: [
        { start_date: '7daysAgo', end_date: 'yesterday', name: 'current' },
        { start_date: '2026-01-01', end_date: '2026-01-07' },
      ],
      dimensions: ['date', 'eventName'],
      metrics: ['eventCount', 'totalRevenue'],
      dimension_filter: [
        { field: 'eventName', op: 'in_list', values: ['purchase', 'refund'] },
        { field: 'country', op: 'exact', value: 'Poland', case_sensitive: true, not: true },
        { any: [{ field: 'pagePath', op: 'begins_with', value: '/shop' }, { field: 'pagePath', op: 'full_regex', value: '^/p/\\d+$' }] },
      ],
      metric_filter: [{ field: 'eventCount', op: 'gte', value: 10 }],
      order_bys: [{ field: 'date', dimension_order: 'numeric' }, { field: 'eventCount', desc: true }],
      limit: 50,
      offset: 100,
      metric_aggregations: ['total', 'maximum'],
      currency_code: 'eur',
      keep_empty_rows: true,
      return_property_quota: true,
    });
    assert.deepEqual(body, {
      dateRanges: [
        { startDate: '7daysAgo', endDate: 'yesterday', name: 'current' },
        { startDate: '2026-01-01', endDate: '2026-01-07' },
      ],
      dimensions: [{ name: 'date' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }, { name: 'totalRevenue' }],
      limit: '50',
      offset: '100',
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', inListFilter: { values: ['purchase', 'refund'], caseSensitive: false } } },
            { notExpression: { filter: { fieldName: 'country', stringFilter: { matchType: 'EXACT', value: 'Poland', caseSensitive: true } } } },
            {
              orGroup: {
                expressions: [
                  { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/shop', caseSensitive: false } } },
                  { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'FULL_REGEXP', value: '^/p/\\d+$', caseSensitive: false } } },
                ],
              },
            },
          ],
        },
      },
      metricFilter: { filter: { fieldName: 'eventCount', numericFilter: { operation: 'GREATER_THAN_OR_EQUAL', value: { int64Value: '10' } } } },
      orderBys: [
        { dimension: { dimensionName: 'date', orderType: 'NUMERIC' }, desc: false },
        { metric: { metricName: 'eventCount' }, desc: true },
      ],
      metricAggregations: ['TOTAL', 'MAXIMUM'],
      keepEmptyRows: true,
      currencyCode: 'EUR',
      returnPropertyQuota: true,
    });
  });

  test('between, decimals and empty filters', () => {
    assert.deepEqual(toFilterExpression([{ field: 'purchaseRevenue', op: 'between', from: 10, to: 99.5 }]), {
      filter: { fieldName: 'purchaseRevenue', betweenFilter: { fromValue: { int64Value: '10' }, toValue: { doubleValue: 99.5 } } },
    });
    assert.deepEqual(toFilterExpression([{ any: [{ field: 'transactionId', op: 'empty' }] }]), { filter: { fieldName: 'transactionId', emptyFilter: {} } });
  });

  test('helpful input errors', () => {
    assert.throws(() => normalizePropertyId('G-ABC123'), /measurement IDs/);
    assert.throws(() => buildRunReportRequest({ property_id: '1', metrics: ['x'], date_ranges: [{ start_date: 'last week', end_date: 'today' }] }), /Invalid date "last week"/);
    assert.throws(() => toFilterExpression([{ field: 'eventName', op: 'exact' }]), /needs a "value"/);
    assert.throws(() => toFilterExpression([{ field: 'sessions', op: 'gt', value: 'many' }]), /numeric value/);
    assert.throws(() => toFilterExpression([{ field: 'x', op: 'in_list' }]), /needs "values"/);
  });
});

describe('realtime and funnel mapping', () => {
  test('realtime minute ranges', () => {
    const { body } = buildRealtimeRequest({
      property_id: '5',
      dimensions: ['country'],
      metrics: ['activeUsers'],
      minute_ranges: [{ start_minutes_ago: 4, end_minutes_ago: 0, name: 'last5' }],
      order_bys: [{ field: 'activeUsers', desc: true }],
      limit: 10,
    });
    assert.deepEqual(body, {
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'activeUsers' }],
      limit: '10',
      orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
      minuteRanges: [{ startMinutesAgo: 4, endMinutesAgo: 0, name: 'last5' }],
    });
  });

  test('funnel steps with params, conditions, breakdown', () => {
    const { propertyId, body } = buildFunnelRequest({
      property_id: '42',
      steps: [
        { name: 'View', event_name: 'view_item' },
        {
          name: 'Cart',
          event_name: 'add_to_cart',
          event_params: [{ param: 'item_category', item_param: true, op: 'exact', value: 'Shoes' }],
          directly_followed_by: true,
        },
        {
          name: 'Checkout page',
          conditions: [{ field: 'pagePath', op: 'begins_with', value: '/checkout' }, { field: 'pagePath', op: 'contains', value: 'test', not: true }],
          event_name: 'page_view',
          within_seconds: 3600,
        },
      ],
      open_funnel: true,
      breakdown_dimension: 'deviceCategory',
      next_action_dimension: 'eventName',
      trended: true,
    });
    assert.equal(propertyId, '42');
    assert.deepEqual(body, {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
      funnel: {
        isOpenFunnel: true,
        steps: [
          { name: 'View', filterExpression: { funnelEventFilter: { eventName: 'view_item' } } },
          {
            name: 'Cart',
            filterExpression: {
              funnelEventFilter: {
                eventName: 'add_to_cart',
                funnelParameterFilterExpression: {
                  funnelParameterFilter: {
                    itemParameterName: 'item_category',
                    stringFilter: { matchType: 'EXACT', value: 'Shoes', caseSensitive: false },
                  },
                },
              },
            },
            isDirectlyFollowedBy: true,
          },
          {
            name: 'Checkout page',
            filterExpression: {
              andGroup: {
                expressions: [
                  { funnelEventFilter: { eventName: 'page_view' } },
                  { funnelFieldFilter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/checkout', caseSensitive: false } } },
                  { notExpression: { funnelFieldFilter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: 'test', caseSensitive: false } } } },
                ],
              },
            },
            withinDurationFromPriorStep: '3600s',
          },
        ],
      },
      funnelVisualizationType: 'TRENDED_FUNNEL',
      limit: '100',
      funnelBreakdown: { breakdownDimension: { name: 'deviceCategory' }, limit: '5' },
      funnelNextAction: { nextActionDimension: { name: 'eventName' }, limit: '5' },
    });
  });

  test('funnel step validation', () => {
    assert.throws(() => buildFunnelRequest({ property_id: 1, steps: [{ name: 'a' }, { name: 'b', event_name: 'x' }] }), /step 1 \("a"\)/);
    assert.throws(
      () => buildFunnelRequest({ property_id: 1, steps: [{ name: 'a', event_name: 'x' }, { name: 'b', conditions: [{ field: 'f', op: 'empty' }] }] }),
      /"empty" is not supported/,
    );
  });

  test('funnel response is compacted', () => {
    const out = compactFunnel(
      {
        funnelTable: {
          dimensionHeaders: [{ name: 'funnelStepName' }],
          metricHeaders: [{ name: 'activeUsers', type: 'TYPE_INTEGER' }, { name: 'funnelStepCompletionRate', type: 'TYPE_FLOAT' }],
          rows: [{ dimensionValues: [{ value: '1. View' }], metricValues: [{ value: '120' }, { value: '0.25' }] }],
        },
      },
      false,
    );
    assert.deepEqual(out, { steps: [{ funnelStepName: '1. View', activeUsers: 120, funnelStepCompletionRate: 0.25 }] });
  });
});

describe('response compaction', () => {
  test('rows as typed objects, totals, paging and caveats', () => {
    const out = compactReport(
      {
        dimensionHeaders: [{ name: 'country' }],
        metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }, { name: 'purchaseRevenue', type: 'TYPE_CURRENCY' }],
        rows: [
          { dimensionValues: [{ value: 'Poland' }], metricValues: [{ value: '10' }, { value: '99.9' }] },
          { dimensionValues: [{ value: 'Germany' }], metricValues: [{ value: '5' }, { value: '0' }] },
        ],
        totals: [{ dimensionValues: [{ value: 'RESERVED_TOTAL' }], metricValues: [{ value: '15' }, { value: '99.9' }] }],
        rowCount: 30,
        metadata: { currencyCode: 'PLN', timeZone: 'Europe/Warsaw', subjectToThresholding: true },
      },
      { offset: 10 },
    );
    assert.deepEqual(out.rows, [
      { country: 'Poland', sessions: 10, purchaseRevenue: 99.9 },
      { country: 'Germany', sessions: 5, purchaseRevenue: 0 },
    ]);
    assert.equal(out.row_count, 30);
    assert.equal(out.next_offset, 12);
    assert.deepEqual(out.totals, [{ country: 'RESERVED_TOTAL', sessions: 15, purchaseRevenue: 99.9 }]);
    assert.equal(out.currency_code, 'PLN');
    assert.match((out.notes as string[])[0], /thresholding/);
  });

  test('empty report', () => {
    assert.deepEqual(compactReport({ metricHeaders: [{ name: 'sessions' }] }), { row_count: 0, returned: 0, rows: [] });
  });
});

describe('Google error messages', () => {
  test('403 names the property and the role needed', () => {
    const e = describeGoogleError(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'User does not have sufficient permissions for this property.' } }, { propertyId: '123' });
    assert.match(e.message, /property 123/);
    assert.match(e.message, /Viewer/);
    assert.match(e.message, /get_account_summaries/);
  });

  test('quota errors suggest retrying', () => {
    const e = describeGoogleError(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Exhausted property tokens per hour.' } }, { propertyId: '9' });
    assert.match(e.message, /quota exhausted for property 9/);
    assert.match(e.message, /Retry/);
  });

  test('400 points at the schema and custom definitions', () => {
    const e = describeGoogleError(400, { error: { status: 'INVALID_ARGUMENT', message: 'Field foo is not a valid dimension.' } });
    assert.match(e.message, /Field foo/);
    assert.match(e.message, /get_custom_dimensions_and_metrics/);
  });
});
