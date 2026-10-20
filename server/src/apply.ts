// Applies worker results and link edits to a timeline. Pure functions over the Timeline object (no I/O),
// so they can be tested without the HTTP layer.
import type { InfluenceLink, Job, Significance, Strength, Timeline, TLNode } from '../../shared/types.ts';
import { canLink, effectiveYear, INFLUENCE_WINDOW_YEARS, startYear, streamNameOf, WorldIndex } from '../../shared/world.ts';
import { parsePeriodStart } from '../../shared/time.ts';
import { descendantsOf, makeNode, newId, now } from './store.ts';
import type { Confidence, continueResult, LinkRef, regenerateResult, threadStart } from './schema.ts';
import type { z } from 'zod';

type ContinueResult = z.infer<typeof continueResult>;
type RegenerateResult = z.infer<typeof regenerateResult>;
type ThreadStart = z.infer<typeof threadStart>;

/** The review-related fields of any node a writer returns. */
interface ReviewSignals {
  title: string;
  significance: Significance;
  requestReview?: string;
  confidence?: Confidence;
  doubt?: string;
}

/**
 * Why a node gets a plausibility review when the user lets the writer decide (review option "auto"), or
 * undefined. Writers almost never volunteer doubt, so they rate every node instead: low confidence gets a
 * review, and so does medium on a major or pivotal node, where a weak link costs the most.
 */
export function reviewReasonFor(w: ReviewSignals): string | undefined {
  if (w.requestReview) return w.requestReview;
  const big = w.significance === 'major' || w.significance === 'pivotal';
  if (w.confidence !== 'low' && !(w.confidence === 'medium' && big)) return undefined;
  return `Writer confidence ${w.confidence}${big ? ` on a ${w.significance} event` : ''}: ${w.doubt ?? 'no reason given'}`.slice(0, 300);
}

/** In "auto" review mode every written node needs a confidence rating, and a doubt unless it is high. */
function confidenceIssues(written: ReviewSignals[], review: Job['review']): string[] {
  if (review !== 'auto') return [];
  const issues: string[] = [];
  for (const w of written) {
    if (!w.confidence) {
      issues.push(`"${w.title}": add "confidence": "high" | "medium" | "low" (the user lets you decide on plausibility reviews).`);
    } else if (w.confidence !== 'high' && !w.doubt) {
      issues.push(`"${w.title}": confidence is ${w.confidence}, so add "doubt": the weakest claim, in one sentence.`);
    }
  }
  return issues;
}

export interface ApplyReport {
  /** reviewReason: why this node should get a plausibility review (used when the review option is "auto"). */
  created: { id: string; title: string; thread?: string; reviewReason?: string }[];
  links: number;
  /** Links the model asked for that were invalid, with the reason; the rest of the result still applies. */
  dropped: string[];
  /** Follow-ups the model asked for, from a node it wrote; the caller validates and queues them. */
  followUps: { source: string; target: string; strength: Strength; guidance: string }[];
}

/** Adds a link if the link rules (separate streams, one world, time window) allow it. Returns the reason when they do not. */
export function addLink(
  tl: Timeline,
  from: string,
  to: string,
  strength: Strength,
  note: string,
  source: InfluenceLink['source'],
  ix?: WorldIndex,
): { link: InfluenceLink } | { error: string } {
  const check = canLink(tl, from, to, ix);
  if (!check.ok) return { error: check.reason };
  return { link: putLink(tl, from, to, strength, note, source) };
}

/**
 * Adds or updates a link without the link rules (no time window). Only for the user's influence flow, which
 * was validated with canInfluence when it started.
 */
export function putLink(
  tl: Timeline,
  from: string,
  to: string,
  strength: Strength,
  note: string,
  source: InfluenceLink['source'],
): InfluenceLink {
  const existing = tl.links.find((l) => l.from === from && l.to === to);
  if (existing) return Object.assign(existing, { strength, note, source });
  const link: InfluenceLink = { id: newId(), from, to, strength, note, source, createdAt: now() };
  tl.links.push(link);
  return link;
}

