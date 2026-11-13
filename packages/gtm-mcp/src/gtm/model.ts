// One container's entities, read either from a workspace (several list calls) or from a container
// version (one call), normalized to the same shape so every tool works on both.
// Entity bodies stay as the Tag Manager API returns them (lowercase parameter types, string ids).

export interface Parameter {
  type?: string;
  key?: string;
  value?: string;
  list?: Parameter[];
  map?: Parameter[];
}

export interface Entity {
  name?: string;
  type?: string;
  parameter?: Parameter[];
  parentFolderId?: string;
  notes?: string;
  tagManagerUrl?: string;
  [field: string]: unknown;
}

export interface Tag extends Entity {
  tagId?: string;
  firingTriggerId?: string[];
  blockingTriggerId?: string[];
  paused?: boolean;
  setupTag?: Array<{ tagName?: string }>;
  teardownTag?: Array<{ tagName?: string }>;
  consentSettings?: { consentStatus?: string; consentType?: Parameter };
  scheduleStartMs?: string;
  scheduleEndMs?: string;
}

export interface Template extends Entity {
  templateId?: string;
  templateData?: string;
  galleryReference?: { owner?: string; repository?: string; galleryTemplateId?: string };
}

/** The entity kinds a snapshot holds, with their numeric id field (built-in variables have none: their `type` is the key). */
export const KINDS = {
  tag: { key: 'tags', idField: 'tagId' },
  trigger: { key: 'triggers', idField: 'triggerId' },
  variable: { key: 'variables', idField: 'variableId' },
  built_in_variable: { key: 'builtIns', idField: 'type' },
  template: { key: 'templates', idField: 'templateId' },
  folder: { key: 'folders', idField: 'folderId' },
  client: { key: 'clients', idField: 'clientId' },
  transformation: { key: 'transformations', idField: 'transformationId' },
  zone: { key: 'zones', idField: 'zoneId' },
} as const;
export type Kind = keyof typeof KINDS;
export const KIND_NAMES = Object.keys(KINDS) as Kind[];

export interface Snapshot {
  accountId: string;
  containerId: string;
  publicId?: string;
  containerName?: string;
  /** "web", "server", "amp", "android", "ios", … */
  usageContext: string[];
  source: { type: 'workspace'; workspaceId: string; name?: string } | { type: 'version'; versionId: string; name?: string; live: boolean };
  tags: Tag[];
  triggers: Entity[];
  variables: Entity[];
  builtIns: Entity[];
  templates: Template[];
  folders: Entity[];
  clients: Entity[];
  transformations: Entity[];
  zones: Entity[];
  /** Kinds this snapshot did not read (absent, not empty), e.g. zones of a workspace. */
  unread: Kind[];
}

export interface ContainerVersion {
  containerVersionId?: string;
  name?: string;
  description?: string;
  container?: { publicId?: string; name?: string; usageContext?: string[] };
  tag?: Tag[];
  trigger?: Entity[];
  variable?: Entity[];
  builtInVariable?: Entity[];
  customTemplate?: Template[];
  folder?: Entity[];
  client?: Entity[];
  transformation?: Entity[];
  zone?: Entity[];
  tagManagerUrl?: string;
}

export function snapshotFromVersion(accountId: string, containerId: string, v: ContainerVersion, live: boolean): Snapshot {
  return {
    accountId,
    containerId,
    publicId: v.container?.publicId,
    containerName: v.container?.name,
    usageContext: v.container?.usageContext ?? [],
    source: { type: 'version', versionId: String(v.containerVersionId ?? ''), name: v.name || undefined, live },
    tags: v.tag ?? [],
    triggers: v.trigger ?? [],
    variables: v.variable ?? [],
    builtIns: v.builtInVariable ?? [],
    templates: v.customTemplate ?? [],
    folders: v.folder ?? [],
    clients: v.client ?? [],
    transformations: v.transformation ?? [],
    zones: v.zone ?? [],
    unread: [],
  };
}

export const entitiesOf = (s: Snapshot, kind: Kind): Entity[] => s[KINDS[kind].key];
export const idOf = (kind: Kind, e: Entity): string => String(e[KINDS[kind].idField] ?? '');
export const isServer = (s: Snapshot) => s.usageContext.includes('server');

/**
 * GTM's reserved built-in triggers (All Pages, Initialization, Consent Initialization, server "All
 * Events"…) have ids in a band just below INT32_MAX. Only "All Pages" of a web container is named:
 * the other ids differ between container types and aren't documented.
 */
