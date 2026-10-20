import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Timeline, TimelineSummary, TLNode } from '../../shared/types.ts';
import { WorldIndex } from '../../shared/world.ts';
import { migrateTimeline } from './migrate.ts';

export const DATA_DIR = path.resolve(import.meta.dirname, '../../data');
const TL_DIR = path.join(DATA_DIR, 'timelines');
fs.mkdirSync(TL_DIR, { recursive: true });

const timelines = new Map<string, Timeline>();

for (const file of fs.readdirSync(TL_DIR)) {
  if (!file.endsWith('.json') || file.includes('.bak.')) continue;
  const full = path.join(TL_DIR, file);
  try {
    const { timeline, migrated, from } = migrateTimeline(JSON.parse(fs.readFileSync(full, 'utf8')));
    if (migrated) {
      // Keep the original next to the upgraded file in case a migration is ever wrong. Only the newest
      // backup is kept: each is a full copy, and older ones predate migrations that already proved fine.
      const backup = full.replace(/\.json$/, `.v${from}.bak.json`);
      fs.copyFileSync(full, backup);
      for (const old of backupsOf(timeline.id)) if (old !== backup) fs.rmSync(old, { force: true });
      writeJsonAtomic(full, timeline, true);
      console.log(`[store] migrated ${file} from v${from} to v${timeline.schemaVersion}`);
    }
    timelines.set(timeline.id, timeline);
  } catch (err) {
    console.error(`[store] could not read ${file}:`, err);
  }
}

// Tidy backups left by older versions: those whose timeline file is gone (deletes did not remove them),
// and all but the newest per timeline.
for (const id of new Set(fs.readdirSync(TL_DIR).flatMap((f) => f.match(/^(.+)\.v\d+\.bak\.json$/)?.[1] ?? []))) {
  const all = backupsOf(id);
  const orphan = !fs.existsSync(path.join(TL_DIR, `${id}.json`));
  for (const b of orphan ? all : all.slice(0, -1)) {
    fs.rmSync(b, { force: true });
    console.log(`[store] removed ${path.basename(b)}: ${orphan ? 'its timeline no longer exists' : 'a newer backup exists'}`);
  }
}

export const now = () => new Date().toISOString();
export const newId = () => randomUUID().slice(0, 8);

/**
 * Write via temp file + rename so a crash never leaves a half-written timeline. `compact` skips the
 * indentation: timelines are rewritten on every change and can reach megabytes, and nobody edits them by hand.
 */
export function writeJsonAtomic(file: string, data: unknown, compact = false) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, compact ? JSON.stringify(data) : JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Pre-migration backups of one timeline (`<id>.v<N>.bak.json`), oldest version first. */
function backupsOf(id: string): string[] {
  const re = new RegExp(`^${id}\\.v(\\d+)\\.bak\\.json$`);
  return fs
    .readdirSync(TL_DIR)
    .map((f) => ({ f, m: f.match(re) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
    .map((x) => path.join(TL_DIR, x.f));
}

export function listTimelines(): TimelineSummary[] {
  return [...timelines.values()]
    .map((tl) => ({
      id: tl.id,
      title: tl.title,
      nodeCount: Object.keys(tl.nodes).length,
      updatedAt: tl.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getTimeline(id: string): Timeline | undefined {
  return timelines.get(id);
}

export function saveTimeline(tl: Timeline) {
  tl.updatedAt = now();
  timelines.set(tl.id, tl);
  writeJsonAtomic(path.join(TL_DIR, `${tl.id}.json`), tl, true);
}

export function deleteTimeline(id: string) {
  timelines.delete(id);
  fs.rmSync(path.join(TL_DIR, `${id}.json`), { force: true });
  for (const b of backupsOf(id)) fs.rmSync(b, { force: true });
}

export function makeNode(partial: Partial<TLNode> & Pick<TLNode, 'parentId' | 'kind' | 'source'>): TLNode {
  const ts = now();
  return {
    id: newId(),
    status: 'ready',
    stale: false,
    title: '',
    period: '',
    summary: '',
    narrative: '',
    keyChanges: [],
    significance: 'notable',
    tone: 'neutral',
    createdAt: ts,
    updatedAt: ts,
    ...partial,
  };
}

/** Every parent of a node: the primary one first, then convergence parents. */
export function parentIdsOf(n: TLNode): string[] {
  return [...(n.parentId ? [n.parentId] : []), ...(n.mergeParents ?? [])];
}

/** Direct children, including convergence nodes that merge this node in. */
export function childrenOf(tl: Timeline, nodeId: string): TLNode[] {
  return Object.values(tl.nodes)
    .filter((n) => n.parentId === nodeId || n.mergeParents?.includes(nodeId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Everything downstream, through primary and convergence links. Each node once. */
export function descendantsOf(tl: Timeline, nodeId: string, ix = new WorldIndex(tl)): TLNode[] {
  return ix.descendants(nodeId);
}

/** Everything upstream, through primary and convergence links. */
export function ancestorIdsOf(tl: Timeline, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...parentIdsOf(tl.nodes[nodeId])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !tl.nodes[id]) continue;
    seen.add(id);
    stack.push(...parentIdsOf(tl.nodes[id]));
  }
  return seen;
}

/** Root first, ending with nodeId itself. */
export function pathTo(tl: Timeline, nodeId: string): TLNode[] {
  const out: TLNode[] = [];
  let cur: TLNode | undefined = tl.nodes[nodeId];
  while (cur) {
    out.unshift(cur);
    cur = cur.parentId ? tl.nodes[cur.parentId] : undefined;
  }
  return out;
}