function applyLinkRefs(
  tl: Timeline,
  nodeId: string,
  refs: { influences?: LinkRef[]; influencedBy?: LinkRef[] },
  report: ApplyReport,
  keys: Map<string, string> = new Map(),
  ix = new WorldIndex(tl),
) {
  const one = (other: string, ref: LinkRef, dir: 'out' | 'in') => {
    // "@key" points at another node written in the same result.
    const id = ref.node.startsWith('@') ? keys.get(ref.node.slice(1)) : ref.node;
    if (!id || !tl.nodes[id]) {
      report.dropped.push(`${ref.node}: ${ref.node.startsWith('@') ? 'no node with that key in this result' : 'no node with that id'}`);
      return;
    }
    const [from, to] = dir === 'out' ? [other, id] : [id, other];
    // Old events may shape the new node without limit, but the new node only reaches a little way forward.
    const fy = startYear(tl.nodes[from]);
    const ty = startYear(tl.nodes[to]);
    if (dir === 'out' && !ref.node.startsWith('@') && fy !== null && ty !== null && ty - fy > INFLUENCE_WINDOW_YEARS) {
      report.dropped.push(
        `${tl.nodes[from].title} -> ${tl.nodes[to].title}: ${ty - fy} years ahead (a new node influences at most ${INFLUENCE_WINDOW_YEARS} years forward)`,
      );
      return;
    }
    const r = addLink(tl, from, to, ref.strength, ref.note, 'llm', ix);
    if ('error' in r) report.dropped.push(`${tl.nodes[from].title} -> ${tl.nodes[to].title}: ${r.error}`);
    else report.links++;
  };
  for (const ref of refs.influences ?? []) one(nodeId, ref, 'out');
  for (const ref of refs.influencedBy ?? []) one(nodeId, ref, 'in');
}

/** A streamName only renames when it differs from the stream's current name (models often repeat it). */
const isRename = (name: string | undefined, current: string | undefined): name is string =>
  !!name && name.trim().toLowerCase() !== (current ?? '').trim().toLowerCase();

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
    // A review judged the old content; any pending one is discarded when it comes back (job id mismatch).
    review: undefined,
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
  const report: ApplyReport = { created: [], links: 0, dropped: [], followUps: [] };
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

  const currentName = streamNameOf(tl, job.targetNodeId);
  // Most likely first, so creation order (and the layout) matches the odds whatever order they came in.
  const children = branching ? [...result.children].sort((a, b) => (b.likelihood ?? 0) - (a.likelihood ?? 0)) : result.children;
  children.forEach((c) => {
    const node = nextUnderTarget();
    fill(node, c, ts);
    remember(node, c);
    if (isRename(c.streamName, currentName)) node.streamName = c.streamName;
    node.likelihood = branching ? (c.likelihood ?? 0) / total : undefined;
    node.branchReason = branching ? result.branchReason : undefined;
    tl.nodes[node.id] = node;
    report.created.push({ id: node.id, title: node.title, reviewReason: reviewReasonFor(c) });
    pendingLinks.push([node.id, c]);
    for (const f of c.followUps ?? []) report.followUps.push({ source: node.id, ...f });

    for (const t of c.spawnThreads ?? []) {
      const start = makeNode({ parentId: node.id, kind: 'event', source: 'llm', threadName: t.thread });
      fill(start, t, ts);
      remember(start, t);
      tl.nodes[start.id] = start;
      report.created.push({ id: start.id, title: start.title, thread: t.thread, reviewReason: reviewReasonFor(t) });
      pendingLinks.push([start.id, t]);
    }
  });

  // Parallel threads straight from the target: they happen alongside each other (and any children).
  for (const t of result.threads) {
    const start = nextUnderTarget({ threadName: t.thread, likelihood: undefined, branchReason: undefined });
    fill(start, t, ts);
    remember(start, t);
    tl.nodes[start.id] = start;
    report.created.push({ id: start.id, title: start.title, thread: t.thread, reviewReason: reviewReasonFor(t) });
    pendingLinks.push([start.id, t]);
  }

  // Links last, so every new node exists and the world rules see the final graph.
  // Links never change parentage, so one index covers them all.
  const ix = new WorldIndex(tl);

  // INFLUENCE: the source shapes every alternative written here (the placeholder's link carries the strength).
  const from = job.type === 'influence' ? job.influenceFrom : undefined;
  if (from && tl.nodes[from]) {
    const strength = tl.links.find((l) => l.from === from && l.to === job.placeholderId)?.strength ?? 'moderate';
    // A follow-up's arrow was asked for by the model, a user influence's by the user.
    const linkSource = job.followUpDepth ? 'llm' : 'user';
    for (const c of report.created.filter((c) => !c.thread)) putLink(tl, from, c.id, strength, result.influenceNote ?? '', linkSource);
  }
  for (const [id, refs] of pendingLinks) applyLinkRefs(tl, id, refs, report, keys, ix);
  return report;
}

