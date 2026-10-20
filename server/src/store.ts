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
      // Keep the original next to the upgraded file in case a migration is ever wrong.
      fs.copyFileSync(full, full.replace(/\.json$/, `.v${from}.bak.json`));
      writeJsonAtomic(full, timeline);
      console.log(`[store] migrated ${file} from v${from} to v${timeline.schemaVersion}`);
    }
    timelines.set(timeline.id, timeline);
  } catch (err) {
    console.error(`[store] could not read ${file}:`, err);
  }
}

export const now = () => new Date().toISOString();
export const newId = () => randomUUID().slice(0, 8);

/** Write via temp file + rename so a crash never leaves a half-written timeline. */
export function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
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
  writeJsonAtomic(path.join(TL_DIR, `${tl.id}.json`), tl);
}

export function deleteTimeline(id: string) {
  timelines.delete(id);
  fs.rmSync(path.join(TL_DIR, `${id}.json`), { force: true });
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
