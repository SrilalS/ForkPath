// Graph rules shared by server and UI: threads, alternative worlds and which influence links are valid.
//
// Two kinds of children:
//   - alternatives: siblings without threadName. Only one of them happens (a "choice").
//   - threads: a child with threadName happens ALONGSIDE its siblings, as a separate stream of events.
// A node's "choices" are the alternatives picked on every path from the root to it. Two nodes can coexist
// in one world unless their choices pick different alternatives at the same fork.
import type { Timeline, TLNode } from './types.ts';

export const parentIds = (n: TLNode) => [...(n.parentId ? [n.parentId] : []), ...(n.mergeParents ?? [])];

export function childrenOf(tl: Timeline, id: string): TLNode[] {
  return Object.values(tl.nodes)
    .filter((n) => n.parentId === id || n.mergeParents?.includes(id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function ancestorIds(tl: Timeline, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = tl.nodes[id] ? parentIds(tl.nodes[id]) : [];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur) || !tl.nodes[cur]) continue;
    seen.add(cur);
    stack.push(...parentIds(tl.nodes[cur]));
  }
  return seen;
}

/** The node that starts the thread `id` belongs to (a node with threadName, or the root for the main thread). */
export function threadRootOf(tl: Timeline, id: string): string {
  let cur = tl.nodes[id];
  while (cur && !cur.threadName && cur.parentId && tl.nodes[cur.parentId]) cur = tl.nodes[cur.parentId];
  return cur?.id ?? id;
}

export function threadLabel(tl: Timeline, threadRootId: string): string {
  return tl.nodes[threadRootId]?.threadName ?? 'Main';
}

/**
 * Lookup tables for one snapshot of a timeline, built in O(n). Queries that loop over every node (link
 * targets, the brief's thread context, stale propagation) take one index instead of rescanning all nodes
 * per call, which made them cubic. Build a new index after changing the graph; it does not track edits.
 */
export class WorldIndex {
  private readonly kids = new Map<string, TLNode[]>();
  /** Alternatives (non-thread children) per parent. */
  private readonly altCount = new Map<string, number>();
  private readonly choiceMemo = new Map<string, Set<string>>();

  readonly tl: Timeline;

  constructor(tl: Timeline) {
    this.tl = tl;
    const sorted = Object.values(tl.nodes).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const n of sorted) {
      for (const p of parentIds(n)) {
        const list = this.kids.get(p);
        if (list) list.push(n);
        else this.kids.set(p, [n]);
      }
      if (n.parentId && !n.threadName) this.altCount.set(n.parentId, (this.altCount.get(n.parentId) ?? 0) + 1);
    }
  }

  /** Direct children (primary and convergence), oldest first. */
  children(id: string): TLNode[] {
    return this.kids.get(id) ?? [];
  }

  /** Everything downstream, each node once. */
  descendants(id: string): TLNode[] {
    const seen = new Set<string>();
    const out: TLNode[] = [];
    const stack = [id];
    while (stack.length) {
      for (const c of this.children(stack.pop()!)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
        stack.push(c.id);
      }
    }
    return out;
  }

  /** True when `n` is one of several alternatives at its fork. */
  private isChoice(n: TLNode): boolean {
    return !!n.parentId && !n.threadName && (this.altCount.get(n.parentId) ?? 0) > 1;
  }

  /** Every alternative picked on the way to `id` (through primary and convergence parents). */
  choices(id: string): Set<string> {
    const hit = this.choiceMemo.get(id);
    if (hit) return hit;
    const n = this.tl.nodes[id];
    const out = new Set<string>();
    this.choiceMemo.set(id, out); // guards against malformed cycles
    if (!n) return out;
    for (const p of parentIds(n)) for (const c of this.choices(p)) out.add(c);
    if (this.isChoice(n)) out.add(n.id);
    return out;
  }

  sameWorld(a: string, b: string): boolean {
    return !conflict(this.tl, this.choices(a), this.choices(b));
  }

  canLink(from: string, to: string): LinkCheck {
    return checkLink(this, from, to);
  }

  /**
   * Whether the user can make `from` influence a NEW event written after `target` (the influence flow).
   * Like Merge, this treats separate branches as streams of one world, so the world rules of canLink do
   * not apply; the dates are checked when the result comes back. `target` may be an ancestor of `from`
   * (a thread influencing the stream it branched off), but not an earlier node in `from`'s own stream.
   */
  canInfluence(from: string, target: string): LinkCheck {
    const tl = this.tl;
    const f = tl.nodes[from];
    const t = tl.nodes[target];
    if (!f || !t) return { ok: false, reason: 'node not found' };
    if (from === target) return { ok: false, reason: 'pick a node in another stream' };
    if (t.status !== 'ready') return { ok: false, reason: `"${t.title}" is not ready yet` };
    const up = ancestorIds(tl, from);
    if (ancestorIds(tl, target).has(from)) return { ok: false, reason: `"${t.title}" already follows from "${f.title}"` };
    // A new non-thread child of `target` is an alternative to its existing ones: invalid if `from` lies under one.
    const rival = this.children(target).find((c) => !c.threadName && c.parentId === target && (c.id === from || up.has(c.id)));
    if (rival) {
      return {
        ok: false,
        reason:
          rival.id === from
            ? `"${t.title}" is the event right before it in the same stream; use Continue instead`
            : `"${t.title}" is earlier in the same stream (a new event there would be an alternative to "${rival.title}")`,
      };
    }
    return { ok: true };
  }
}

