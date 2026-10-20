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

/** True when `n` is one of several alternatives at its fork. */
function isChoice(tl: Timeline, n: TLNode): boolean {
  if (!n.parentId || n.threadName) return false;
  return Object.values(tl.nodes).some((s) => s.id !== n.id && s.parentId === n.parentId && !s.threadName);
}

/** Every alternative picked on the way to `id` (through primary and convergence parents). */
export function choicesOf(tl: Timeline, id: string, memo = new Map<string, Set<string>>()): Set<string> {
  const hit = memo.get(id);
  if (hit) return hit;
  const n = tl.nodes[id];
  const out = new Set<string>();
  memo.set(id, out); // guards against malformed cycles
  if (!n) return out;
  for (const p of parentIds(n)) for (const c of choicesOf(tl, p, memo)) out.add(c);
  if (isChoice(tl, n)) out.add(n.id);
  return out;
}

/** The pair of alternatives that keeps `a` and `b` apart, if any. */
function conflict(tl: Timeline, a: Set<string>, b: Set<string>): [string, string] | null {
  for (const x of a) {
    const px = tl.nodes[x]?.parentId;
    for (const y of b) if (x !== y && px && px === tl.nodes[y]?.parentId) return [x, y];
  }
  return null;
}

/** Whether `a` and `b` can both happen in one world. */
export function sameWorld(tl: Timeline, a: string, b: string): boolean {
  return !conflict(tl, choicesOf(tl, a), choicesOf(tl, b));
}

/**
 * Whether "`from` influences `to`" is a valid link. Every world containing `to` must also contain `from`;
 * otherwise `to` would carry an influence that does not exist in some of its worlds.
 */
export function canLink(tl: Timeline, from: string, to: string): { ok: true } | { ok: false; reason: string } {
  const f = tl.nodes[from];
  const t = tl.nodes[to];
  if (!f || !t) return { ok: false, reason: 'node not found' };
  if (from === to) return { ok: false, reason: 'a node cannot influence itself' };
  if (ancestorIds(tl, to).has(from)) return { ok: false, reason: `"${t.title}" already follows from "${f.title}"` };
  if (ancestorIds(tl, from).has(to)) return { ok: false, reason: `"${t.title}" comes before "${f.title}" on the same path` };
  const cf = choicesOf(tl, from);
  const ct = choicesOf(tl, to);
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
