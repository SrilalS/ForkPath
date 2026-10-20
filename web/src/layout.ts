import { MarkerType, Position, type Edge, type Node, type NodeHandle } from '@xyflow/react';
import type { Timeline, TLNode } from '../../shared/types.ts';
import { isMajor, TONE_STYLE } from './mood.ts';
import { streamNameOf, threadColors, threadLabel, threadRootOf } from './graph.ts';
import { computePlacement, NODE_H, NODE_W, placementKey, type LayoutMode, type Placement, type TimeAxis } from './placement.ts';

export { NODE_H, NODE_W, type LayoutMode, type TimeAxis } from './placement.ts';

/** Tag color for a renamed stream that is not a thread (threads keep their own color). */
const RENAMED_MAIN_COLOR = '#9aa7c2';

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

/** Nodes in creation order: parents before children, which placement and stream naming rely on. */
export const sortedNodes = (tl: Timeline) => Object.values(tl.nodes).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/**
 * The last layout, keyed by everything positions depend on (see placementKey). An edit to a title, a
 * summary or a stale mark reuses it and skips dagre, which is the slow part (seconds at a few thousand nodes).
 */
let lastPlacement: { key: string; placement: Placement } | null = null;

export const cachedPlacement = (key: string) => (lastPlacement?.key === key ? lastPlacement.placement : null);
export const rememberPlacement = (key: string, placement: Placement) => {
  lastPlacement = { key, placement };
};

/** The layout for `all`, computed here on the main thread unless it is the cached one. */
export function placeNow(all: TLNode[], mode: LayoutMode, key = placementKey(all, mode)): Placement {
  const hit = cachedPlacement(key);
  if (hit) return hit;
  const placement = computePlacement(all, mode);
  rememberPlacement(key, placement);
  return placement;
}

/**
 * Each node's thread (its start and color, if a side thread) and current stream name, worked out once top
 * down in creation order (parents first) instead of walking up from every node.
 */
function streams(tl: Timeline, all: TLNode[]): Map<string, FlowNodeData['thread']> {
  const colors = threadColors(tl);
  const root = new Map<string, string>();
  const name = new Map<string, string | undefined>();
  const out = new Map<string, FlowNodeData['thread']>();
  for (const n of all) {
    const parent = n.parentId && tl.nodes[n.parentId] ? n.parentId : null;
    // A parent created later than its child would be a malformed file: fall back to walking up.
    const known = !parent || root.has(parent);
    const r = n.threadName || !parent ? n.id : known ? root.get(parent)! : threadRootOf(tl, n.id);
    const nm = n.streamName ?? n.threadName ?? (parent ? (known ? name.get(parent) : streamNameOf(tl, parent)) : undefined);
    root.set(n.id, r);
    name.set(n.id, nm);
    const color = colors.get(r);
    // The tag follows renames (streamName) further along the stream; the color stays the thread's.
    if (color) out.set(n.id, { name: nm ?? threadLabel(tl, r), color, isStart: r === n.id });
    else if (nm) out.set(n.id, { name: nm, color: RENAMED_MAIN_COLOR, isStart: false });
  }
  return out;
}

/**
 * The previous call's flow objects, reused when nothing they show changed. With live.ts keeping unchanged
 * TLNode objects, an update that touches one node re-renders one card and its edges, not the whole canvas.
 */
let lastFlow: { timelineId: string; nodes: Map<string, FlowNode>; edges: Map<string, { sig: string; edge: Edge }> } | null = null;

const sameThread = (a: FlowNodeData['thread'], b: FlowNodeData['thread']) =>
  a === b || (!!a && !!b && a.name === b.name && a.color === b.color && a.isStart === b.isStart);

/** Flow nodes and edges for the canvas. `placement` comes from usePlacement (or is computed here). */
export function toFlow(
  tl: Timeline,
  mode: LayoutMode = 'structure',
  placement?: Placement,
): { nodes: FlowNode[]; edges: Edge[]; axis: TimeAxis | null } {
  const all = sortedNodes(tl);
  const { pos, axis } = placement ?? placeNow(all, mode);
  const threads = streams(tl, all);
  const colors = threadColors(tl);
  const prev = lastFlow?.timelineId === tl.id ? lastFlow : null;

  const childCount = new Map<string, number>();
  for (const n of all) if (n.parentId) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);

  const nodes: FlowNode[] = all.map((n) => {
    const position = pos.get(n.id)!;
    const data: FlowNodeData = { node: n, isRoot: n.id === tl.rootId, childCount: childCount.get(n.id) ?? 0, thread: threads.get(n.id) };
    const old = prev?.nodes.get(n.id);
    if (
      old &&
      old.data.node === n &&
      old.position.x === position.x &&
      old.position.y === position.y &&
      old.data.childCount === data.childCount &&
      old.data.isRoot === data.isRoot &&
      sameThread(old.data.thread, data.thread)
    ) {
      return old;
    }
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
      // React Flow copies `measured` from these objects whenever they are replaced (every update), and its
      // DOM measurement does not fire again for a card whose size did not change. Without this, the size is
      // lost after the first update and fitView (which only fits measured nodes) silently does nothing.
      measured: { width: NODE_W, height: NODE_H },
      handles: HANDLES,
      data,
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

  // Edges are small: reuse the old object when its serialized form is unchanged.
  const edgeCache = new Map<string, { sig: string; edge: Edge }>();
  const stableEdges = edges.map((e) => {
    const sig = JSON.stringify(e);
    const old = prev?.edges.get(e.id);
    const edge = old && old.sig === sig ? old.edge : e;
    edgeCache.set(e.id, { sig, edge });
    return edge;
  });
  lastFlow = { timelineId: tl.id, nodes: new Map(nodes.map((n) => [n.id, n])), edges: edgeCache };

  return { nodes, edges: stableEdges, axis };
}
