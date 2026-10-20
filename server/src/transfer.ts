import { SCHEMA_VERSION, type ExportFile, type Timeline, type TLNode } from '../../shared/types.ts';
import { ancestorIdsOf, descendantsOf, listTimelines, newId, now, parentIdsOf } from './store.ts';
import { MigrationError, migrateTimeline } from './migrate.ts';
import { emptyTimelineUsage, nodesSpent } from '../../shared/usage.ts';

/** Strips in-flight state so an exported file only holds finished history. */
function cleanNode(n: TLNode): TLNode {
  const { jobId: _job, error: _err, ...rest } = n;
  return { ...rest, status: 'ready' };
}

export function buildExport(tl: Timeline, branchNodeId?: string): ExportFile {
  let picked: TLNode[];
  if (branchNodeId) {
    // The branch, plus every ancestor of anything in it, so convergence nodes keep both of their histories.
    const ids = new Set<string>([branchNodeId, ...ancestorIdsOf(tl, branchNodeId)]);
    for (const d of descendantsOf(tl, branchNodeId)) {
      ids.add(d.id);
      for (const a of ancestorIdsOf(tl, d.id)) ids.add(a);
    }
    picked = [...ids].map((id) => tl.nodes[id]);
  } else {
    picked = Object.values(tl.nodes);
  }
  // Parents are always created before their children, so this order visits parents first.
  picked.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const nodes: Record<string, TLNode> = {};
  const skipped = new Set<string>();
  for (const n of picked) {
    // Unfinished placeholders (and anything under them) carry no content worth keeping.
    if (n.status !== 'ready' || parentIdsOf(n).some((p) => skipped.has(p))) {
      skipped.add(n.id);
      continue;
    }
    nodes[n.id] = cleanNode(n);
  }
  const branchNode = branchNodeId ? tl.nodes[branchNodeId] : undefined;
  return {
    format: 'forkpath',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now(),
    scope: branchNodeId ? 'branch' : 'timeline',
    branchNodeId,
    timeline: {
      ...tl,
      title: branchNode && branchNode.id !== tl.rootId ? `${tl.title}: ${branchNode.title}` : tl.title,
      nodes,
      links: tl.links.filter((l) => nodes[l.from] && nodes[l.to]),
      // A branch carries what its own nodes cost, not the whole world's spend (failures included).
      usage: branchNodeId && tl.usage ? { ...emptyTimelineUsage(), total: nodesSpent(Object.values(nodes)) } : tl.usage,
    },
  };
}

export function exportFileName(file: ExportFile): string {
  const slug = file.timeline.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${slug || 'timeline'}.${file.scope}.v${file.schemaVersion}.forkpath.json`;
}

/**
 * Turns an uploaded file (an ExportFile, or a bare timeline JSON from data/timelines) into a new timeline
 * at the current schema version, with fresh ids so it never collides with what is already loaded.
 */
export function importFile(raw: unknown): Timeline {
  if (!raw || typeof raw !== 'object') throw new MigrationError('File is not JSON object.');
  const obj = raw as Record<string, any>;
  let source: Record<string, any>;
  if ((obj.format === 'forkpath' || obj.format === 'althistory') && obj.timeline) {
    source = structuredClone(obj.timeline);
    // Older exports may only carry the version on the envelope.
    source.schemaVersion ??= obj.schemaVersion;
  } else if (obj.nodes && obj.rootId) {
    source = structuredClone(obj);
  } else {
    throw new MigrationError('Not a Forkpath export file.');
  }

  const { timeline } = migrateTimeline(source);

  // Remap every id.
  const idMap = new Map<string, string>();
  for (const id of Object.keys(timeline.nodes)) idMap.set(id, newId());
  const nodes: Record<string, TLNode> = {};
  for (const n of Object.values(timeline.nodes)) {
    if (n.parentId && !idMap.has(n.parentId)) continue; // orphan in a hand-edited file
    const id = idMap.get(n.id)!;
    const mergeParents = (n.mergeParents ?? []).filter((p) => idMap.has(p)).map((p) => idMap.get(p)!);
    nodes[id] = { ...cleanNode(n), id, parentId: n.parentId ? idMap.get(n.parentId)! : null, mergeParents };
    if (!mergeParents.length) delete nodes[id].mergeParents;
  }
  const rootId = idMap.get(timeline.rootId)!;
  const links = timeline.links
    .filter((l) => nodes[idMap.get(l.from) ?? ''] && nodes[idMap.get(l.to) ?? ''])
    .map((l) => ({ ...l, id: newId(), from: idMap.get(l.from)!, to: idMap.get(l.to)! }));

  const taken = new Set(listTimelines().map((t) => t.title));
  let title = timeline.title || 'Imported timeline';
  if (taken.has(title)) title = `${title} (imported)`;

  const ts = now();
  return { ...timeline, schemaVersion: SCHEMA_VERSION, id: newId(), title, rootId, nodes, links, createdAt: ts, updatedAt: ts };
}
