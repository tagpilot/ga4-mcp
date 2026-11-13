// The compact view of a snapshot (get_container's default): one short line of fields per entity,
// trigger ids resolved to names, template source and parameters left out.
import { clean, isServer, templateFor, triggerLabel, type Entity, type Snapshot } from './model.js';

const folderName = (s: Snapshot, id: unknown) => (id == null ? undefined : (s.folders.find((f) => String(f.folderId) === String(id))?.name ?? String(id)));

export function containerInfo(s: Snapshot) {
  return {
    account_id: s.accountId,
    container_id: s.containerId,
    public_id: s.publicId,
    name: s.containerName,
    usage_context: s.usageContext,
  };
}

export function sourceInfo(s: Snapshot) {
  return s.source.type === 'workspace'
    ? { workspace_id: s.source.workspaceId, name: s.source.name }
    : { version_id: s.source.versionId, name: s.source.name, live: s.source.live };
}

function compactEntity(s: Snapshot, e: Entity, idField: string) {
  const template = templateFor(s, e.type);
  return {
    id: e[idField] as string | undefined,
    name: e.name,
    type: e.type,
    ...(template ? { template: template.name } : {}),
    ...(e.parentFolderId ? { folder: folderName(s, e.parentFolderId) } : {}),
  };
}

export function counts(s: Snapshot) {
  return {
    tags: s.tags.length,
    paused_tags: s.tags.filter((t) => t.paused).length,
    triggers: s.triggers.length,
    variables: s.variables.length,
    built_in_variables: s.builtIns.length,
    templates: s.templates.length,
    folders: s.folders.length,
    ...(isServer(s) ? { clients: s.clients.length, transformations: s.transformations.length } : {}),
    ...(s.zones.length ? { zones: s.zones.length } : {}),
  };
}

export function compactSnapshot(s: Snapshot) {
  return {
    container: containerInfo(s),
    source: sourceInfo(s),
    counts: counts(s),
    tags: s.tags.map((t) => ({
      ...compactEntity(s, t, 'tagId'),
      ...(t.paused ? { paused: true } : {}),
      firing: (t.firingTriggerId ?? []).map((id) => triggerLabel(s, String(id))),
      ...(t.blockingTriggerId?.length ? { blocking: t.blockingTriggerId.map((id) => triggerLabel(s, String(id))) } : {}),
    })),
    triggers: s.triggers.map((t) => compactEntity(s, t, 'triggerId')),
    variables: s.variables.map((v) => compactEntity(s, v, 'variableId')),
    ...(isServer(s) || s.clients.length ? { clients: s.clients.map((c) => compactEntity(s, c, 'clientId')) } : {}),
    ...(s.transformations.length ? { transformations: s.transformations.map((t) => compactEntity(s, t, 'transformationId')) } : {}),
    ...(s.zones.length ? { zones: s.zones.map((z) => compactEntity(s, z, 'zoneId')) } : {}),
    templates: s.templates.map((t) => ({
      id: t.templateId,
      name: t.name,
      ...(t.galleryReference?.repository ? { gallery: `${t.galleryReference.owner}/${t.galleryReference.repository}` } : {}),
    })),
    folders: s.folders.map((f) => ({ id: f.folderId as string | undefined, name: f.name })),
    built_in_variables: s.builtIns.map((b) => b.name),
  };
}

/** Every entity body as the API returns it, minus location metadata and template source. */
export function fullSnapshot(s: Snapshot) {
  const c = (list: Entity[]) => list.map((e) => clean(e, { templateSource: false }));
  return {
    container: containerInfo(s),
    source: sourceInfo(s),
    counts: counts(s),
    tags: c(s.tags),
    triggers: c(s.triggers),
    variables: c(s.variables),
    ...(isServer(s) || s.clients.length ? { clients: c(s.clients) } : {}),
    ...(s.transformations.length ? { transformations: c(s.transformations) } : {}),
    ...(s.zones.length ? { zones: c(s.zones) } : {}),
    templates: c(s.templates),
    folders: c(s.folders),
    built_in_variables: s.builtIns.map((b) => ({ name: b.name, type: b.type })),
  };
}
