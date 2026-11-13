// Tag Pilot container audit: opinionated, offline checks over one snapshot (plus the live version
// for unpublished changes). Rules of thumb, not GTM errors; every finding says what it looked at.
import type { SnapshotDiff } from './diff.js';
import { isReservedTriggerId, isServer, param, tagRefsIn, triggerLabel, triggerRefsIn, variableRefsIn, type Entity, type Snapshot, type Tag } from './model.js';

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  check: string;
  severity: Severity;
  message: string;
  items?: unknown[];
}

/**
 * Google's own tags check consent mode themselves ("built-in consent checks"), so they don't need
 * additional consent settings. Types: Google tag, GA4 config/event, Google Ads conversion/remarketing,
 * Conversion Linker, Floodlight counter/sales, Google Ads user-provided data.
 */
export const BUILT_IN_CONSENT_TYPES = new Set(['googtag', 'gaawc', 'gaawe', 'awct', 'sp', 'gclidw', 'flc', 'fls', 'awud', 'awcc']);

/** Tags that load a Google tag / GA4 configuration, and the parameter holding its ID. */
const GOOGLE_TAG_ID_PARAM: Record<string, string> = { googtag: 'tagId', gaawc: 'measurementId' };

const SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low', 'info'];
const ref = (t: Entity, idField: string) => ({ id: t[idField] as string | undefined, name: t.name, type: t.type });

export interface AuditOptions {
  /** Workspace vs live diff (only for a workspace audit). */
  unpublished?: SnapshotDiff | null;
  /** The workspace audit found no live version at all. */
  neverPublished?: boolean;
  now?: number;
}

