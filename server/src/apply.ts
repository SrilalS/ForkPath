// Applies worker results and link edits to a timeline. Pure functions over the Timeline object (no I/O),
// so they can be tested without the HTTP layer.
import type { InfluenceLink, Job, Strength, Timeline, TLNode } from '../../shared/types.ts';
import { canLink } from '../../shared/world.ts';
import { descendantsOf, makeNode, newId, now } from './store.ts';
import type { continueResult, LinkRef, regenerateResult, threadStart } from './schema.ts';
import type { z } from 'zod';

type ContinueResult = z.infer<typeof continueResult>;
type RegenerateResult = z.infer<typeof regenerateResult>;
type ThreadStart = z.infer<typeof threadStart>;

export interface ApplyReport {
  created: { id: string; title: string; thread?: string }[];
  links: number;
  /** Links the model asked for that were invalid, with the reason; the rest of the result still applies. */
  dropped: string[];
}

/** Adds a link if the world rules allow it. Returns the reason when they do not. */
export function addLink(
  tl: Timeline,
  from: string,
  to: string,
  strength: Strength,
  note: string,
  source: InfluenceLink['source'],
): { link: InfluenceLink } | { error: string } {
  const check = canLink(tl, from, to);
  if (!check.ok) return { error: check.reason };
  const existing = tl.links.find((l) => l.from === from && l.to === to);
  if (existing) {
    Object.assign(existing, { strength, note, source });
    return { link: existing };
  }
  const link: InfluenceLink = { id: newId(), from, to, strength, note, source, createdAt: now() };
  tl.links.push(link);
  return { link };
}

function applyLinkRefs(
  tl: Timeline,
  nodeId: string,
  refs: { influences?: LinkRef[]; influencedBy?: LinkRef[] },
  report: ApplyReport,
  keys: Map<string, string> = new Map(),
) {
  const one = (other: string, ref: LinkRef, dir: 'out' | 'in') => {
    // "@key" points at another node written in the same result.
    const id = ref.node.startsWith('@') ? keys.get(ref.node.slice(1)) : ref.node;
    if (!id || !tl.nodes[id]) {
      report.dropped.push(`${ref.node}: ${ref.node.startsWith('@') ? 'no node with that key in this result' : 'no node with that id'}`);
      return;
    }
    const [from, to] = dir === 'out' ? [other, id] : [id, other];
    const r = addLink(tl, from, to, ref.strength, ref.note, 'llm');
    if ('error' in r) report.dropped.push(`${tl.nodes[from].title} -> ${tl.nodes[to].title}: ${r.error}`);
    else report.links++;
  };
  for (const ref of refs.influences ?? []) one(nodeId, ref, 'out');
  for (const ref of refs.influencedBy ?? []) one(nodeId, ref, 'in');
}

function fill(node: TLNode, c: Omit<ThreadStart, 'thread' | 'influences' | 'influencedBy' | 'key'>, ts: string) {
  Object.assign(node, {
    title: c.title,
    period: c.period,
    summary: c.summary,
    narrative: c.narrative,
    keyChanges: c.keyChanges,
    significance: c.significance,
    tone: c.tone,
    status: 'ready',
    stale: false,
    jobId: undefined,
    error: undefined,
    updatedAt: ts,
  } satisfies Partial<TLNode>);
}

/**
 * CONTINUE and MERGE results: alternatives under the target (each optionally spawning threads), and/or
 * parallel threads that start from the target itself.
 */
export function applyContinue(tl: Timeline, job: Job, result: ContinueResult): ApplyReport {
  const ts = now();
  let placeholder: TLNode | undefined = tl.nodes[job.placeholderId!];
  const mergeParents = job.type === 'merge' ? (job.mergeWith ?? []).filter((id) => tl.nodes[id]) : undefined;
  const branching = result.children.length > 1;
  const total = result.children.reduce((s, c) => s + (c.likelihood ?? 0), 0) || 1;
  const report: ApplyReport = { created: [], links: 0, dropped: [] };
  const pendingLinks: [string, ContinueResult['children'][number] | ThreadStart][] = [];
  const keys = new Map<string, string>();
  /** The waiting placeholder becomes the first node written directly under the target. */
  const nextUnderTarget = (extra: Partial<TLNode> = {}) => {
    const node = placeholder ?? makeNode({ parentId: job.targetNodeId, mergeParents, kind: 'event', source: 'llm' });
    placeholder = undefined;
    Object.assign(node, extra);
    return node;
  };
  const remember = (node: TLNode, written: { key?: string }) => {
    if (written.key) keys.set(written.key, node.id);
  };

  result.children.forEach((c) => {
    const node = nextUnderTarget();
    fill(node, c, ts);
    remember(node, c);
    node.likelihood = branching ? (c.likelihood ?? 0) / total : undefined;
    node.branchReason = branching ? result.branchReason : undefined;
    tl.nodes[node.id] = node;
    report.created.push({ id: node.id, title: node.title });
    pendingLinks.push([node.id, c]);

    for (const t of c.spawnThreads ?? []) {
      const start = makeNode({ parentId: node.id, kind: 'event', source: 'llm', threadName: t.thread });
      fill(start, t, ts);
      remember(start, t);
      tl.nodes[start.id] = start;
      report.created.push({ id: start.id, title: start.title, thread: t.thread });
      pendingLinks.push([start.id, t]);
    }
  });

  // Parallel threads straight from the target: they happen alongside each other (and any children).
  for (const t of result.threads) {
    const start = nextUnderTarget({ threadName: t.thread, likelihood: undefined, branchReason: undefined });
    fill(start, t, ts);
    remember(start, t);
    tl.nodes[start.id] = start;
    report.created.push({ id: start.id, title: start.title, thread: t.thread });
    pendingLinks.push([start.id, t]);
  }

  // Links last, so every new node exists and the world rules see the final graph.
  for (const [id, refs] of pendingLinks) applyLinkRefs(tl, id, refs, report, keys);
  return report;
}

export function applyRegenerate(tl: Timeline, node: TLNode, result: RegenerateResult): ApplyReport {
  const { influences, influencedBy, ...content } = result.node;
  fill(node, content, now());
  node.source = 'llm';
  markStaleFrom(tl, node.id);
  const report: ApplyReport = { created: [], links: 0, dropped: [] };
  applyLinkRefs(tl, node.id, { influences, influencedBy }, report);
  return report;
}

/**
 * After `nodeId` changes, everything that followed from it may be out of date: its descendants, and the
 * nodes it influences (plus their descendants).
 */
export function markStaleFrom(tl: Timeline, nodeId: string) {
  const targets = new Set<string>();
  for (const d of descendantsOf(tl, nodeId)) targets.add(d.id);
  for (const l of tl.links) {
    if (l.from !== nodeId || !tl.nodes[l.to]) continue;
    targets.add(l.to);
    for (const d of descendantsOf(tl, l.to)) targets.add(d.id);
  }
  for (const id of targets) if (tl.nodes[id].status === 'ready') tl.nodes[id].stale = true;
}

export function removeLinksFor(tl: Timeline, ids: Set<string>) {
  tl.links = tl.links.filter((l) => !ids.has(l.from) && !ids.has(l.to));
}
