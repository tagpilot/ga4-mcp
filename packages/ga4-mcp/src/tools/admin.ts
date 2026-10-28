// Admin API (v1beta/v1alpha) and Data API metadata tools.
import { z } from 'zod';
import { idOf, READ_ONLY, safe, stripPrefix, type ToolContext } from './common.js';
import { normalizePropertyId } from './mapping.js';
import { propertyIdSchema } from './schemas.js';

interface AccountSummary {
  account?: string;
  displayName?: string;
  propertySummaries?: Array<{ property?: string; displayName?: string; propertyType?: string; parent?: string }>;
}

interface Property {
  name?: string;
  displayName?: string;
  parent?: string;
  propertyType?: string;
  timeZone?: string;
  currencyCode?: string;
  industryCategory?: string;
  serviceLevel?: string;
  createTime?: string;
  updateTime?: string;
  deleteTime?: string;
  account?: string;
}

interface DataStream {
  name?: string;
  type?: string;
  displayName?: string;
  createTime?: string;
  webStreamData?: { measurementId?: string; defaultUri?: string };
  androidAppStreamData?: { packageName?: string; firebaseAppId?: string };
  iosAppStreamData?: { bundleId?: string; firebaseAppId?: string };
}

interface MetadataItem {
  apiName: string;
  uiName?: string;
  description?: string;
  category?: string;
  customDefinition?: boolean;
  type?: string;
  deprecatedApiNames?: string[];
}

interface DateParts {
  year?: number;
  month?: number;
  day?: number;
}
const ymd = (d?: DateParts) =>
  d?.year ? `${d.year}-${String(d.month ?? 1).padStart(2, '0')}-${String(d.day ?? 1).padStart(2, '0')}` : undefined;

