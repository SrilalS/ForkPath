// Where every card goes on the canvas. Pure (dagre and dates only, no React), so it also runs in
// layout.worker.ts for big timelines.
import { Graph, layout } from '@dagrejs/dagre';
import type { NodeStatus } from '../../shared/types.ts';
import { formatYear, parsePeriodStart } from '../../shared/time.ts';

export const NODE_W = 300;
export const NODE_H = 168;

/** 'structure': compact tree by generation. 'time': columns ordered by date, so branches line up. */
export type LayoutMode = 'structure' | 'time';

export interface TimeColumn {
  x: number;
  label: string;
  /** A repeat of the previous column's year (an undated or same-year follow-up). */
  repeat: boolean;
}
export interface TimeAxis {
  columns: TimeColumn[];
  top: number;
  bottom: number;
  /** Nodes with no readable date, placed right after their parent. */
  undated: number;
}

export type Placement = { pos: Map<string, { x: number; y: number }>; axis: TimeAxis | null };

/** Just what placement reads from a node: small enough to post to a worker for thousands of nodes. */
export interface PlaceNode {
  id: string;
  parentId: string | null;
  mergeParents?: string[];
  period: string;
  status: NodeStatus;
}

const NODE_SEP = 36;
const RANK_SEP = 90;
const MARGIN = 40;

type TimeKey = { year: number; sub: number };
const cmpKey = (a: TimeKey, b: TimeKey) => a.year - b.year || a.sub - b.sub;
const parentsOf = (n: PlaceNode) => [...(n.parentId ? [n.parentId] : []), ...(n.mergeParents ?? [])];

/** `all` in creation order (parents first), reduced to what placement reads. */
export const toPlaceNodes = (all: PlaceNode[]): PlaceNode[] =>
  all.map(({ id, parentId, mergeParents, period, status }) => ({ id, parentId, mergeParents, period, status }));

/**
 * Gives every node a time key: its start year, or (when undated or dated before its parent) its parent's
 * year with sub + 1 so it still lands in a later column. Nodes in different branches with the same year
 * share a column. Parents always come before children in `all` (sorted by creation time).
 */
function timeKeys(all: PlaceNode[]) {
  const keys = new Map<string, TimeKey>();
  let undated = 0;
  for (const n of all) {
    const parsed = parsePeriodStart(n.period);
    const year = parsed === null ? null : Math.floor(parsed);
    if (year === null && n.status === 'ready') undated++;
    const parentKeys = parentsOf(n)
      .map((id) => keys.get(id))
      .filter((k): k is TimeKey => !!k);
    if (!parentKeys.length) {
      keys.set(n.id, { year: year ?? -Infinity, sub: 0 });
      continue;
    }
    const latest = parentKeys.sort(cmpKey).at(-1)!;
    keys.set(n.id, year !== null && year > latest.year ? { year, sub: 0 } : { year: latest.year, sub: latest.sub + 1 });
  }
  return { keys, undated };
}

/** Everything positions depend on: ids and parents (plus periods and status in time mode). */
export function placementKey(all: PlaceNode[], mode: LayoutMode): string {
  return (
    mode +
    all.map((n) => `${n.id}<${n.parentId ?? ''}${n.mergeParents?.length ? `+${n.mergeParents.join('+')}` : ''}${mode === 'time' ? `@${n.period}@${n.status}` : ''}`).join('|')
  );
}

/** Dagre's tree, re-columned by date in time mode. `all` in creation order (parents first). */
export function computePlacement(all: PlaceNode[], mode: LayoutMode): Placement {
  const ids = new Set(all.map((n) => n.id));
  const g = new Graph();
  g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of all) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const n of all) {
    if (n.parentId && ids.has(n.parentId)) g.setEdge(n.parentId, n.id);
    // Convergence links count for ranking too, so a merge node sits after both of its branches.
    for (const p of n.mergeParents ?? []) if (ids.has(p)) g.setEdge(p, n.id);
  }
  layout(g);

  // Top-left corner of each card. Structure mode uses dagre as is.
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of all) {
    const p = g.node(n.id) as { x: number; y: number };
    pos.set(n.id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  }

  let axis: TimeAxis | null = null;
  if (mode === 'time' && all.length) {
    // Columns come from dates; dagre's vertical order is kept to limit edge crossings.
    const { keys, undated } = timeKeys(all);
    const distinct = [...new Map([...keys.values()].map((k) => [`${k.year}:${k.sub}`, k])).values()].sort(cmpKey);
    const colOf = new Map(distinct.map((k, i) => [`${k.year}:${k.sub}`, i]));
    const colX = (i: number) => MARGIN + i * (NODE_W + RANK_SEP);

    const byCol = new Map<number, PlaceNode[]>();
    for (const n of all) {
      const k = keys.get(n.id)!;
      const c = colOf.get(`${k.year}:${k.sub}`)!;
      const members = byCol.get(c);
      if (members) members.push(n);
      else byCol.set(c, [n]);
    }
    let top = Infinity;
    let bottom = -Infinity;
    for (const [c, members] of byCol) {
      // Same column, so push overlapping cards down while keeping their order.
      members.sort((a, b) => pos.get(a.id)!.y - pos.get(b.id)!.y);
      let prevBottom = -Infinity;
      for (const n of members) {
        const y = Math.max(pos.get(n.id)!.y, prevBottom + NODE_SEP);
        pos.set(n.id, { x: colX(c), y });
        prevBottom = y + NODE_H;
        top = Math.min(top, y);
        bottom = Math.max(bottom, prevBottom);
      }
    }
    axis = {
      columns: distinct.map((k, i) => ({
        x: colX(i),
        label: Number.isFinite(k.year) ? formatYear(k.year) : 'Start',
        repeat: k.sub > 0,
      })),
      top,
      bottom,
      undated,
    };
  }
  return { pos, axis };
}

/**
 * A stand-in while the worker lays out a big timeline: the previous positions, and each new node just
 * right of its parent (stacked below anything already there). Replaced as soon as the real layout lands.
 */
export function provisionalPlacement(all: PlaceNode[], prev: Placement): Placement {
  const pos = new Map<string, { x: number; y: number }>();
  const taken = new Map<string, number>();
  for (const n of all) {
    const known = prev.pos.get(n.id);
    if (known) {
      pos.set(n.id, known);
      continue;
    }
    const parent = n.parentId ? pos.get(n.parentId) : undefined;
    if (!parent) {
      pos.set(n.id, { x: MARGIN, y: MARGIN });
      continue;
    }
    const slot = taken.get(n.parentId!) ?? 0;
    taken.set(n.parentId!, slot + 1);
    pos.set(n.id, { x: parent.x + NODE_W + RANK_SEP, y: parent.y + slot * (NODE_H + NODE_SEP) });
  }
  return { pos, axis: prev.axis };
}
