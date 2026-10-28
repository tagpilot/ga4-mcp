import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyticsNotes, buildAnalyticsRequest, normalizeSiteUrl, toRows } from '../src/tools/analytics.js';
import { addDays, pacificToday, resolveDate, resolveRange } from '../src/tools/dates.js';
import { comparePeriods, expectedCtr, findOpportunities } from '../src/tools/insights.js';
import { compactInspection } from '../src/tools/inspect.js';
import { compactSitemap } from '../src/tools/sites.js';
import { describeSearchConsoleError } from '../src/google/api.js';

const TODAY = '2026-10-28';

describe('dates (Pacific Time)', () => {
  test('relative dates and the default range', () => {
    assert.equal(resolveDate('today', TODAY), '2026-10-28');
    assert.equal(resolveDate('yesterday', TODAY), '2026-10-27');
    assert.equal(resolveDate('30daysAgo', TODAY), '2026-09-28');
    assert.equal(resolveDate('2026-01-31', TODAY), '2026-01-31');
    assert.deepEqual(resolveRange(undefined, undefined, TODAY), { startDate: '2026-09-28', endDate: '2026-10-25' }, '28 days ending 3 days ago');
    assert.throws(() => resolveDate('last week', TODAY), /Invalid date "last week"/);
    assert.throws(() => resolveRange('2026-10-10', '2026-10-01', TODAY), /after end_date/);
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });

  test('today is computed in America/Los_Angeles', () => {
    // 2026-10-28 05:00 UTC is still 2026-10-27 in California.
    assert.equal(pacificToday(new Date('2026-10-28T05:00:00Z')), '2026-10-27');
    assert.equal(pacificToday(new Date('2026-10-28T09:00:00Z')), '2026-10-28');
  });
});

describe('site URLs', () => {
  test('normalization', () => {
    assert.equal(normalizeSiteUrl('sc-domain:Example.com'), 'sc-domain:example.com');
    assert.equal(normalizeSiteUrl('https://www.example.com'), 'https://www.example.com/');
    assert.equal(normalizeSiteUrl('https://www.example.com/blog/'), 'https://www.example.com/blog/');
    assert.throws(() => normalizeSiteUrl('example.com'), /"sc-domain:example\.com".*"https:\/\/example\.com\/"/);
  });
});

describe('search_analytics request', () => {
  test('defaults', () => {
    assert.deepEqual(buildAnalyticsRequest({}, TODAY), {
      startDate: '2026-09-28',
      endDate: '2026-10-25',
      dimensions: [],
      type: 'web',
      rowLimit: 100,
    });
  });

  test('full mapping', () => {
    assert.deepEqual(
      buildAnalyticsRequest(
        {
          start_date: '7daysAgo',
          end_date: 'yesterday',
          dimensions: ['query', 'page'],
          filters: [
            { dimension: 'country', expression: 'pol' },
            { dimension: 'query', operator: 'includingRegex', expression: 'buty|shoes' },
          ],
          search_type: 'image',
          data_state: 'all',
          aggregation_type: 'byPage',
          row_limit: 25000,
          start_row: 25000,
        },
        TODAY,
      ),
      {
        startDate: '2026-10-21',
        endDate: '2026-10-27',
        dimensions: ['query', 'page'],
        type: 'image',
        rowLimit: 25000,
        startRow: 25000,
        dimensionFilterGroups: [
          {
            groupType: 'and',
            filters: [
              { dimension: 'country', operator: 'equals', expression: 'pol' },
              { dimension: 'query', operator: 'includingRegex', expression: 'buty|shoes' },
            ],
          },
        ],
        dataState: 'all',
        aggregationType: 'byPage',
      },
    );
  });

  test('invalid combinations are explained', () => {
    assert.throws(() => buildAnalyticsRequest({ dimensions: ['hour'] }, TODAY), /hourly_all/);
    assert.throws(() => buildAnalyticsRequest({ search_type: 'discover', aggregation_type: 'byProperty' }, TODAY), /byProperty/);
    assert.throws(() => buildAnalyticsRequest({ dimensions: ['query', 'query'] }, TODAY), /only once/);
    assert.doesNotThrow(() => buildAnalyticsRequest({ dimensions: ['hour'], data_state: 'hourly_all' }, TODAY));
  });

  test('rows and notes', () => {
    const res = {
      rows: [{ keys: ['shoes', 'https://x.test/a'], clicks: 10, impressions: 1000, ctr: 0.0123456, position: 3.14159 }],
      metadata: { first_incomplete_date: '2026-10-26' },
    };
    assert.deepEqual(toRows(res, ['query', 'page']), [{ query: 'shoes', page: 'https://x.test/a', clicks: 10, impressions: 1000, ctr: 0.0123, position: 3.1 }]);
    const notes = analyticsNotes({ dimensions: ['query'] }, res);
    assert.match(notes[0], /Anonymised/);
    assert.match(notes[1], /2026-10-26/);
    assert.deepEqual(analyticsNotes({ dimensions: ['date'] }, {}), []);
    assert.equal(analyticsNotes({ dimensions: [], dimensionFilterGroups: [{ filters: [{ dimension: 'query' }] }] }, {}).length, 1);
  });
});

