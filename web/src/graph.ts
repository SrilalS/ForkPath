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
export function mergeTargets(tl: Timeline, sourceId: string, selected: string[] = []): Set<string> {
  const ix = new WorldIndex(tl);
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

/** Why `sourceId` cannot influence a new event after `target`, or null when it can. */
export function influenceBlocker(tl: Timeline, sourceId: string, target: string): string | null {
  const check = new WorldIndex(tl).canInfluence(sourceId, target);
  return check.ok ? null : check.reason;
}

const THREAD_COLORS = ['#4fd1c5', '#f687b3', '#9ae6b4', '#fbd38d', '#90cdf4', '#d6bcfa'];

/** A stable color per side thread (by creation order); the main thread has none. */
export function threadColors(tl: Timeline): Map<string, string> {
  const starts = Object.values(tl.nodes)
    .filter((n) => n.threadName)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return new Map(starts.map((n, i) => [n.id, THREAD_COLORS[i % THREAD_COLORS.length]]));
}