export function auditSnapshot(s: Snapshot, opts: AuditOptions = {}) {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const now = opts.now ?? Date.now();
  const active = s.tags.filter((t) => !t.paused);

  // Tags referenced by other tags (sequencing) fire without triggers of their own.
  const sequenced = new Set<string>();
  for (const t of s.tags) for (const r of tagRefsIn(t)) sequenced.add(r.name);

  const paused = s.tags.filter((t) => t.paused);
  if (paused.length) {
    add({
      check: 'paused_tags',
      severity: 'info',
      message: `${paused.length} paused tag(s). Paused tags never fire; delete the ones nobody needs any more.`,
      items: paused.map((t) => ref(t, 'tagId')),
    });
  }

  const noTriggers = active.filter((t) => !(t.firingTriggerId ?? []).length && !sequenced.has(t.name ?? ''));
  if (noTriggers.length) {
    add({
      check: 'tags_without_triggers',
      severity: 'medium',
      message: `${noTriggers.length} active tag(s) have no firing trigger and aren't fired by tag sequencing, so they never fire.`,
      items: noTriggers.map((t) => ref(t, 'tagId')),
    });
  }

  const triggerIds = new Set(s.triggers.map((t) => String(t.triggerId)));
  const missing: Array<Record<string, unknown>> = [];
  for (const e of [...s.tags, ...s.triggers, ...s.variables]) {
    for (const r of triggerRefsIn(e)) {
      if (!triggerIds.has(r.id) && !isReservedTriggerId(r.id)) missing.push({ name: e.name, type: e.type, trigger_id: r.id, via: r.via });
    }
  }
  if (missing.length) {
    add({ check: 'missing_triggers', severity: 'high', message: `${missing.length} reference(s) to triggers that don't exist in this container.`, items: missing });
  }

  const usedTriggers = new Set<string>();
  for (const e of [...s.tags, ...s.triggers, ...s.variables, ...s.clients, ...s.transformations]) for (const r of triggerRefsIn(e)) usedTriggers.add(r.id);
  const unusedTriggers = s.triggers.filter((t) => !usedTriggers.has(String(t.triggerId)));
  if (unusedTriggers.length) {
    add({
      check: 'unused_triggers',
      severity: 'low',
      message: `${unusedTriggers.length} trigger(s) are not used by any tag, trigger group or variable.`,
      items: unusedTriggers.map((t) => ref(t, 'triggerId')),
    });
  }

  const usedVariables = new Set<string>();
  for (const e of [...s.tags, ...s.triggers, ...s.variables, ...s.clients, ...s.transformations, ...s.zones]) {
    for (const n of variableRefsIn(e)) if (n !== e.name) usedVariables.add(n);
  }
  const unusedVariables = s.variables.filter((v) => !usedVariables.has(v.name ?? ''));
  if (unusedVariables.length) {
    add({
      check: 'unused_variables',
      severity: 'low',
      message:
        `${unusedVariables.length} variable(s) are not referenced as {{Name}} anywhere in the container. ` +
        'Custom HTML or JavaScript that reads them through google_tag_manager[…].dataLayer.get or similar is not detected.',
      items: unusedVariables.map((v) => ref(v, 'variableId')),
    });
  }

  if (!isServer(s)) {
    const noConsent = active.filter((t) => !BUILT_IN_CONSENT_TYPES.has(t.type ?? '') && (t.consentSettings?.consentStatus ?? 'notSet') === 'notSet');
    if (noConsent.length) {
      add({
        check: 'tags_without_consent_settings',
        severity: 'medium',
        message:
          `${noConsent.length} active non-Google tag(s) have no consent settings ("Not set"). If the site uses consent mode, set "Require additional consent" ` +
          '(e.g. ad_storage, analytics_storage) or "No additional consent required" deliberately. Google tags are skipped: they have built-in consent checks.',
        items: noConsent.map((t) => ref(t, 'tagId')),
      });
    }

    const byId = new Map<string, Tag[]>();
    for (const t of active) {
      const key = GOOGLE_TAG_ID_PARAM[t.type ?? ''];
      const id = key && param(t, key)?.trim();
      if (id) byId.set(id, [...(byId.get(id) ?? []), t]);
    }
    const dups = [...byId].filter(([, tags]) => tags.length > 1);
    if (dups.length) {
      add({
        check: 'duplicate_google_tags',
        severity: 'high',
        message:
          `${dups.length} Google tag / GA4 configuration ID(s) are loaded by more than one active tag. If they fire on the same page, GA4 gets ` +
          'duplicate page views and sessions; keep one Google tag per ID (or make sure their triggers never overlap).',
        items: dups.map(([id, tags]) => ({
          tag_id: id,
          tags: tags.map((t) => ({ ...ref(t, 'tagId'), firing: (t.firingTriggerId ?? []).map((x) => triggerLabel(s, String(x))) })),
        })),
      });
    }
  }

  const expired = active.filter((t) => t.scheduleEndMs && Number(t.scheduleEndMs) < now);
  if (expired.length) {
    add({
      check: 'expired_schedules',
      severity: 'low',
      message: `${expired.length} tag(s) have a schedule that ended, so they no longer fire. Pause or delete them.`,
      items: expired.map((t) => ({ ...ref(t, 'tagId'), schedule_end: new Date(Number(t.scheduleEndMs)).toISOString() })),
    });
  }

  if (opts.neverPublished) {
    add({ check: 'unpublished_changes', severity: 'medium', message: 'This container has never been published: nothing in it runs on the site yet.' });
  } else if (opts.unpublished) {
    const d = opts.unpublished;
    const n = d.added.length + d.changed.length + d.deleted.length;
    if (n) {
      add({
        check: 'unpublished_changes',
        severity: 'info',
        message: `The workspace has ${n} change(s) that are not live: ${d.added.length} added, ${d.changed.length} changed, ${d.deleted.length} deleted. Use diff for the details.`,
        items: [...d.added.map((e) => ({ ...e, change: 'added' })), ...d.changed.map((e) => ({ kind: e.kind, id: e.id, name: e.name, change: 'changed' })), ...d.deleted.map((e) => ({ ...e, change: 'deleted' }))],
      });
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  return findings;
}