/** Every alternative picked on the way to `id` (through primary and convergence parents). */
export function choicesOf(tl: Timeline, id: string): Set<string> {
  return new WorldIndex(tl).choices(id);
}

/** The pair of alternatives that keeps `a` and `b` apart, if any. */
function conflict(tl: Timeline, a: Set<string>, b: Set<string>): [string, string] | null {
  for (const x of a) {
    const px = tl.nodes[x]?.parentId;
    for (const y of b) if (x !== y && px && px === tl.nodes[y]?.parentId) return [x, y];
  }
  return null;
}

/** Whether `a` and `b` can both happen in one world. Pass an index when calling this in a loop. */
export function sameWorld(tl: Timeline, a: string, b: string, ix = new WorldIndex(tl)): boolean {
  return ix.sameWorld(a, b);
}

export type LinkCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether "`from` influences `to`" is a valid link. Every world containing `to` must also contain `from`;
 * otherwise `to` would carry an influence that does not exist in some of its worlds.
 * Pass an index when calling this in a loop.
 */
export function canLink(tl: Timeline, from: string, to: string, ix = new WorldIndex(tl)): LinkCheck {
  return checkLink(ix, from, to);
}

function checkLink(ix: WorldIndex, from: string, to: string): LinkCheck {
  const tl = ix.tl;
  const f = tl.nodes[from];
  const t = tl.nodes[to];
  if (!f || !t) return { ok: false, reason: 'node not found' };
  if (from === to) return { ok: false, reason: 'a node cannot influence itself' };
  if (ancestorIds(tl, to).has(from)) return { ok: false, reason: `"${t.title}" already follows from "${f.title}"` };
  if (ancestorIds(tl, from).has(to)) return { ok: false, reason: `"${t.title}" comes before "${f.title}" on the same path` };
  const cf = ix.choices(from);
  const ct = ix.choices(to);
  const clash = conflict(tl, cf, ct);
  if (clash) {
    return { ok: false, reason: `they are in different worlds ("${tl.nodes[clash[0]].title}" vs "${tl.nodes[clash[1]].title}")` };
  }
  const missing = [...cf].find((c) => !ct.has(c));
  if (missing) {
    return {
      ok: false,
      reason: `"${t.title}" is shared by worlds where "${tl.nodes[missing].title}" does not happen; link from an earlier node or start a world-specific thread instead`,
    };
  }
  return { ok: true };
}
