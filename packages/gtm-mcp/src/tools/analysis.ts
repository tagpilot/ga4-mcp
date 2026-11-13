// diff (workspace vs live) and audit_container (Tag Pilot health check).
import { z } from 'zod';
import { auditSnapshot } from '../gtm/audit.js';
import { diffSnapshots } from '../gtm/diff.js';
import { snapshotFromVersion } from '../gtm/model.js';
import { containerInfo, counts, sourceInfo } from '../gtm/summary.js';
import { READ_ONLY, safe, type ToolContext } from './common.js';
import { accountIdSchema, containerIdSchema, sourceShape, source } from './schemas.js';

const MAX_ITEMS = 50;

export function registerAnalysisTools({ server, api, now }: ToolContext): void {
  server.registerTool(
    'diff',
    {
      title: 'Diff a workspace against the live version',
      description:
        'What publishing a workspace would change: entities added, changed (with the changed fields, and renames) and deleted compared with the live ' +
        'version (or another version_id). Compares the actual contents, so it also shows changes that reached the live version after the workspace was ' +
        'created (the workspace then needs updating in GTM). Set include_values for the before/after values of changed fields.',
      inputSchema: {
        account_id: accountIdSchema,
        container_id: containerIdSchema,
        workspace_id: z.string().trim().describe('The workspace to compare, from list_workspaces.'),
        version_id: z.string().trim().optional().describe('Compare against this version instead of the live one.'),
        include_values: z.boolean().optional().describe('Include before/after values of the changed fields. Default false.'),
      },
      annotations: READ_ONLY,
    },
    safe(async (a) => {
      const containerId = await api.resolveContainerId(a.account_id, a.container_id);
      const baseId = a.version_id || 'live';
      const [head, baseVersion] = await Promise.all([
        api.workspaceSnapshot(a.account_id, containerId, a.workspace_id),
        baseId === 'live' ? api.getLiveVersionOrNull(a.account_id, containerId) : api.getVersion(a.account_id, containerId, baseId),
      ]);
      if (!baseVersion) {
        return {
          container: containerInfo(head),
          workspace: sourceInfo(head),
          against: null,
          note: 'This container has never been published, so everything in the workspace is new.',
          counts: counts(head),
        };
      }
      const base = snapshotFromVersion(a.account_id, containerId, baseVersion, baseId === 'live');
      const d = diffSnapshots(base, head, { includeValues: a.include_values ?? false });
      return {
        container: containerInfo(head),
        workspace: sourceInfo(head),
        against: sourceInfo(base),
        summary: { added: d.added.length, changed: d.changed.length, deleted: d.deleted.length },
        added: d.added,
        changed: d.changed,
        deleted: d.deleted,
        ...(d.not_compared.length ? { not_compared: d.not_compared, note: `Not compared (not read from workspaces): ${d.not_compared.join(', ')}.` } : {}),
      };
    }),
  );

  server.registerTool(
    'audit_container',
    {
      title: 'Tag Pilot check: container audit',
      description:
        'Tag Pilot tracking-health check for a GTM container. Flags tags that can never fire (no triggers, missing triggers, expired schedules), paused tags, ' +
        'unused triggers and variables, non-Google tags without consent settings (web containers), Google tag / GA4 configuration IDs loaded by more than ' +
        'one tag (double counting), and, for a workspace, changes that are not published yet. Reads the live version by default; pass workspace_id to audit ' +
        'a workspace (one extra call for the live version). Findings are sorted high → info.',
      inputSchema: sourceShape,
      annotations: READ_ONLY,
    },
    safe(async (a) => {
      const s = await api.snapshot(a.account_id, a.container_id, source(a));
      let unpublished = null;
      let neverPublished = false;
      if (s.source.type === 'workspace') {
        const live = await api.getLiveVersionOrNull(s.accountId, s.containerId);
        if (live) unpublished = diffSnapshots(snapshotFromVersion(s.accountId, s.containerId, live, true), s);
        else neverPublished = true;
      }
      const findings = auditSnapshot(s, { unpublished, neverPublished, now: now() });
      return {
        container: containerInfo(s),
        source: sourceInfo(s),
        counts: counts(s),
        findings: findings.map((f) =>
          f.items && f.items.length > MAX_ITEMS ? { ...f, items: f.items.slice(0, MAX_ITEMS), more_items: f.items.length - MAX_ITEMS } : f,
        ),
        ...(findings.length ? {} : { note: 'No issues found by these checks.' }),
        ...(s.source.type === 'version' ? { tip: 'Pass workspace_id to audit a workspace and see its unpublished changes.' } : {}),
        method:
          'Offline checks over one snapshot of the container (plus the live version for a workspace). Rules of thumb, not GTM errors: ' +
          '"unused" means not referenced inside the container; consent settings are only checked for non-Google tags in web containers.',
      };
    }),
  );
}
