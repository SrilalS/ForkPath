import type { Timeline, TLNode } from '../../shared/types.ts';

/** Primary parent first, then convergence parents. */
export const parentIdsOf = (n: TLNode) => [...(n.parentId ? [n.parentId] : []), ...(n.mergeParents ?? [])];

export const childrenOf = (tl: Timeline, id: string) =>
  Object.values(tl.nodes)
    .filter((n) => n.parentId === id || n.mergeParents?.includes(id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export function descendantIds(tl: Timeline, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    for (const c of childrenOf(tl, stack.pop()!)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      stack.push(c.id);
    }
  }
  return seen;
}

export function ancestorIds(tl: Timeline, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = tl.nodes[id] ? parentIdsOf(tl.nodes[id]) : [];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur) || !tl.nodes[cur]) continue;
    seen.add(cur);
    stack.push(...parentIdsOf(tl.nodes[cur]));
  }
  return seen;
}

/** Nodes that can converge with `sourceId`: ready, and on a separate branch (not up or down its path). */
export function mergeTargets(tl: Timeline, sourceId: string): Set<string> {
  const blocked = new Set([sourceId, ...ancestorIds(tl, sourceId), ...descendantIds(tl, sourceId)]);
  return new Set(Object.values(tl.nodes).filter((n) => n.status === 'ready' && !blocked.has(n.id)).map((n) => n.id));
}