const row = (query: string, clicks: number, impressions: number, position: number) => ({
  query,
  clicks,
  impressions,
  ctr: impressions ? Math.round((clicks / impressions) * 10000) / 10000 : 0,
  position,
});

describe('analyses', () => {
  test('compare_periods joins, flags new/lost and sorts by biggest change', () => {
    const out = comparePeriods('query', [row('a', 100, 1000, 2), row('b', 5, 100, 8), row('new', 30, 300, 4)], [row('a', 40, 900, 3), row('b', 6, 90, 7.5), row('lost', 50, 500, 3)], 'clicks_change', 10);
    assert.deepEqual(out.map((r) => [r.query, r.status, r.clicks_change]), [['a', 'both', 60], ['lost', 'lost', -50], ['new', 'new', 30], ['b', 'both', -1]]);
    assert.equal(out[0].position_change, -1, 'negative = moved up');
    assert.equal(out[1].position, null);
    assert.deepEqual(comparePeriods('query', [row('a', 100, 1000, 2)], [row('a', 40, 900, 3), row('lost', 50, 500, 3)], 'clicks_loss', 1).map((r) => r.query), ['lost']);
  });

  test('find_opportunities: low CTR on page one and striking distance', () => {
    const rows = [
      row('weak-snippet', 5, 5000, 2.2), // expected ~15% → 750, has 5
      row('healthy', 1400, 5000, 1.4), // 28% expected, has 28%
      row('few-impressions', 0, 50, 3),
      row('striking', 10, 3000, 11.6),
      row('too-far', 0, 9000, 35),
    ];
    const out = findOpportunities(rows, { minImpressions: 100, minPosition: 5, maxPosition: 20, top: 10 });
    assert.deepEqual(out.low_ctr.map((r) => r.query), ['weak-snippet']);
    assert.equal(out.low_ctr[0].potential_extra_clicks, 745);
    assert.deepEqual(out.striking_distance.map((r) => r.query), ['striking']);
    assert.equal(out.striking_distance[0].potential_extra_clicks_at_position_3, 290);
    assert.equal(expectedCtr(0.6), 0.28);
    assert.equal(expectedCtr(14), 0.018);
  });
});

describe('compact resources', () => {
  test('sitemaps hide the deprecated indexed count', () => {
    assert.deepEqual(
      compactSitemap({
        path: 'https://x.test/sitemap.xml',
        type: 'sitemap',
        isSitemapsIndex: false,
        isPending: false,
        lastSubmitted: '2026-10-01T00:00:00Z',
        errors: '2',
        warnings: '0',
        contents: [{ type: 'web', submitted: '120', indexed: '0' } as never],
      }),
      {
        path: 'https://x.test/sitemap.xml',
        type: 'sitemap',
        is_index: false,
        is_pending: false,
        last_submitted: '2026-10-01T00:00:00Z',
        last_downloaded: undefined,
        errors: 2,
        warnings: 0,
        submitted: [{ type: 'web', submitted: 120 }],
      },
    );
  });

  test('URL inspection flags a canonical mismatch', () => {
    const out = compactInspection({
      inspectionResultLink: 'https://search.google.com/search-console/inspect?x',
      indexStatusResult: {
        verdict: 'NEUTRAL',
        coverageState: 'Duplicate, Google chose different canonical than user',
        googleCanonical: 'https://x.test/a',
        userCanonical: 'https://x.test/a?ref=1',
        referringUrls: Array.from({ length: 15 }, (_, i) => `https://x.test/r${i}`),
      },
      richResultsResult: { verdict: 'FAIL', detectedItems: [{ richResultType: 'Product snippets', items: [{ name: 'p', issues: [{ issueMessage: 'Missing field "offers"', severity: 'ERROR' }] }] }] },
    });
    assert.equal(out.canonical_mismatch, true);
    assert.equal((out.referring_urls as string[]).length, 10);
    assert.deepEqual(out.rich_results, { verdict: 'FAIL', types: [{ type: 'Product snippets', items: 1, issues: ['ERROR: Missing field "offers"'] }] });
  });
});

describe('Google error messages', () => {
  test('403 explains the exact site_url forms', () => {
    const e = describeSearchConsoleError(403, { error: { status: 'PERMISSION_DENIED', message: "User does not have sufficient permission for site 'https://x.test/'." } }, { siteUrl: 'https://x.test/' });
    assert.match(e.message, /no access to the Search Console property "https:\/\/x\.test\/"/);
    assert.match(e.message, /sc-domain:example\.com/);
  });

  test('quota errors name the right quota', () => {
    assert.match(describeSearchConsoleError(429, null, { kind: 'inspection' }).message, /2,000 inspections per day/);
    assert.match(describeSearchConsoleError(429, null, { kind: 'analytics' }).message, /1,200 queries per minute/);
  });
});