export function applyRegenerate(tl: Timeline, node: TLNode, result: RegenerateResult): ApplyReport {
  const { influences, influencedBy, streamName, ...content } = result.node;
  fill(node, content, now());
  // A rename stays unless the writer gives a new one.
  if (isRename(streamName, node.parentId ? streamNameOf(tl, node.parentId) : undefined)) node.streamName = streamName;
  node.source = 'llm';
  markStaleFrom(tl, node.id);
  const report: ApplyReport = { created: [], links: 0, dropped: [], followUps: [] };
  applyLinkRefs(tl, node.id, { influences, influencedBy }, report);
  return report;
}

/** Whole start year of a period, or null when it cannot be read (undated nodes are never flagged). */
const periodYear = (period: string) => {
  const y = parsePeriodStart(period);
  return y === null ? null : Math.floor(y);
};

/**
 * Nodes in a worker result that start in an earlier year than a node they follow (the target, every merged
 * branch, or the child a thread is spawned from). Each entry is a message for the worker.
 */
export function chronologyIssues(
  tl: Timeline,
  written: { title: string; period: string }[],
  parents: string[],
): string[] {
  const dated = parents
    .map((id) => tl.nodes[id])
    .filter((p): p is TLNode => !!p)
    .map((p) => ({ p, year: periodYear(p.period) }))
    .filter((x): x is { p: TLNode; year: number } => x.year !== null);
  if (!dated.length) return [];
  const latest = dated.reduce((a, b) => (b.year > a.year ? b : a));
  return written.flatMap((w) => {
    const y = periodYear(w.period);
    return y !== null && y < latest.year
      ? [`"${w.title}" (${w.period}) starts before "${latest.p.title}" (${latest.p.period}), which it follows. Start it in ${latest.year} or later.`]
      : [];
  });
}

/** Chronology check for a CONTINUE or MERGE result, including spawned threads (which follow their child). */
export function continueChronology(tl: Timeline, job: Job, result: ContinueResult): string[] {
  // An influenced event cannot start before the event that influences it.
  const parents = [
    job.targetNodeId,
    ...(job.type === 'merge' ? (job.mergeWith ?? []) : []),
    ...(job.type === 'influence' && job.influenceFrom ? [job.influenceFrom] : []),
  ];
  const issues = chronologyIssues(tl, [...result.children, ...result.threads], parents);
  for (const c of result.children) {
    const y = periodYear(c.period);
    for (const t of c.spawnThreads ?? []) {
      const ty = periodYear(t.period);
      if (y !== null && ty !== null && ty < y) {
        issues.push(`Thread "${t.thread}": "${t.title}" (${t.period}) starts before "${c.title}" (${c.period}), which sets it off.`);
      }
    }
  }
  return issues;
}

/**
 * Written nodes whose period has no readable start year, in a timeline where the node they follow has one.
 * Without a year the chronology check and the time layout cannot place them. Undated worlds are left alone.
 */
function undatedIssues(tl: Timeline, written: { title: string; period: string }[], after: string): string[] {
  if (effectiveYear(tl, after) === null) return [];
  return written
    .filter((w) => periodYear(w.period) === null)
    .map((w) => `"${w.title}": period "${w.period}" has no readable year. Start it with one, e.g. "1864", "Summer 1940", "1990s".`);
}

/** Link refs that point at nothing: an unknown id, or an "@key" that no node in this result has. */
function refIssues(tl: Timeline, written: ({ title: string } & Parameters<typeof applyLinkRefs>[2])[], keys: Set<string>): string[] {
  return written.flatMap((w) =>
    [...(w.influences ?? []), ...(w.influencedBy ?? [])].flatMap((r) => {
      if (r.node.startsWith('@')) return keys.has(r.node.slice(1)) ? [] : [`"${w.title}": link to ${r.node}, but no node in this result has that key.`];
      return tl.nodes[r.node] ? [] : [`"${w.title}": link to ${r.node}, but no event has that id. Use ids from the brief or a search.`];
    }),
  );
}

