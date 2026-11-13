// "What uses this entity?" over one snapshot, offline (no API calls). The reference classes GTM uses:
//   variable / built-in variable → `{{Name}}` anywhere in another entity's body (how GTM resolves them)
//   trigger                      → firing/blocking trigger ids, a variable's enabling/disabling
//                                  triggers, trigger group members
//   tag                          → tag sequencing (setup/cleanup tag) and tag-reference parameters, by name
//   template                     → a tag/variable/client whose `type` is the template's type code
//   folder                       → an entity's parentFolderId
import { InputError } from '../core.js';
import {
  KIND_NAMES,
  entitiesOf,
  idOf,
  tagRefsIn,
  templateFor,
  triggerRefsIn,
  variableRefsIn,
  type Entity,
  type Kind,
  type Snapshot,
} from './model.js';

export const REFERENCE_KINDS = ['variable', 'trigger', 'tag', 'template', 'folder'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface Ref {
  kind: Kind;
  id: string;
  name?: string;
  type?: string;
  via: string;
}

/** Finds an entity by id, exact name, or case-insensitive name. Throws a helpful error otherwise. */
export function findEntity(s: Snapshot, kind: Kind, { id, name }: { id?: string; name?: string }): Entity {
  const all = entitiesOf(s, kind);
  if (!id && !name) throw new InputError(`Pass the ${kind.replace(/_/g, ' ')}'s id or name.`);
  const hit =
    (id ? all.find((e) => idOf(kind, e) === String(id)) : undefined) ??
    (name ? (all.find((e) => e.name === name) ?? all.find((e) => e.name?.toLowerCase() === name.trim().toLowerCase())) : undefined);
  if (hit) return hit;
  const what = id ? `id ${id}` : `name "${name}"`;
  const needle = (name ?? '').toLowerCase();
  const close = needle ? all.filter((e) => e.name?.toLowerCase().includes(needle)).slice(0, 10) : [];
  const hint = close.length
    ? ` Similar names: ${close.map((e) => `"${e.name}" (${idOf(kind, e)})`).join(', ')}.`
    : ` It has ${all.length} ${kind.replace(/_/g, ' ')}s; get_container lists them.`;
  throw new InputError(`No ${kind.replace(/_/g, ' ')} with ${what} in ${describeSource(s)}.${hint}`);
}

export function describeSource(s: Snapshot): string {
  return s.source.type === 'workspace'
    ? `workspace ${s.source.workspaceId}${s.source.name ? ` ("${s.source.name}")` : ''}`
    : `${s.source.live ? 'the live version' : 'version'} ${s.source.versionId}`;
}

function eachEntity(s: Snapshot, fn: (kind: Kind, e: Entity) => void): void {
  for (const kind of KIND_NAMES) for (const e of entitiesOf(s, kind)) fn(kind, e);
}

/** Entities that use `target` (of `kind`), excluding the target itself. */
export function referencesTo(s: Snapshot, kind: ReferenceKind, target: Entity): Ref[] {
  const refs: Ref[] = [];
  const add = (k: Kind, e: Entity, via: string) => refs.push({ kind: k, id: idOf(k, e), name: e.name, type: e.type, via });
  const targetId = kind === 'variable' && target.variableId == null ? null : idOf(kind, target);
  eachEntity(s, (k, e) => {
    if (e === target) return;
    switch (kind) {
      case 'variable':
        if (target.name && variableRefsIn(e).has(target.name)) add(k, e, `{{${target.name}}}`);
        break;
      case 'trigger': {
        const r = triggerRefsIn(e).find((x) => x.id === targetId);
        if (r) add(k, e, r.via);
        break;
      }
      case 'tag': {
        const r = tagRefsIn(e).find((x) => x.name === target.name);
        if (r) add(k, e, r.via);
        break;
      }
      case 'template':
        if (templateFor(s, e.type) === target) add(k, e, `type ${e.type}`);
        break;
      case 'folder':
        if (targetId && String(e.parentFolderId ?? '') === targetId) add(k, e, 'in folder');
        break;
    }
  });
  return refs;
}

/** A variable by id or name; built-in variables ("Page URL", "Event") are found by name too. */
export function findVariable(s: Snapshot, q: { id?: string; name?: string }): { entity: Entity; builtIn: boolean } {
  try {
    return { entity: findEntity(s, 'variable', q), builtIn: false };
  } catch (e) {
    const name = q.name?.replace(/^\{\{|\}\}$/g, '').trim();
    const b = name && s.builtIns.find((x) => x.name?.toLowerCase() === name.toLowerCase());
    if (b) return { entity: b, builtIn: true };
    if (name && name !== q.name) return findVariable(s, { ...q, name });
    throw e;
  }
}

export function targetFor(s: Snapshot, kind: ReferenceKind, q: { id?: string; name?: string }): { entity: Entity; builtIn: boolean } {
  if (kind === 'variable') return findVariable(s, q);
  return { entity: findEntity(s, kind, q), builtIn: false };
}

/** Variable names an entity uses, split into user-defined and built-in (unknown names are listed as missing). */
export function variablesUsedBy(s: Snapshot, e: Entity) {
  // `{{_event}}` and similar are GTM internals, not variables.
  const names = [...variableRefsIn(e)].filter((n) => !n.startsWith('_'));
  const user = new Set(s.variables.map((v) => v.name));
  const builtIn = new Set(s.builtIns.map((v) => v.name));
  return {
    variables: names.filter((n) => user.has(n)),
    built_in_variables: names.filter((n) => builtIn.has(n)),
    ...(names.some((n) => !user.has(n) && !builtIn.has(n)) ? { unknown_variables: names.filter((n) => !user.has(n) && !builtIn.has(n)) } : {}),
  };
}
