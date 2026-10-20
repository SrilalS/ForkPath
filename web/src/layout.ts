import { Graph, layout } from '@dagrejs/dagre';
import { MarkerType, Position, type Edge, type Node, type NodeHandle } from '@xyflow/react';
import type { Timeline, TLNode } from '../../shared/types.ts';
import { isMajor, TONE_STYLE } from './mood.ts';
import { parentIdsOf, threadColors, threadLabel, threadRootOf } from './graph.ts';
import { formatYear, parsePeriodStart } from '../../shared/time.ts';

export const NODE_W = 300;
export const NODE_H = 168;

const HANDLE = 8;
/** Matches the rendered <Handle>s: centered on the left and right borders (React Flow's default placement). */
const HANDLES: NodeHandle[] = [
  { type: 'target', position: Position.Left, x: -HANDLE / 2, y: NODE_H / 2 - HANDLE / 2, width: HANDLE, height: HANDLE },
  { type: 'source', position: Position.Right, x: NODE_W - HANDLE / 2, y: NODE_H / 2 - HANDLE / 2, width: HANDLE, height: HANDLE },
];

export type FlowNodeData = {
  node: TLNode;
  isRoot: boolean;
  childCount: number;
  /** Side thread this node belongs to (undefined on the main thread). */
  thread?: { name: string; color: string; isStart: boolean };
};
export type FlowNode = Node<FlowNodeData, 'timeline'>;

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

const NODE_SEP = 36;
const RANK_SEP = 90;
const MARGIN = 40;

type TimeKey = { year: number; sub: number };
const cmpKey = (a: TimeKey, b: TimeKey) => a.year - b.year || a.sub - b.sub;

/**
 * Gives every node a time key: its start year, or (when undated or dated before its parent) its parent's
 * year with sub + 1 so it still lands in a later column. Nodes in different branches with the same year
 * share a column. Parents always come before children in `all` (sorted by creation time).
 */
function timeKeys(tl: Timeline, all: TLNode[]) {
  const keys = new Map<string, TimeKey>();
  let undated = 0;
  for (const n of all) {
    const parsed = parsePeriodStart(n.period);
    const year = parsed === null ? null : Math.floor(parsed);
    if (year === null && n.status === 'ready') undated++;
    const parentKeys = parentIdsOf(n)
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

export function toFlow(tl: Timeline, mode: LayoutMode = 'structure'): { nodes: FlowNode[]; edges: Edge[]; axis: TimeAxis | null } {
  const all = Object.values(tl.nodes).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const g = new Graph();
  g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of all) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const n of all) {
    if (n.parentId && tl.nodes[n.parentId]) g.setEdge(n.parentId, n.id);
    // Convergence links count for ranking too, so a merge node sits after both of its branches.
    for (const p of n.mergeParents ?? []) if (tl.nodes[p]) g.setEdge(p, n.id);
  }
  layout(g);

  const colors = threadColors(tl);
  const threadOf = (n: TLNode): FlowNodeData['thread'] => {
    const root = threadRootOf(tl, n.id);
    const color = colors.get(root);
    return color ? { name: threadLabel(tl, root), color, isStart: root === n.id } : undefined;
  };

  const childCount = new Map<string, number>();
  for (const n of all) if (n.parentId) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);

  // Top-left corner of each card. Structure mode uses dagre as is.
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of all) {
    const p = g.node(n.id) as { x: number; y: number };
    pos.set(n.id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  }

  let axis: TimeAxis | null = null;
  if (mode === 'time' && all.length) {
    // Columns come from dates; dagre's vertical order is kept to limit edge crossings.
    const { keys, undated } = timeKeys(tl, all);
    const distinct = [...new Map([...keys.values()].map((k) => [`${k.year}:${k.sub}`, k])).values()].sort(cmpKey);
    const colOf = new Map(distinct.map((k, i) => [`${k.year}:${k.sub}`, i]));
    const colX = (i: number) => MARGIN + i * (NODE_W + RANK_SEP);

    const byCol = new Map<number, TLNode[]>();
    for (const n of all) {
      const k = keys.get(n.id)!;
      const c = colOf.get(`${k.year}:${k.sub}`)!;
      byCol.set(c, [...(byCol.get(c) ?? []), n]);
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

  const nodes: FlowNode[] = all.map((n) => {
    return {
      id: n.id,
      type: 'timeline',
      position: pos.get(n.id)!,
      // Every card is a fixed NODE_W x NODE_H, so declare the size and the handle positions up front.
      // Without `handles`, React Flow measures handle positions from the DOM and caches them per node; node
      // objects are rebuilt on every update and under some timings that cache ends up empty while the node
      // counts as measured, so edges vanish until a reload. With `handles`, edges are computed from data.
      initialWidth: NODE_W,
      initialHeight: NODE_H,
      handles: HANDLES,
      data: { node: n, isRoot: n.id === tl.rootId, childCount: childCount.get(n.id) ?? 0, thread: threadOf(n) },
      draggable: false,
    };
  });

  const edges: Edge[] = all
    .filter((n) => n.parentId && tl.nodes[n.parentId])
    .map((n) => {
      const cls = [
        'tl-edge',
        n.kind === 'deviation' ? 'tl-edge--deviation' : '',
        n.status === 'generating' ? 'tl-edge--pending' : '',
        n.stale ? 'tl-edge--stale' : '',
      ];
      const major = isMajor(n) && n.status === 'ready';
      if (major) cls.push('tl-edge--major');
      if (n.threadName) cls.push('tl-edge--thread');
      const edgeColor = n.threadName ? colors.get(n.id) : major ? TONE_STYLE[n.tone].color : undefined;
      return {
        id: `${n.parentId}-${n.id}`,
        style: edgeColor ? ({ '--edge-color': edgeColor } as React.CSSProperties) : undefined,
        source: n.parentId!,
        target: n.id,
        type: 'default',
        animated: n.status === 'generating',
        className: cls.filter(Boolean).join(' '),
        label: n.likelihood !== undefined ? `${Math.round(n.likelihood * 100)}%` : undefined,
        labelClassName: 'tl-edge-label',
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 999,
        labelBgClassName: 'tl-edge-label-bg',
      };
    });

  for (const n of all) {
    for (const p of n.mergeParents ?? []) {
      if (!tl.nodes[p]) continue;
      edges.push({
        id: `merge-${p}-${n.id}`,
        source: p,
        target: n.id,
        type: 'default',
        animated: n.status === 'generating',
        className: ['tl-edge', 'tl-edge--merge', n.stale ? 'tl-edge--stale' : ''].filter(Boolean).join(' '),
      });
    }
  }

  // Influence links: drawn, but never used for layout (they are context, not parentage).
  for (const l of tl.links ?? []) {
    if (!tl.nodes[l.from] || !tl.nodes[l.to]) continue;
    edges.push({
      id: `link-${l.id}`,
      source: l.from,
      target: l.to,
      type: 'influence', // floating edge, see components/InfluenceEdge.tsx
      data: { strength: l.strength, note: l.note },
      className: `tl-edge tl-edge--influence tl-edge--${l.strength}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--influence)' },
      zIndex: 1,
    });
  }

  return { nodes, edges, axis };
}
