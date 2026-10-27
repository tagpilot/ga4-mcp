// Tag Pilot tracking-health checks: opinionated, read-only diagnostics built from a few runReport calls.
// Thresholds are rules of thumb, not GA4 facts; every result says what it measured.
import { z } from 'zod';
import type { GoogleApi } from '../google/api.js';
import { READ_ONLY, safe, type ToolContext } from './common.js';
import { buildRunReportRequest } from './reports.js';
import { compactReport, reportNotes, toRows, type ReportResponse } from './mapping.js';
import { dateRangeSchema, propertyIdSchema } from './schemas.js';
import type { Condition } from './schemas.js';

type Args = Parameters<typeof buildRunReportRequest>[0];

async function report(api: GoogleApi, args: Args): Promise<ReportResponse> {
  const { propertyId, body } = buildRunReportRequest(args);
  return api.data<ReportResponse>('v1beta', `/properties/${propertyId}:runReport`, body, { propertyId });
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0);
const total = (res: ReportResponse, metric: string) => num(toRows(res, res.totals)[0]?.[metric]);
const sum = (res: ReportResponse, metric: string) => toRows(res, res.rows).reduce((acc, r) => acc + num(r[metric]), 0);

const dateRangeInput = dateRangeSchema.optional().describe('Default: last 28 full days (28daysAgo to yesterday).');

const NOT_SET_IDS = ['(not set)', ''];