export function registerAdminTools({ server, api }: ToolContext): void {
  server.registerTool(
    'get_account_summaries',
    {
      title: 'List GA4 accounts and properties',
      description:
        'Lists every Google Analytics account and GA4 property the signed-in Google account can read, with property IDs. Start here to find the property_id for other tools.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const summaries = await api.adminList<AccountSummary>('v1beta', '/accountSummaries', 'accountSummaries');
      return summaries.map((a) => ({
        account_id: idOf(a.account),
        account_name: a.displayName,
        properties: (a.propertySummaries ?? []).map((p) => ({
          property_id: idOf(p.property),
          name: p.displayName,
          type: stripPrefix(p.propertyType, 'PROPERTY_TYPE_')?.toLowerCase(),
          ...(p.parent && !p.parent.startsWith('accounts/') ? { parent: p.parent } : {}),
        })),
      }));
    }),
  );

  server.registerTool(
    'get_property_details',
    {
      title: 'GA4 property details',
      description:
        'Returns a GA4 property\'s settings (time zone, currency, industry, service level: standard or 360) and its data streams, including web measurement IDs (G-XXXX) and default URLs.',
      inputSchema: { property_id: propertyIdSchema },
      annotations: READ_ONLY,
    },
    safe(async ({ property_id }) => {
      const id = normalizePropertyId(property_id);
      const ctx = { propertyId: id };
      const [p, streams] = await Promise.all([
        api.admin<Property>('v1beta', `/properties/${id}`, undefined, ctx),
        api.adminList<DataStream>('v1beta', `/properties/${id}/dataStreams`, 'dataStreams', ctx).catch((e: Error) => e),
      ]);
      return {
        property_id: idOf(p.name),
        name: p.displayName,
        account_id: idOf(p.account),
        parent: p.parent,
        property_type: stripPrefix(p.propertyType, 'PROPERTY_TYPE_')?.toLowerCase(),
        time_zone: p.timeZone,
        currency_code: p.currencyCode,
        industry_category: p.industryCategory,
        service_level: stripPrefix(p.serviceLevel, 'GOOGLE_ANALYTICS_')?.toLowerCase(),
        create_time: p.createTime,
        update_time: p.updateTime,
        ...(p.deleteTime ? { delete_time: p.deleteTime } : {}),
        data_streams:
          streams instanceof Error
            ? `Could not list data streams: ${streams.message}`
            : streams.map((s) => ({
                stream_id: idOf(s.name),
                name: s.displayName,
                type: s.type?.replace(/_DATA_STREAM$/, '').toLowerCase(),
                ...(s.webStreamData ? { measurement_id: s.webStreamData.measurementId, default_uri: s.webStreamData.defaultUri } : {}),
                ...(s.androidAppStreamData ? { package_name: s.androidAppStreamData.packageName } : {}),
                ...(s.iosAppStreamData ? { bundle_id: s.iosAppStreamData.bundleId } : {}),
                create_time: s.createTime,
              })),
      };
    }),
  );

  server.registerTool(
    'list_google_ads_links',
    {
      title: 'Google Ads links',
      description: 'Lists the Google Ads accounts linked to a GA4 property (customer IDs, personalization setting, who created the link).',
      inputSchema: { property_id: propertyIdSchema },
      annotations: READ_ONLY,
    },
    safe(async ({ property_id }) => {
      const id = normalizePropertyId(property_id);
      const links = await api.adminList<Record<string, unknown>>('v1beta', `/properties/${id}/googleAdsLinks`, 'googleAdsLinks', { propertyId: id });
      return links.map((l) => ({
        link_id: idOf(l.name as string | undefined),
        customer_id: l.customerId,
        ads_personalization_enabled: l.adsPersonalizationEnabled,
        can_manage_clients: l.canManageClients,
        creator_email_address: l.creatorEmailAddress,
        create_time: l.createTime,
      }));
    }),
  );

  server.registerTool(
    'list_property_annotations',
    {
      title: 'Property annotations',
      description:
        'Lists the reporting annotations of a GA4 property (notes on dates such as releases, tracking changes or campaigns, plus system-generated ones). Useful to explain jumps in data.',
      inputSchema: { property_id: propertyIdSchema },
      annotations: READ_ONLY,
    },
    safe(async ({ property_id }) => {
      const id = normalizePropertyId(property_id);
      const items = await api.adminList<Record<string, unknown>>(
        'v1alpha',
        `/properties/${id}/reportingDataAnnotations`,
        'reportingDataAnnotations',
        { propertyId: id },
      );
      return items.map((a) => {
        const range = a.annotationDateRange as { startDate?: DateParts; endDate?: DateParts } | undefined;
        return {
          title: a.title,
          description: a.description || undefined,
          ...(a.annotationDate ? { date: ymd(a.annotationDate as DateParts) } : {}),
          ...(range ? { start_date: ymd(range.startDate), end_date: ymd(range.endDate) } : {}),
          color: stripPrefix(a.color as string | undefined, 'COLOR_')?.toLowerCase(),
          system_generated: a.systemGenerated || undefined,
        };
      });
    }),
  );

  server.registerTool(
    'get_custom_dimensions_and_metrics',
    {
      title: 'Custom dimensions and metrics',
      description:
        'Lists the custom dimensions and metrics of a GA4 property with the API names to use in run_report (e.g. "customEvent:payment_type", "customUser:plan"). ' +
        'Set include_standard to also list built-in dimensions/metrics (large; combine with search).',
      inputSchema: {
        property_id: propertyIdSchema,
        include_standard: z.boolean().optional().describe('Also return built-in dimensions and metrics. Default false.'),
        search: z.string().optional().describe('Case-insensitive filter on API name, UI name and category, e.g. "item" or "revenue".'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ property_id, include_standard, search }) => {
      const id = normalizePropertyId(property_id);
      const meta = await api.dataGet<{ dimensions?: MetadataItem[]; metrics?: MetadataItem[] }>('v1beta', `/properties/${id}/metadata`, {
        propertyId: id,
      });
      const q = search?.toLowerCase();
      const match = (m: MetadataItem) =>
        !q || [m.apiName, m.uiName, m.category].some((s) => s?.toLowerCase().includes(q));
      const scopeOf = (apiName: string) => {
        const prefix = apiName.split(':')[0];
        return { customEvent: 'event', customUser: 'user', customItem: 'item' }[prefix];
      };
      const dims = (meta.dimensions ?? []).filter(match);
      const mets = (meta.metrics ?? []).filter(match);
      const out: Record<string, unknown> = {
        custom_dimensions: dims
          .filter((d) => d.customDefinition)
          .map((d) => ({ api_name: d.apiName, ui_name: d.uiName, scope: scopeOf(d.apiName), description: d.description || undefined })),
        custom_metrics: mets
          .filter((m) => m.customDefinition)
          .map((m) => ({ api_name: m.apiName, ui_name: m.uiName, type: stripPrefix(m.type, 'TYPE_')?.toLowerCase(), description: m.description || undefined })),
      };
      if (include_standard) {
        out.standard_dimensions = dims.filter((d) => !d.customDefinition).map((d) => ({ api_name: d.apiName, ui_name: d.uiName, category: d.category }));
        out.standard_metrics = mets
          .filter((m) => !m.customDefinition)
          .map((m) => ({ api_name: m.apiName, ui_name: m.uiName, category: m.category, type: stripPrefix(m.type, 'TYPE_')?.toLowerCase() }));
      }
      return out;
    }),
  );
}