/**
 * Everything wrong with a CONTINUE, MERGE or INFLUENCE result that the schema cannot see because it needs the
 * timeline: chronology, undated periods, broken link refs, follow-up targets, a missing influence note. Each
 * entry is a message for the writer; any entry means nothing is applied and the writer fixes and resubmits.
 * Link-rule violations (same path, different worlds, too far ahead) are not here: those links are dropped.
 */
export function continueIssues(tl: Timeline, job: Job, result: ContinueResult, maxFollowUpDepth: number): string[] {
  const issues = continueChronology(tl, job, result);
  const spawned = result.children.flatMap((c) => c.spawnThreads ?? []);
  const written = [...result.children, ...spawned, ...result.threads];
  issues.push(...undatedIssues(tl, written, job.targetNodeId));
  const keys = new Set(written.map((w) => w.key).filter((k): k is string => !!k));
  issues.push(...refIssues(tl, written, keys));
  issues.push(...confidenceIssues(written, job.review));
  if (job.type === 'influence' && !result.influenceNote) {
    issues.push('influenceNote is required on INFLUENCE: one sentence on the effect, shown on the arrow.');
  }
  const followUps = result.children.flatMap((c) => c.followUps ?? []);
  if (followUps.length && (job.followUpDepth ?? 0) >= maxFollowUpDepth) {
    issues.push('This job is itself a follow-up, so it cannot request followUps. Remove them (use influences links instead).');
  } else if (followUps.length) {
    const ix = new WorldIndex(tl);
    for (const f of followUps) {
      const t = tl.nodes[f.target];
      if (!t) issues.push(`followUps target ${f.target}: no event has that id.`);
      else if (!ix.isTip(t.id)) issues.push(`followUps target "${t.title}" is not the latest event in its stream. Use one marked "latest in stream".`);
    }
  }
  return issues;
}

/**
 * Everything wrong with a REGENERATE result: it must still start no earlier than its parents and no later
 * than its earliest child, carry a year, and link only to real nodes.
 */
export function regenerateIssues(tl: Timeline, node: TLNode, result: RegenerateResult, review?: Job['review']): string[] {
  const issues = chronologyIssues(tl, [result.node], [node.parentId, ...(node.mergeParents ?? [])].filter((p): p is string => !!p));
  if (node.parentId) issues.push(...undatedIssues(tl, [result.node], node.parentId));
  const y = periodYear(result.node.period);
  if (y !== null) {
    const later = new WorldIndex(tl)
      .children(node.id)
      // Stale children get rewritten next, so they may move with it (an edit that shifted the dates).
      .filter((c) => !c.stale && c.status === 'ready')
      .map((c) => ({ c, year: periodYear(c.period) }))
      .filter((x): x is { c: TLNode; year: number } => x.year !== null && x.year < y)
      .sort((a, b) => a.year - b.year)[0];
    if (later) {
      issues.push(
        `"${result.node.title}" (${result.node.period}) starts after "${later.c.title}" (${later.c.period}), which follows it. Start it in ${later.year} or earlier.`,
      );
    }
  }
  issues.push(...refIssues(tl, [result.node], new Set()));
  issues.push(...confidenceIssues([result.node], review));
  return issues;
}

/**
 * After `nodeId` changes, everything that followed from it may be out of date: its descendants, and the
 * nodes it influences (plus their descendants).
 */
export function markStaleFrom(tl: Timeline, nodeId: string) {
  const targets = new Set<string>();
  const ix = new WorldIndex(tl);
  for (const d of descendantsOf(tl, nodeId, ix)) targets.add(d.id);
  for (const l of tl.links) {
    if (l.from !== nodeId || !tl.nodes[l.to]) continue;
    targets.add(l.to);
    for (const d of descendantsOf(tl, l.to, ix)) targets.add(d.id);
  }
  for (const id of targets) if (tl.nodes[id].status === 'ready') tl.nodes[id].stale = true;
}

export function removeLinksFor(tl: Timeline, ids: Set<string>) {
  tl.links = tl.links.filter((l) => !ids.has(l.from) && !ids.has(l.to));
}
