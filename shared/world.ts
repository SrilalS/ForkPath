// Graph rules shared by server and UI: streams, exclusive alternatives and which influence links are valid.
//
// Every branch is a STREAM of events in one shared world (like Merge treats them): user branches, "Continue
// another way", and threads (threadName) all happen alongside each other. The exception is a set of
// EXCLUSIVE ALTERNATIVES: siblings the model wrote in one branching result (they carry a likelihood). Only
// one of those happens, so nodes under different ones are in different worlds and never influence each other.
// A node's "choices" are the exclusive alternatives picked on every path from the root to it.
import type { Timeline, TLNode } from './types.ts';
import { parsePeriodStart } from './time.ts';

/**
 * How far the worker looks around the node it writes: briefs list other streams' events this close, search
 * shows full summaries this close (older hits show only key changes), and a new node can influence existing
 * events that start at most this many years after it. Older events can still influence it, without limit.
 */
export const INFLUENCE_WINDOW_YEARS = 15;
/** An influence may point at an event that started up to this many years earlier (overlapping periods). */
export const INFLUENCE_OVERLAP_YEARS = 5;

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
 * The current name of the stream at `id`: the nearest rename (streamName) or thread name on the way back
 * along primary parents. Undefined on a stream that was never named (the main line, or a plain branch).
 */
export function streamNameOf(tl: Timeline, id: string): string | undefined {
  let cur: TLNode | undefined = tl.nodes[id];
  while (cur) {
    if (cur.streamName) return cur.streamName;
    if (cur.threadName) return cur.threadName;
    cur = cur.parentId ? tl.nodes[cur.parentId] : undefined;
  }
  return undefined;
}

/**
 * A readable name for the stream `id` is in: the nearest rename or thread name, or the title of the nearest
 * user branch (a deviation below the root), or "Main".
 */
export function streamLabel(tl: Timeline, id: string): string {
  const clip = (s: string) => (s.length > 48 ? `${s.slice(0, 45)}...` : s);
  let cur: TLNode | undefined = tl.nodes[id];
  while (cur) {
    if (cur.streamName) return clip(cur.streamName);
    if (cur.threadName) return clip(cur.threadName);
    if (cur.kind === 'deviation' && cur.parentId) return clip(cur.title);
    cur = cur.parentId ? tl.nodes[cur.parentId] : undefined;
  }
  return 'Main';
}

/** Start year of a node's period, or null when it has no readable date. */
export function startYear(n: TLNode): number | null {
  const y = parsePeriodStart(n.period);
  return y === null ? null : Math.floor(y);
}

/**
 * The node's start year, or for an undated node (a deviation typed without a date, say) the start year of
 * the nearest dated node before it on its path: it happens no earlier than that. Null only when nothing
 * on the path is dated.
 */
export function effectiveYear(tl: Timeline, id: string): number | null {
  let cur: TLNode | undefined = tl.nodes[id];
  while (cur) {
    const y = startYear(cur);
    if (y !== null) return y;
    cur = cur.parentId ? tl.nodes[cur.parentId] : undefined;
  }
  return null;
}

export type LinkCheck = { ok: true } | { ok: false; reason: string };

/**
 * Lookup tables for one snapshot of a timeline, built in O(n). Queries that loop over every node (link
 * targets, the brief's nearby events, stale propagation) take one index instead of rescanning all nodes
 * per call, which made them cubic. Build a new index after changing the graph; it does not track edits.
 */
export class WorldIndex {
  private readonly kids = new Map<string, TLNode[]>();
  /** Exclusive alternatives (model-written siblings with a likelihood) per parent. */
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
      if (this.isAlternative(n)) this.altCount.set(n.parentId!, (this.altCount.get(n.parentId!) ?? 0) + 1);
    }
  }

  private isAlternative(n: TLNode): boolean {
    return !!n.parentId && !n.threadName && n.likelihood !== undefined;
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

  /**
   * True when `id` is the latest event of its stream: nothing continues it yet (thread starts and
   * convergences that merge it in do not count). A new event after a tip extends that stream instead of
   * becoming an alternative to what is already there.
   */
  isTip(id: string): boolean {
    return !this.children(id).some((c) => c.parentId === id && !c.threadName);
  }

  /** True when `n` is one of several exclusive alternatives at its fork. */
  private isChoice(n: TLNode): boolean {
    return this.isAlternative(n) && (this.altCount.get(n.parentId!) ?? 0) > 1;
  }

  /** Every exclusive alternative picked on the way to `id` (through primary and convergence parents). */
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

  /** The pair of exclusive alternatives that keeps `a` and `b` apart, if any. */
  private conflict(a: string, b: string): [TLNode, TLNode] | null {
    const ca = this.choices(a);
    const cb = this.choices(b);
    for (const x of ca) {
      const px = this.tl.nodes[x]?.parentId;
      for (const y of cb) if (x !== y && px && px === this.tl.nodes[y]?.parentId) return [this.tl.nodes[x], this.tl.nodes[y]];
    }
    return null;
  }

  /** Whether `a` and `b` can both happen (they are not under different exclusive alternatives). */
  sameWorld(a: string, b: string): boolean {
    return !this.conflict(a, b);
  }

  private worldClash(a: string, b: string): LinkCheck | null {
    const clash = this.conflict(a, b);
    return clash ? { ok: false, reason: `they are in different worlds ("${clash[0].title}" vs "${clash[1].title}")` } : null;
  }

  /**
   * Whether "`from` influences `to`" is a valid link between two existing events: on separate streams, in
   * one world, and `from` not starting well after `to`. Any age gap is fine (old events can matter); the
   * worker's forward reach is capped separately where its links are applied.
   */
  canLink(from: string, to: string): LinkCheck {
    const tl = this.tl;
    const f = tl.nodes[from];
    const t = tl.nodes[to];
    if (!f || !t) return { ok: false, reason: 'node not found' };
    if (from === to) return { ok: false, reason: 'a node cannot influence itself' };
    if (ancestorIds(tl, to).has(from)) return { ok: false, reason: `"${t.title}" already follows from "${f.title}"` };
    if (ancestorIds(tl, from).has(to)) return { ok: false, reason: `"${t.title}" comes before "${f.title}" on the same path` };
    const clash = this.worldClash(from, to);
    if (clash) return clash;
    const fy = startYear(f);
    const ty = startYear(t);
    if (fy !== null && ty !== null && fy - ty > INFLUENCE_OVERLAP_YEARS) {
      return { ok: false, reason: `"${f.title}" starts ${fy - ty} years after "${t.title}", so it cannot shape it` };
    }
    return { ok: true };
  }

  /**
   * Whether the user can make `from` influence a NEW event written after `target` (the influence flow).
   * No time window here (the user decides); the new event's dates are checked when the result comes back.
   * `target` may be an ancestor of `from` (a thread influencing the stream it branched off), but not an
   * earlier node in `from`'s own stream.
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
    // A new non-thread child of `target` would continue the stream `from` is in: that is just Continue.
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
    return this.worldClash(from, target) ?? { ok: true };
  }
}

/** Whether `a` and `b` can both happen. Pass an index when calling this in a loop. */
export function sameWorld(tl: Timeline, a: string, b: string, ix = new WorldIndex(tl)): boolean {
  return ix.sameWorld(a, b);
}

/** Whether "`from` influences `to`" is a valid link (see WorldIndex.canLink). Pass an index in loops. */
export function canLink(tl: Timeline, from: string, to: string, ix = new WorldIndex(tl)): LinkCheck {
  return ix.canLink(from, to);
}
