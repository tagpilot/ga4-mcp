// list_accounts, list_containers, list_workspaces, get_container, list_versions, get_live_version
import { z } from 'zod';
import { InputError } from '../core.js';
import { snapshotFromVersion } from '../gtm/model.js';
import { compactSnapshot, fullSnapshot } from '../gtm/summary.js';
import { READ_ONLY, safe, type ToolContext } from './common.js';
import { accountIdSchema, containerIdSchema, source, sourceShape } from './schemas.js';

const detailSchema = z
  .enum(['compact', 'full'])
  .optional()
  .describe('"compact" (default): id, name, type, folder and triggers per entity. "full": every entity body as the API returns it (large).');

const num = (v: unknown) => (v == null ? 0 : Number(v));

export function registerContainerTools({ server, api }: ToolContext): void {
  server.registerTool(
    'list_accounts',
    {
      title: 'List Tag Manager accounts',
      description: 'Lists the Google Tag Manager accounts the signed-in Google account can read, with their numeric IDs. Start here.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const accounts = (await api.listAccounts()).map((a) => ({ account_id: a.accountId, name: a.name }));
      accounts.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { accounts };
    }),
  );

  server.registerTool(
    'list_containers',
    {
      title: 'List containers',
      description:
        'Containers in a Tag Manager account: numeric container ID, public ID (GTM-XXXXXXX), name, usage context (web, server, amp, ios, android) and domains.',
      inputSchema: { account_id: accountIdSchema },
      annotations: READ_ONLY,
    },
    safe(async ({ account_id }) => ({
      account_id,
      containers: (await api.listContainers(account_id)).map((c) => ({
        container_id: c.containerId,
        public_id: c.publicId,
        name: c.name,
        usage_context: c.usageContext ?? [],
        ...(c.domainName?.length ? { domains: c.domainName } : {}),
      })),
    })),
  );

  server.registerTool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description:
        'Workspaces of a container (where unpublished changes are made), with IDs and descriptions. Pass workspace_id to the other tools to read a workspace instead of the live version.',
      inputSchema: { account_id: accountIdSchema, container_id: containerIdSchema },
      annotations: READ_ONLY,
    },
    safe(async ({ account_id, container_id }) => {
      const containerId = await api.resolveContainerId(account_id, container_id);
      return {
        account_id,
        container_id: containerId,
        workspaces: (await api.listWorkspaces(account_id, containerId)).map((w) => ({
          workspace_id: w.workspaceId,
          name: w.name,
          ...(w.description ? { description: w.description } : {}),
        })),
      };
    }),
  );

  server.registerTool(
    'get_container',
    {
      title: 'Get container contents',
      description:
        'Everything in a container: tags (with their firing and blocking triggers by name, paused state), triggers, variables, custom templates, ' +
        'folders and enabled built-in variables; clients and transformations for server containers. Reads the live (published) version by default, ' +
        'or a workspace (workspace_id) or an older version (version_id). Compact by default; use get_tag / get_trigger / get_variable for one entity in full.',
      inputSchema: { ...sourceShape, detail: detailSchema },
      annotations: READ_ONLY,
    },
    safe(async (a) => {
      const s = await api.snapshot(a.account_id, a.container_id, source(a));
      return a.detail === 'full' ? fullSnapshot(s) : compactSnapshot(s);
    }),
  );

  server.registerTool(
    'list_versions',
    {
      title: 'List container versions',
      description:
        'Container versions, newest first: version ID, name, entity counts, and which one is live (published). Pass a version_id to get_container, diff or the get_* tools to read an older version.',
      inputSchema: {
        account_id: accountIdSchema,
        container_id: containerIdSchema,
        include_deleted: z.boolean().optional().describe('Also list deleted versions. Default false.'),
        limit: z.number().int().min(1).max(500).optional().describe('How many versions to return. Default 50.'),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ account_id, container_id, include_deleted, limit }) => {
      const containerId = await api.resolveContainerId(account_id, container_id);
      const [headers, live] = await Promise.all([
        api.listVersionHeaders(account_id, containerId, include_deleted ?? false),
        api.getLiveVersionOrNull(account_id, containerId),
      ]);
      const liveId = live?.containerVersionId ?? null;
      const versions = headers
        .filter((h) => h.containerVersionId !== '0')
        .sort((x, y) => Number(y.containerVersionId) - Number(x.containerVersionId))
        .map((h) => ({
          version_id: h.containerVersionId,
          name: h.name || undefined,
          ...(h.containerVersionId === liveId ? { live: true } : {}),
          ...(h.deleted ? { deleted: true } : {}),
          tags: num(h.numTags),
          triggers: num(h.numTriggers),
          variables: num(h.numVariables),
          templates: num(h.numCustomTemplates),
          ...(num(h.numClients) ? { clients: num(h.numClients) } : {}),
          ...(num(h.numTransformations) ? { transformations: num(h.numTransformations) } : {}),
          ...(num(h.numZones) ? { zones: num(h.numZones) } : {}),
        }));
      return {
        container_id: containerId,
        live_version_id: liveId,
        total: versions.length,
        versions: versions.slice(0, limit ?? 50),
        ...(liveId ? {} : { note: 'No live version: this container has never been published.' }),
      };
    }),
  );

  server.registerTool(
    'get_live_version',
    {
      title: 'Get the live (published) version',
      description:
        'The container version that is live on the site: version ID, name, description, and its contents (compact by default, like get_container).',
      inputSchema: { account_id: accountIdSchema, container_id: containerIdSchema, detail: detailSchema },
      annotations: READ_ONLY,
    },
    safe(async ({ account_id, container_id, detail }) => {
      const containerId = await api.resolveContainerId(account_id, container_id);
      const v = await api.getLiveVersionOrNull(account_id, containerId);
      if (!v) throw new InputError(`Container ${containerId} has never been published (no live version). Use list_workspaces and get_container with workspace_id.`);
      const s = snapshotFromVersion(account_id, containerId, v, true);
      return {
        version: { version_id: v.containerVersionId, name: v.name || undefined, description: v.description || undefined, url: v.tagManagerUrl },
        ...(detail === 'full' ? fullSnapshot(s) : compactSnapshot(s)),
      };
    }),
  );
}