export const RESERVED_TRIGGER_ID_MIN = 2147479553;
export const isReservedTriggerId = (id: string) => /^\d+$/.test(id) && Number(id) >= RESERVED_TRIGGER_ID_MIN;

export function triggerLabel(s: Snapshot, id: string): string {
  const t = s.triggers.find((x) => String(x.triggerId) === id);
  if (t) return t.name ?? id;
  if (id === '2147479553' && !isServer(s)) return 'All Pages (built-in)';
  if (isReservedTriggerId(id)) return `built-in trigger ${id}`;
  return `missing trigger ${id}`;
}

/** Walks a parameter tree (LIST items and MAP entries are parameters too). */
export function eachParameter(params: Parameter[] | undefined, fn: (p: Parameter) => void): void {
  for (const p of params ?? []) {
    if (!p || typeof p !== 'object') continue;
    fn(p);
    eachParameter(p.list, fn);
    eachParameter(p.map, fn);
  }
}

/** The value of a top-level parameter. */
export const param = (e: Entity, key: string): string | undefined => e.parameter?.find((p) => p.key === key)?.value;

/** `tagReference` (read API) and `TAG_REFERENCE` (export format) are the same type. */
export const sameEnum = (a: unknown, b: string) => String(a).replace(/[^a-z0-9]/gi, '').toUpperCase() === b.replace(/[^a-z0-9]/gi, '').toUpperCase();

/** Every `{{Name}}` in an entity body: how tags, triggers and variables use variables. */
export function variableRefsIn(e: Entity): Set<string> {
  const out = new Set<string>();
  for (const m of JSON.stringify(e).matchAll(/\{\{([^{}]+)\}\}/g)) out.add(m[1].trim());
  return out;
}

/** Trigger ids an entity points at: firing/blocking (tags), enabling/disabling (variables), trigger group members. */
export function triggerRefsIn(e: Entity): Array<{ id: string; via: string }> {
  const out: Array<{ id: string; via: string }> = [];
  for (const via of ['firingTriggerId', 'blockingTriggerId', 'enablingTriggerId', 'disablingTriggerId']) {
    const ids = e[via];
    if (Array.isArray(ids)) for (const id of ids) out.push({ id: String(id), via });
  }
  eachParameter(e.parameter, (p) => {
    if (sameEnum(p.type, 'TRIGGER_REFERENCE') && p.value != null) out.push({ id: String(p.value), via: 'trigger group' });
  });
  return out;
}

/** Tag names an entity points at: tag sequencing (setup/cleanup tags) and tag-reference parameters. */
export function tagRefsIn(e: Entity): Array<{ name: string; via: string }> {
  const out: Array<{ name: string; via: string }> = [];
  for (const via of ['setupTag', 'teardownTag']) {
    const seq = e[via];
    if (Array.isArray(seq)) for (const s of seq as Array<{ tagName?: string }>) if (s?.tagName) out.push({ name: s.tagName, via });
  }
  eachParameter(e.parameter, (p) => {
    if (sameEnum(p.type, 'TAG_REFERENCE') && p.value) out.push({ name: p.value, via: 'tag reference parameter' });
  });
  return out;
}

/**
 * The vendor `type` codes a custom template backs: `cvt_<containerId>_<templateId>` for a local
 * template, `cvt_<galleryTemplateId>` for a Community Template Gallery one.
 */
export function templateTypeCodes(t: Template, containerId: string): Set<string> {
  const codes = new Set<string>();
  if (t.templateId != null) codes.add(`cvt_${containerId}_${t.templateId}`);
  if (t.galleryReference?.galleryTemplateId) codes.add(`cvt_${t.galleryReference.galleryTemplateId}`);
  return codes;
}

export function templateFor(s: Snapshot, type: string | undefined): Template | undefined {
  if (!type?.startsWith('cvt_')) return undefined;
  return s.templates.find((t) => templateTypeCodes(t, s.containerId).has(type) || (t.templateId != null && new RegExp(`^cvt_\\d+_${t.templateId}$`).test(type)));
}

/** Fields that only say where an entity lives, not what it does. */
const META = new Set(['path', 'accountId', 'containerId', 'workspaceId', 'fingerprint', 'containerVersionId']);

/** An entity without location metadata (and a template without its source, unless asked for). */
export function clean(e: Entity, { templateSource = true } = {}): Entity {
  const out: Entity = {};
  for (const [k, v] of Object.entries(e)) if (!META.has(k) && !(k === 'templateData' && !templateSource)) out[k] = v;
  if (!templateSource && typeof e.templateData === 'string') out.templateDataChars = e.templateData.length;
  return out;
}
