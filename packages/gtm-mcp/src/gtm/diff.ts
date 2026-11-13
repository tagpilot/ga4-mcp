// Workspace vs a container version (normally the live one): which entities were added, changed or
// deleted, matched by id per kind (built-in variables by type). Location metadata (path,
// fingerprint, workspace id) is ignored; parameter lists are compared regardless of order.
import { KIND_NAMES, clean, entitiesOf, idOf, type Entity, type Kind, type Snapshot } from './model.js';

/** JSON with sorted object keys, and keyed parameter/map arrays sorted by key. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    const keyed = items.every((i) => i && typeof i === 'object' && typeof (i as { key?: unknown }).key === 'string');
    return keyed ? [...items].sort((a, b) => String((a as { key: string }).key).localeCompare(String((b as { key: string }).key))) : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export interface DiffEntry {
  kind: Kind;
  id: string;
  name?: string;
  type?: string;
}

export interface ChangedEntry extends DiffEntry {
  fields: string[];
  renamed_from?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export interface SnapshotDiff {
  added: DiffEntry[];
  changed: ChangedEntry[];
  deleted: DiffEntry[];
  /** Kinds left out because one side wasn't read. */
  not_compared: Kind[];
}

const entry = (kind: Kind, e: Entity): DiffEntry => ({ kind, id: idOf(kind, e), name: e.name, type: e.type });

export function diffSnapshots(base: Snapshot, head: Snapshot, { includeValues = false } = {}): SnapshotDiff {
  const out: SnapshotDiff = { added: [], changed: [], deleted: [], not_compared: [] };
  for (const kind of KIND_NAMES) {
    if (base.unread.includes(kind) || head.unread.includes(kind)) {
      out.not_compared.push(kind);
      continue;
    }
    const before = new Map(entitiesOf(base, kind).map((e) => [idOf(kind, e), e]));
    const after = new Map(entitiesOf(head, kind).map((e) => [idOf(kind, e), e]));
    for (const [id, e] of after) {
      const old = before.get(id);
      if (!old) {
        out.added.push(entry(kind, e));
        continue;
      }
      const a = clean(old);
      const b = clean(e);
      // tagManagerUrl differs between a workspace and a version of the same entity.
      const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => f !== 'tagManagerUrl' && !same(a[f], b[f])).sort();
      if (!fields.length) continue;
      const pick = (o: Entity) => Object.fromEntries(fields.map((f) => [f, f === 'templateData' ? `${String(o[f] ?? '').length} chars` : o[f]]));
      out.changed.push({
        ...entry(kind, e),
        fields,
        ...(old.name !== e.name ? { renamed_from: old.name } : {}),
        ...(includeValues ? { before: pick(a), after: pick(b) } : {}),
      });
    }
    for (const [id, e] of before) if (!after.has(id)) out.deleted.push(entry(kind, e));
  }
  return out;
}