export function registerHealthTools({ server, api }: ToolContext): void {
  server.registerTool(
    'check_duplicate_transactions',
    {
      title: 'Tag Pilot check: duplicate purchases',
      description:
        'Tag Pilot tracking-health check. Counts purchase events per transaction_id to find duplicated purchases (usually thank-you page reloads, ' +
        'or the same order sent by both browser and server tagging) and purchases with no transaction_id at all. ' +
        'Returns totals, the duplicate rate and the worst transaction IDs. Uses 3 runReport calls.',
      inputSchema: {
        property_id: propertyIdSchema,
        date_range: dateRangeInput,
        top: z.number().int().min(1).max(200).optional().describe('How many duplicated transaction IDs to list. Default 20.'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ property_id, date_range, top }) => {
      const date_ranges = date_range ? [date_range] : undefined;
      const isPurchase: Condition = { field: 'eventName', op: 'exact', value: 'purchase' };
      const [all, dups, notSet] = await Promise.all([
        report(api, {
          property_id, date_ranges, dimensions: ['transactionId'], metrics: ['eventCount'],
          dimension_filter: [isPurchase], metric_aggregations: ['total'], limit: 1,
        }),
        report(api, {
          property_id, date_ranges, dimensions: ['transactionId'], metrics: ['eventCount', 'purchaseRevenue'],
          dimension_filter: [isPurchase, { field: 'transactionId', op: 'in_list', values: NOT_SET_IDS, not: true }],
          metric_filter: [{ field: 'eventCount', op: 'gt', value: 1 }],
          order_bys: [{ field: 'eventCount', desc: true }], limit: top ?? 20,
        }),
        report(api, {
          property_id, date_ranges, dimensions: ['transactionId'], metrics: ['eventCount', 'purchaseRevenue'],
          dimension_filter: [isPurchase, { field: 'transactionId', op: 'in_list', values: NOT_SET_IDS }],
        }),
      ]);

      const purchaseEvents = total(all, 'eventCount');
      const notSetEvents = sum(notSet, 'eventCount');
      const notSetRows = notSet.rows?.length ?? 0;
      const distinctIds = Math.max(0, (all.rowCount ?? 0) - notSetRows);
      const eventsWithId = purchaseEvents - notSetEvents;
      const extraEvents = Math.max(0, eventsWithId - distinctIds);
      const duplicateRate = pct(extraEvents, eventsWithId);
      const missingRate = pct(notSetEvents, purchaseEvents);

      const findings: string[] = [];
      if (purchaseEvents === 0) findings.push('No purchase events in this date range.');
      if (duplicateRate >= 2) {
        findings.push(
          `${duplicateRate}% of purchase events repeat a transaction_id. Check for thank-you page reloads/revisits (fire purchase once per order, e.g. ` +
            'with a "tracked" flag or server-side dedup) and for orders sent by both a browser tag and a server/Measurement Protocol tag.',
        );
      } else if (purchaseEvents > 0) {
        findings.push(`Duplicate rate ${duplicateRate}% (under 2%: looks healthy).`);
      }
      if (missingRate >= 1) {
        findings.push(
          `${missingRate}% of purchase events have no transaction_id. GA4 can't deduplicate them, and they can't be matched to orders: send transaction_id with every purchase.`,
        );
      }
      return {
        summary: {
          purchase_events: purchaseEvents,
          distinct_transaction_ids: distinctIds,
          duplicated_transaction_ids: dups.rowCount ?? 0,
          extra_purchase_events: extraEvents,
          duplicate_rate_pct: duplicateRate,
          purchases_without_transaction_id: notSetEvents,
          without_transaction_id_pct: missingRate,
        },
        findings,
        top_duplicates: toRows(dups, dups.rows).map((r) => ({
          transaction_id: r.transactionId,
          purchase_events: r.eventCount,
          revenue: r.purchaseRevenue,
        })),
        method:
          'eventCount of purchase events grouped by transactionId. "revenue" is the purchase revenue GA4 attributed to that ID; ' +
          'GA4 may already ignore some repeats in its revenue metrics, but every repeated event is still a tracking bug worth fixing.',
        notes: reportNotes(all.metadata),
      };
    }),
  );

  server.registerTool(
    'check_traffic_attribution',
    {
      title: 'Tag Pilot check: unassigned and (not set) traffic',
      description:
        'Tag Pilot tracking-health check. Shows how sessions split by default channel group and flags attribution problems: the share of "Unassigned" ' +
        'sessions (with their top source/medium pairs), "(not set)" source, "(not set)" landing page (sessions without a page_view/session_start, often ' +
        'server-side or Measurement Protocol hits without session data, or consent mode pings) and a very high Direct share (lost referrers/UTMs). ' +
        'Uses 4 runReport calls.',
      inputSchema: { property_id: propertyIdSchema, date_range: dateRangeInput },
      annotations: READ_ONLY,
    },
    safe(async ({ property_id, date_range }) => {
      const date_ranges = date_range ? [date_range] : undefined;
      const [channels, unassigned, notSetSource, notSetLanding] = await Promise.all([
        report(api, {
          property_id, date_ranges, dimensions: ['sessionDefaultChannelGroup'], metrics: ['sessions'],
          order_bys: [{ field: 'sessions', desc: true }], metric_aggregations: ['total'], limit: 50,
        }),
        report(api, {
          property_id, date_ranges, dimensions: ['sessionSource', 'sessionMedium'], metrics: ['sessions'],
          dimension_filter: [{ field: 'sessionDefaultChannelGroup', op: 'exact', value: 'Unassigned' }],
          order_bys: [{ field: 'sessions', desc: true }], limit: 15,
        }),
        report(api, {
          property_id, date_ranges, dimensions: ['sessionSource'], metrics: ['sessions'],
          dimension_filter: [{ field: 'sessionSource', op: 'exact', value: '(not set)' }],
        }),
        report(api, {
          property_id, date_ranges, dimensions: ['landingPage'], metrics: ['sessions'],
          dimension_filter: [{ field: 'landingPage', op: 'exact', value: '(not set)' }],
        }),
      ]);

      const totalSessions = total(channels, 'sessions') || sum(channels, 'sessions');
      const channelRows = toRows(channels, channels.rows);
      const sessionsOf = (name: string) => num(channelRows.find((r) => r.sessionDefaultChannelGroup === name)?.sessions);
      const unassignedPct = pct(sessionsOf('Unassigned'), totalSessions);
      const directPct = pct(sessionsOf('Direct'), totalSessions);
      const notSetSourcePct = pct(sum(notSetSource, 'sessions'), totalSessions);
      const notSetLandingPct = pct(sum(notSetLanding, 'sessions'), totalSessions);

      const findings: string[] = [];
      if (totalSessions === 0) findings.push('No sessions in this date range.');
      if (unassignedPct >= 5) {
        findings.push(
          `${unassignedPct}% of sessions are Unassigned (rule of thumb: keep under 5%). See top_unassigned: usually UTM mediums GA4 doesn't recognise ` +
            '(use standard ones like cpc, email, social, referral, affiliate) or events sent without session source data.',
        );
      }
      if (notSetSourcePct >= 2) {
        findings.push(
          `${notSetSourcePct}% of sessions have source "(not set)": typically server-side or Measurement Protocol events without a matching browser session, ` +
            'missing client_id/session_id, or consent mode cookieless pings.',
        );
      }
      if (notSetLandingPct >= 2) {
        findings.push(
          `${notSetLandingPct}% of sessions have landing page "(not set)": sessions that began without a page_view, e.g. events firing before the config tag, ` +
            'sessions restarted by a late event after 30 minutes of inactivity, or server-side events.',
        );
      }
      if (directPct >= 40) {
        findings.push(`${directPct}% Direct is high: check for redirects stripping UTMs/referrers, payment-gateway self-referrals and missing cross-domain linking.`);
      }
      if (!findings.length) findings.push('No attribution red flags by these rules of thumb.');

      return {
        total_sessions: totalSessions,
        shares_pct: { unassigned: unassignedPct, direct: directPct, not_set_source: notSetSourcePct, not_set_landing_page: notSetLandingPct },
        findings,
        channels: compactReport(channels).rows,
        top_unassigned: toRows(unassigned, unassigned.rows),
        notes: reportNotes(channels.metadata),
      };
    }),
  );
}
