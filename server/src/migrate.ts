import { SCHEMA_VERSION, SIGNIFICANCES, STRENGTHS, TONES, type Timeline } from '../../shared/types.ts';

/**
 * Upgrades stored or imported timelines to the current SCHEMA_VERSION.
 *
 * To change the format: bump SCHEMA_VERSION in shared/types.ts and add a step here keyed by the version it
 * upgrades FROM. Steps run in order, so a v1 file goes 1 -> 2 -> 3 ... and old saves never break.
 */
type Raw = Record<string, any>;

const steps: Record<number, (tl: Raw) => Raw> = {
  // v1 -> v2: version field, node significance and tone.
  1: (tl) => {
    for (const n of Object.values(tl.nodes ?? {}) as Raw[]) {
      n.significance ??= n.kind === 'deviation' ? 'pivotal' : 'notable';
      n.tone ??= 'neutral';
    }
    return tl;
  },
  // v2 -> v3: optional mergeParents. Nothing to fill in; older files simply have no convergence nodes.
  2: (tl) => tl,
  // v3 -> v4: parallel threads (optional node threadName) and influence links between nodes.
  3: (tl) => {
    tl.links ??= [];
    return tl;
  },
  // v4 -> v5: optional node streamName (a stream rename). Nothing to fill in.
  4: (tl) => tl,
};

export class MigrationError extends Error {}

export function versionOf(tl: Raw): number {
  return typeof tl.schemaVersion === 'number' ? tl.schemaVersion : 1;
}

/** Returns the timeline at the current version and whether anything changed. Mutates `raw`. */
export function migrateTimeline(raw: Raw): { timeline: Timeline; migrated: boolean; from: number } {
  if (!raw || typeof raw !== 'object' || typeof raw.nodes !== 'object' || !raw.rootId || !raw.nodes[raw.rootId]) {
    throw new MigrationError('Not an AltHistory timeline (missing nodes or root).');
  }
  const from = versionOf(raw);
  if (from > SCHEMA_VERSION) {
    throw new MigrationError(
      `This file uses format v${from}, but this app only understands up to v${SCHEMA_VERSION}. Update the app to open it.`,
    );
  }
  let tl = raw;
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = steps[v];
    if (!step) throw new MigrationError(`No migration from format v${v} to v${v + 1}.`);
    tl = step(tl);
    tl.schemaVersion = v + 1;
  }
  tl.schemaVersion = SCHEMA_VERSION;
  sanitize(tl);
  return { timeline: tl as Timeline, migrated: from !== SCHEMA_VERSION, from };
}

/** Repairs values that are invalid at any version, so one bad field never makes a file unreadable. */
function sanitize(tl: Raw) {
  for (const n of Object.values(tl.nodes) as Raw[]) {
    if (!SIGNIFICANCES.includes(n.significance)) n.significance = 'notable';
    if (!TONES.includes(n.tone)) n.tone = 'neutral';
    if (!Array.isArray(n.keyChanges)) n.keyChanges = [];
    for (const k of ['title', 'period', 'summary', 'narrative'] as const) if (typeof n[k] !== 'string') n[k] = '';
    n.stale = Boolean(n.stale);
    if (n.mergeParents !== undefined) {
      const ok = Array.isArray(n.mergeParents)
        ? n.mergeParents.filter((p: unknown) => typeof p === 'string' && p !== n.parentId && tl.nodes[p as string])
        : [];
      if (ok.length) n.mergeParents = [...new Set(ok)];
      else delete n.mergeParents;
    }
    if (n.threadName !== undefined) {
      const name = typeof n.threadName === 'string' ? n.threadName.trim().slice(0, 80) : '';
      if (name && n.parentId) n.threadName = name;
      else delete n.threadName;
    }
    if (n.streamName !== undefined) {
      const name = typeof n.streamName === 'string' ? n.streamName.trim().slice(0, 80) : '';
      if (name) n.streamName = name;
      else delete n.streamName;
    }
  }
  tl.links = (Array.isArray(tl.links) ? tl.links : []).filter(
    (l: Raw) =>
      l &&
      typeof l.id === 'string' &&
      tl.nodes[l.from] &&
      tl.nodes[l.to] &&
      l.from !== l.to &&
      STRENGTHS.includes(l.strength),
  );
  for (const l of tl.links as Raw[]) {
    if (typeof l.note !== 'string') l.note = '';
    if (l.source !== 'user') l.source = 'llm';
  }
}
