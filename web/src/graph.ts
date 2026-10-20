import type { Timeline } from '../../shared/types.ts';
import { ancestorIds, canLink, childrenOf, parentIds, streamLabel, streamNameOf, threadLabel, threadRootOf, WorldIndex } from '../../shared/world.ts';

export { ancestorIds, canLink, childrenOf, streamLabel, streamNameOf, threadLabel, threadRootOf };
export const parentIdsOf = parentIds;

export function descendantIds(tl: Timeline, id: string, ix = new WorldIndex(tl)): Set<string> {
  return new Set(ix.descendants(id).map((n) => n.id));
}

/**
 * Nodes that can still join a convergence of `sourceId` and the already `selected` nodes: ready, and on a
 * separate branch from every one of them (not up or down any of their paths). Selected nodes stay
 * clickable so they can be deselected.
 */
export function mergeTargets(tl: Timeline, sourceId: string, selected: string[] = [], ix = new WorldIndex(tl)): Set<string> {
  const blocked = new Set<string>();
  for (const id of [sourceId, ...selected]) {
    blocked.add(id);
    for (const a of ancestorIds(tl, id)) blocked.add(a);
    for (const d of ix.descendants(id)) blocked.add(d.id);
  }
  const out = new Set(Object.values(tl.nodes).filter((n) => n.status === 'ready' && !blocked.has(n.id)).map((n) => n.id));
  for (const id of selected) out.add(id);
  return out;
}

/** Nodes after which `sourceId` can influence a new event (see WorldIndex.canInfluence). */
export function influenceTargets(tl: Timeline, sourceId: string, ix = new WorldIndex(tl)): Set<string> {
  return new Set(
    Object.values(tl.nodes)
      .filter((n) => ix.canInfluence(sourceId, n.id).ok)
      .map((n) => n.id),
  );
}

/** Whether `sourceId` can influence any node at all (stops at the first one; for enabling the button). */
export function hasInfluenceTarget(tl: Timeline, sourceId: string, ix = new WorldIndex(tl)): boolean {
  return Object.values(tl.nodes).some((n) => ix.canInfluence(sourceId, n.id).ok);
}

/** Why `sourceId` cannot influence a new event after `target`, or null when it can. */
export function influenceBlocker(tl: Timeline, sourceId: string, target: string): string | null {
  const check = new WorldIndex(tl).canInfluence(sourceId, target);
  return check.ok ? null : check.reason;
}

/** Nodes outside the most likely history (see WorldIndex.inMostLikely). */
export function unlikelyIds(tl: Timeline, ix = new WorldIndex(tl)): Set<string> {
  return new Set(Object.keys(tl.nodes).filter((id) => !ix.inMostLikely(id)));
}

/** How likely history reaches `id` (see WorldIndex.pathOdds), over how many forks, and whether it is the most likely history. */
export function pathInfo(tl: Timeline, id: string, ix = new WorldIndex(tl)) {
  return { odds: ix.pathOdds(id), forks: ix.choices(id).size, likely: ix.inMostLikely(id) };
}

/** 0..1 as a percentage that still reads for small odds: "62%", "4.5%", "<0.1%". */
export function formatOdds(p: number): string {
  const pct = p * 100;
  if (pct < 0.1) return '<0.1%';
  return pct < 10 ? `${pct.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(pct)}%`;
}

const THREAD_COLORS = ['#4fd1c5', '#f687b3', '#9ae6b4', '#fbd38d', '#90cdf4', '#d6bcfa'];

/** A stable color per side thread (by creation order); the main thread has none. */
export function threadColors(tl: Timeline): Map<string, string> {
  const starts = Object.values(tl.nodes)
    .filter((n) => n.threadName)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return new Map(starts.map((n, i) => [n.id, THREAD_COLORS[i % THREAD_COLORS.length]]));
}
