// get_tag, get_trigger, get_variable, find_references: one entity in full, and what uses it.
// All of them read the same cached snapshot as get_container, so they cost no extra API calls.
import { z } from 'zod';
import { clean, templateFor, triggerLabel, type Entity, type Snapshot, type Tag } from '../gtm/model.js';
import { REFERENCE_KINDS, describeSource, findEntity, findVariable, referencesTo, targetFor, variablesUsedBy, type Ref } from '../gtm/refs.js';
import { containerInfo, sourceInfo } from '../gtm/summary.js';
import { READ_ONLY, safe, type ToolContext } from './common.js';
import { entityQueryShape, source, sourceShape } from './schemas.js';

const usedBy = (refs: Ref[]) => refs.map(({ kind, id, name, type, via }) => ({ kind, id: id || undefined, name, type, via }));

function header(s: Snapshot) {
  return { container: containerInfo(s), source: sourceInfo(s) };
}

function folderOf(s: Snapshot, e: Entity) {
  return e.parentFolderId ? (s.folders.find((f) => String(f.folderId) === String(e.parentFolderId))?.name ?? e.parentFolderId) : undefined;
}

function templateInfo(s: Snapshot, e: Entity) {
  const t = templateFor(s, e.type);
  return t ? { template: { id: t.templateId, name: t.name } } : {};
}

export function registerEntityTools({ server, api }: ToolContext): void {
  server.registerTool(
    'get_tag',
    {
      title: 'Get one tag',
      description:
        'One tag in full (by id or name): type, parameters, firing and blocking triggers (with names), consent settings, tag sequencing, ' +
        'firing option, schedule, notes, and the variables it uses. Reads the live version unless workspace_id or version_id is given.',
      inputSchema: entityQueryShape,
      annotations: READ_ONLY,
    },
    safe(async (a) => {
      const s = await api.snapshot(a.account_id, a.container_id, source(a));
      const t = findEntity(s, 'tag', a) as Tag;
      const triggers = (ids: string[] | undefined) => (ids ?? []).map((id) => ({ id: String(id), name: triggerLabel(s, String(id)) }));
      return {
        ...header(s),
        tag: clean(t),
        folder: folderOf(s, t),
        ...templateInfo(s, t),
        firing_triggers: triggers(t.firingTriggerId),
        blocking_triggers: triggers(t.blockingTriggerId),
        uses: variablesUsedBy(s, t),
        used_by: usedBy(referencesTo(s, 'tag', t)),
      };
    }),
  );

  server.registerTool(
    'get_trigger',
    {
      title: 'Get one trigger',
      description:
        'One trigger in full (by id or name): type, conditions (filter, customEventFilter, autoEventFilter), parameters, the variables it uses, ' +
        'and the tags, trigger groups and variables that use it. Reads the live version unless workspace_id or version_id is given.',
      inputSchema: entityQueryShape,
      annotations: READ_ONLY,
    },
    safe(async (a) => {
      const s = await api.snapshot(a.account_id, a.container_id, source(a));
      const t = findEntity(s, 'trigger', a);
      return { ...header(s), trigger: clean(t), folder: folderOf(s, t), uses: variablesUsedBy(s, t), used_by: usedBy(referencesTo(s, 'trigger', t)) };
    }),
  );

  server.registerTool(
    'get_variable',
    {
      title: 'Get one variable',
      description:
        'One variable in full (by id or name; built-in variables such as "Page URL" by name): type, parameters, format settings, the variables it ' +
        'uses, and the tags, triggers and variables that use it. Reads the live version unless workspace_id or version_id is given.',
      inputSchema: entityQueryShape,
      annotations: READ_ONLY,
    },
    safe(async (a) => {
      const s = await api.snapshot(a.account_id, a.container_id, source(a));
      const { entity: v, builtIn } = findVariable(s, a);
      return {
        ...header(s),
        variable: { ...clean(v), ...(builtIn ? { built_in: true } : {}) },
        folder: folderOf(s, v),
        ...templateInfo(s, v),
        ...(builtIn ? {} : { uses: variablesUsedBy(s, v) }),
        used_by: usedBy(referencesTo(s, 'variable', v)),
      };
    }),
  );

  server.registerTool(
    'find_references',
    {
      title: 'Find references',
      description:
        'What uses an entity: for a variable (or built-in variable), every tag, trigger, variable or client containing {{Name}}; for a trigger, the tags ' +
        'that fire on or are blocked by it, trigger groups and variables; for a tag, tags that sequence it; for a custom template, the tags, variables ' +
        'and clients built from it; for a folder, its contents. Check this before suggesting to change, rename or delete something.',
      inputSchema: {
        ...sourceShape,
        kind: z.enum(REFERENCE_KINDS).describe('What to look up.'),
        id: entityQueryShape.id,
        name: entityQueryShape.name,
      },
      annotations: READ_ONLY,
    },
    safe(async (a) => {
      const s = await api.snapshot(a.account_id, a.container_id, source(a));
      const { entity, builtIn } = targetFor(s, a.kind, a);
      const refs = referencesTo(s, a.kind, entity);
      return {
        ...header(s),
        target: { kind: builtIn ? 'built_in_variable' : a.kind, id: (entity[`${a.kind}Id`] as string | undefined), name: entity.name, type: entity.type },
        count: refs.length,
        used_by: usedBy(refs),
        ...(refs.length ? {} : { note: `Nothing in ${describeSource(s)} uses it.` }),
      };
    }),
  );
}
