import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type Edge, type EdgeProps, type InternalNode } from '@xyflow/react';
import type { Strength } from '../../../shared/types.ts';
import { NODE_H, NODE_W } from '../layout.ts';

export type InfluenceEdgeData = { strength: Strength; note: string };
export type InfluenceFlowEdge = Edge<InfluenceEdgeData, 'influence'>;

/** Cards whose centers are closer than this many card-lengths count as neighbors. */
const NEAR = 1.6;
/** How far a neighbor loop reaches out past the card edges. */
const LOOP = 70;

type Pt = { x: number; y: number };

function box(n: InternalNode) {
  const w = n.measured?.width ?? NODE_W;
  const h = n.measured?.height ?? NODE_H;
  const { x, y } = n.internals.positionAbsolute;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

/** Where the line from this card's center toward `toward` crosses the card's border. */
function borderPoint(b: ReturnType<typeof box>, toward: Pt): Pt {
  const dx = toward.x - b.cx;
  const dy = toward.y - b.cy;
  if (!dx && !dy) return { x: b.cx, y: b.cy };
  const sx = dx ? b.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? b.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: b.cx + dx * s, y: b.cy + dy * s };
}

/**
 * Influence links are context, not parentage, so they "float": they leave and enter each card at the
 * border facing the curve instead of using the left/right handles. The curve always bows to the left of
 * its direction, so a pair of opposite links (A to B and B to A) loops around opposite sides.
 */
function InfluenceEdgeView({ id, source, target, data, markerEnd, style }: EdgeProps<InfluenceFlowEdge>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const sb = box(s);
  const tb = box(t);

  const dx = tb.cx - sb.cx;
  const dy = tb.cy - sb.cy;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular, pointing to the left of the source-to-target direction.
  const nx = -dy / len;
  const ny = dx / len;
  // Half the card's size measured along the perpendicular.
  const half = Math.abs(nx) * (sb.w / 2) + Math.abs(ny) * (sb.h / 2);

  let path: string;
  let mid: Pt;
  if (len < NEAR * Math.max(sb.w, sb.h)) {
    // Neighbors (stacked, or side by side): a "C" loop off the side of both cards, so the curve and its
    // label sit in open space instead of the narrow gap between them.
    const start = borderPoint(sb, { x: sb.cx + nx * (half + 1), y: sb.cy + ny * (half + 1) });
    const end = borderPoint(tb, { x: tb.cx + nx * (half + 1), y: tb.cy + ny * (half + 1) });
    const c1 = { x: start.x + nx * LOOP, y: start.y + ny * LOOP };
    const c2 = { x: end.x + nx * LOOP, y: end.y + ny * LOOP };
    path = `M ${start.x},${start.y} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`;
    // Cubic midpoint: (start + end) / 8 + 3 (c1 + c2) / 8.
    mid = { x: (start.x + end.x) / 8 + (3 * (c1.x + c2.x)) / 8, y: (start.y + end.y) / 8 + (3 * (c1.y + c2.y)) / 8 };
  } else {
    // Far apart: a gentle bow between the facing borders.
    const bow = Math.min(len * 0.12, half * 0.6);
    mid = { x: (sb.cx + tb.cx) / 2 + nx * bow, y: (sb.cy + tb.cy) / 2 + ny * bow };
    const start = borderPoint(sb, mid);
    const end = borderPoint(tb, mid);
    const control = { x: 2 * mid.x - (start.x + end.x) / 2, y: 2 * mid.y - (start.y + end.y) / 2 };
    // Quadratic curve through `mid` at t = 0.5.
    path = `M ${start.x},${start.y} Q ${control.x},${control.y} ${end.x},${end.y}`;
  }

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {data && (
        <EdgeLabelRenderer>
          <div
            className={`influence-label influence-label--${data.strength} nodrag nopan`}
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
            title={data.note || undefined}
          >
            {data.strength}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const InfluenceEdge = memo(InfluenceEdgeView);
