import { SIGNIFICANCES, type Job, type Significance, type Strength, type Timeline, type TLNode } from '../../shared/types.ts';
import {
  ancestorIds,
  INFLUENCE_WINDOW_YEARS,
  startYear,
  streamLabel,
  WorldIndex,
} from '../../shared/world.ts';
import { childrenOf, pathTo } from './store.ts';
import { MAX_FOLLOW_UPS } from './schema.ts';

/** Ancestors this close to the target get their full narrative; older ones only the summary. */
const FULL_NARRATIVE_DEPTH = 3;
/** At most this many nearby events from other streams are listed, the closest in time first. */
const MAX_NEARBY = 8;

const FIELD_HINT =
  'significance: minor | notable | major | pivotal. tone: neutral | conflict | catastrophe | upheaval | decline | prosperity | discovery | diplomacy. strength: mild | moderate | strong.';

function describeNode(tl: Timeline, n: TLNode, index: number, full: boolean): string {
  const tags: string[] = [`id: ${n.id}`];
  if (n.kind === 'deviation') tags.push(index === 0 ? 'POINT OF DIVERGENCE' : 'NEW USER DEVIATION');
  if (n.threadName) tags.push(`STARTS THREAD "${n.threadName}"`);
  if (n.mergeParents?.length) tags.push('CONVERGENCE');
  if (n.source === 'llm-edited') tags.push('EDITED BY USER: authoritative');
  if (n.likelihood !== undefined) tags.push(`chosen branch, likelihood ${Math.round(n.likelihood * 100)}%`);
  if (n.kind === 'event') tags.push(`${n.significance}, ${n.tone}`);
  const lines = [`### ${index + 1}. ${n.title}  (${n.period || 'no date'})${tags.length ? `  [${tags.join(' | ')}]` : ''}`];
  for (const id of n.mergeParents ?? []) {
    const p = tl.nodes[id];
    if (p) lines.push(`(Also follows from a parallel storyline that ended with "${p.title}" (${p.period}): ${p.summary})`);
  }
  if (n.summary) lines.push(n.summary);
  if (n.keyChanges.length) lines.push(`Key changes: ${n.keyChanges.join('; ')}`);
  if (full && n.narrative) lines.push('', n.narrative);
  return lines.join('\n');
}

function chainSection(tl: Timeline, nodes: TLNode[], offset = 0): string {
  return nodes
    .map((n, i) => describeNode(tl, n, i + offset, i >= nodes.length - FULL_NARRATIVE_DEPTH))
    .join('\n\n');
}

/** The part of otherId's path that is not shared with `primary` (from the fork point onward). */
function divergentPart(tl: Timeline, primary: TLNode[], otherId: string) {
  const shared = new Set(primary.map((n) => n.id));
  const path = pathTo(tl, otherId);
  const forkIndex = path.findLastIndex((n) => shared.has(n.id));
  return { fork: forkIndex >= 0 ? path[forkIndex] : null, nodes: path.slice(forkIndex + 1), offset: forkIndex + 1 };
}

function otherBranchSections(tl: Timeline, primary: TLNode[], otherIds: string[]): string[] {
  const out: string[] = [];
  otherIds.forEach((id, i) => {
    if (!tl.nodes[id]) return;
    const { fork, nodes, offset } = divergentPart(tl, primary, id);
    const label = String.fromCharCode(66 + i); // B, C, ...
    out.push(
      '',
      `## Branch ${label}: ${fork ? `splits off after "${fork.title}"` : 'separate root'} (oldest first, ends with the node being merged)`,
      // Numbered by position on its own path, so only the real root is labeled the point of divergence.
      chainSection(tl, nodes, offset),
    );
  });
  return out;
}

/** The first sentence of a summary (capped), enough to judge relevance without the full text. */
const firstSentence = (s: string) => {
  const m = s.match(/^.+?[.!?](?=\s|$)/);
  const out = m ? m[0] : s;
  return out.length > 240 ? `${out.slice(0, 237)}...` : out;
};

const short = (n: TLNode) => `"${n.title}" (${n.period || 'no date'}) [id: ${n.id}]`;

/**
 * Influence links touching the storyline (any node in `chain`), and nearby events in other streams around
 * `anchorYear` (when the node being written starts), as link candidates.
 */
function threadContext(
  tl: Timeline,
  chain: TLNode[],
  anchor: TLNode,
  exclude: Set<string>,
  anchorYear: number | null = startYear(anchor),
): string[] {
  const out: string[] = [];
  const inChain = new Set(chain.map((n) => n.id));

  const links = tl.links.filter((l) => (inChain.has(l.from) || inChain.has(l.to)) && tl.nodes[l.from] && tl.nodes[l.to]);
  if (links.length) {
    out.push('', '## Influence links touching this storyline');
    for (const l of links) {
      const f = tl.nodes[l.from];
      const t = tl.nodes[l.to];
      out.push(
        `- ${short(f)} in stream "${streamLabel(tl, f.id)}" --${l.strength}--> ${short(t)}${l.note ? `: ${l.note}` : ''}`,
      );
      // The far end of an incoming link is outside this chain, so give its content.
      if (!inChain.has(f.id)) out.push(`  ${f.summary}`);
    }
  }

  const nearby = nearbyEvents(tl, anchor, new Set([...exclude, ...inChain]), anchorYear);
  if (nearby.length && anchorYear !== null) {
    out.push(
      '',
      `## Nearby events in other streams (within ${INFLUENCE_WINDOW_YEARS} years of ${anchorYear}, closest first)`,
      'These happen in the same world as your node. Check each: does it shape what you write, or will your node shape it?',
      'Where there is a real causal effect, link it: "influencedBy" for events that act on yours, "influences" for events yours acts on. ' +
        'Most nodes need 0-2 links. For older events (or ones not listed), search: see "Finding other events" below.',
    );
    const ix = new WorldIndex(tl);
    for (const { node, gap } of nearby) {
      const when = gap === 0 ? 'same year' : gap < 0 ? `${-gap}y earlier` : `${gap}y later`;
      const tip = ix.isTip(node.id) ? ', latest in stream' : '';
      out.push(`- [${streamLabel(tl, node.id)}, ${when}${tip}] ${short(node)}: ${firstSentence(node.summary)}`);
    }
  }
  return out;
}

export interface Candidate {
  node: TLNode;
  /** Start year minus the anchor year (negative = earlier); null when either is undated. */
  gap: number | null;
}

/**
 * Every event the node being written may link to: ready, in another stream of the same world (not the
 * storyline itself, its ancestors or its own future), not in `exclude`, and starting no more than
 * INFLUENCE_WINDOW_YEARS after `anchorYear`. There is no limit backwards: very old events can matter.
 */
export function linkCandidates(tl: Timeline, anchor: TLNode, exclude: Set<string>, anchorYear: number | null): Candidate[] {
  const ix = new WorldIndex(tl);
  const upstream = ancestorIds(tl, anchor.id);
  const downstream = new Set(ix.descendants(anchor.id).map((n) => n.id));
  const out: Candidate[] = [];
  for (const n of Object.values(tl.nodes)) {
    if (n.status !== 'ready' || n.id === anchor.id || exclude.has(n.id) || upstream.has(n.id) || downstream.has(n.id)) continue;
    const y = startYear(n);
    const gap = y === null || anchorYear === null ? null : y - anchorYear;
    if (gap !== null && gap > INFLUENCE_WINDOW_YEARS) continue;
    if (!ix.sameWorld(n.id, anchor.id)) continue;
    out.push({ node: n, gap });
  }
  return out;
}

/** Candidates within the window either side of the anchor, closest first (the brief's "nearby" list). */
export function nearbyEvents(tl: Timeline, anchor: TLNode, exclude: Set<string>, anchorYear: number | null) {
  return linkCandidates(tl, anchor, exclude, anchorYear)
    .filter((c): c is { node: TLNode; gap: number } => c.gap !== null && Math.abs(c.gap) <= INFLUENCE_WINDOW_YEARS)
    .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap) || a.gap - b.gap)
    .slice(0, MAX_NEARBY);
}

/** The year a new node written after `parents` starts at the earliest: the latest of their start years. */
function latestStart(tl: Timeline, ids: (string | undefined)[]): number | null {
  const years = ids.map((id) => (id && tl.nodes[id] ? startYear(tl.nodes[id]) : null)).filter((y): y is number => y !== null);
  return years.length ? Math.max(...years) : null;
}

/**
 * What a job's links are judged against: the node it writes after (or rewrites), the year the new node
 * starts at the earliest, and nodes already shown in full elsewhere in the brief.
 */
export function jobScope(tl: Timeline, job: Job): { anchor: TLNode; anchorYear: number | null; exclude: Set<string> } | null {
  const anchor = tl.nodes[job.targetNodeId];
  if (!anchor) return null;
  const pathIds = (id: string | undefined) => (id && tl.nodes[id] ? pathTo(tl, id).map((n) => n.id) : []);
  if (job.type === 'regenerate') return { anchor, anchorYear: startYear(anchor), exclude: new Set([anchor.id]) };
  const others = job.type === 'merge' ? (job.mergeWith ?? []) : job.type === 'influence' ? [job.influenceFrom] : [];
  return {
    anchor,
    anchorYear: latestStart(tl, [anchor.id, ...others]),
    exclude: new Set([job.placeholderId ?? '', ...others.flatMap(pathIds)]),
  };
}

/** Target share of each significance (matches the table in .claude/agents/althistory-writer.md). */
const SIGNIFICANCE_TARGET: Record<Significance, number> = { minor: 0.2, notable: 0.55, major: 0.2, pivotal: 0.05 };
/** Rated events needed before the mix means anything. */
const CALIBRATION_MIN = 5;

/**
 * How this timeline's significance ratings compare with the targets, so ratings stay calibrated across jobs
 * (the mood theme only means something when major and pivotal are rare). Empty for young timelines.
 */
export function calibrationLines(tl: Timeline, exclude: string): string[] {
  const rated = Object.values(tl.nodes).filter((n) => n.kind === 'event' && n.status === 'ready' && n.id !== exclude);
  if (rated.length < CALIBRATION_MIN) return [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const share = (s: Significance) => rated.filter((n) => n.significance === s).length / rated.length;
  const mix = SIGNIFICANCES.map((s) => `${s} ${pct(share(s))} (target ${s === 'pivotal' ? '<=' : '~'}${pct(SIGNIFICANCE_TARGET[s])})`);
  const high = share('major') + share('pivotal');
  const highTarget = SIGNIFICANCE_TARGET.major + SIGNIFICANCE_TARGET.pivotal;
  const advice =
    high > highTarget + 0.1
      ? 'Major and pivotal are over-used here. Rate this major only if it reshapes a whole region or field; otherwise notable or minor.'
      : high < highTarget - 0.15
        ? 'Major and pivotal are rare here. Do not hold back when this development genuinely reshapes a region or era.'
        : 'The mix is on target; keep rating each node on its own merits.';
  return [`Significance so far in this timeline (${rated.length} events): ${mix.join(', ')}.`, advice];
}

/**
 * Who reads the brief: the external worker (runs worker/*.mjs commands, writes a file) or a model called by
 * the built-in runner (calls tools, replies with the JSON). Everything else in the brief is identical.
 */
export type BriefMode = 'worker' | 'api';

/** Tool names the built-in runner offers; the API-mode brief refers to them. */
export const API_TOOLS = { search: 'search_events', show: 'show_event' } as const;

function searchSection(job: Job, mode: BriefMode): string[] {
  const intro =
    'If an older or unlisted event in another stream may shape this node (a person, program, treaty or war that comes back), search for it';
  const tail = `Results older than ${INFLUENCE_WINDOW_YEARS} years show only their key changes. Every id a search returns can be linked.`;
  if (mode === 'api') {
    return [
      '',
      '## Finding other events (optional, at most 3 searches)',
      `${intro} with the \`${API_TOOLS.search}\` tool (keywords, optional before / after years). ` +
        `\`${API_TOOLS.show}\` returns one event in full. ${tail}`,
    ];
  }
  return [
    '',
    '## Finding other events (optional, at most 3 searches)',
    `${intro}: \`node worker/search.mjs ${job.id} "<keywords>"\` (add \`--before <year>\` / \`--after <year>\` to narrow by start year). ` +
      `\`node worker/search.mjs ${job.id} --node <id>\` prints one event in full. ${tail}`,
  ];
}

function responseSection(job: Job, tl: Timeline, shape: 'children' | 'node', mode: BriefMode): string[] {
  const outFile = `worker/out/${job.id}.json`;
  const linkHint =
    'Optional on any node you write: "influences" / "influencedBy": [ { "node": "<existing id or @key>", "strength": "mild", "note": "" } ]. ' +
    'Give a node "key": "india" so other nodes in this same result can link to it as "@india".';
  const node = '"title": "", "period": "", "summary": "", "narrative": "", "keyChanges": [""], "significance": "notable", "tone": "neutral"';
  const example =
    job.type === 'influence'
      ? `{ "children": [ { ${node}, "influences": [], "influencedBy": [] } ], "influenceNote": "" }`
      : shape === 'children'
        ? `{ "children": [ { ${node}, "likelihood": 1, "influences": [], "influencedBy": [], "spawnThreads": [] } ], "branchReason": "", "threads": [] }`
        : `{ "node": { ${node}, "influences": [], "influencedBy": [] } }`;
  const lines = [
    ...searchSection(job, mode),
    '',
    '## Your response',
    mode === 'api'
      ? 'Reply with ONLY one JSON object of this shape: no other text, no code fences.'
      : `Write JSON to \`${outFile}\` with this shape, then run \`node worker/submit.mjs ${job.id}\`:`,
    '```json',
    example,
    '```',
    FIELD_HINT,
    ...calibrationLines(tl, shape === 'node' ? job.targetNodeId : (job.placeholderId ?? '')),
    linkHint,
    streamNameHint(tl, job, shape),
  ];
  if (shape === 'node') return [...lines, 'Regenerate never branches: return exactly one node.'];
  lines.push(...followUpLines(job));
  if (job.type === 'influence') {
    return [
      ...lines,
      '- One child normally: the next event in THIS stream, shaped by the influencing event. 2-4 alternatives (with likelihoods and branchReason) only when how the stream reacts is genuinely uncertain.',
      '- "influenceNote": one sentence on the effect, shown on the arrow. The server links the influencing event to every child; do not add that link yourself.',
      '- "threads" and "spawnThreads" work as in CONTINUE but are rarely needed here.',
    ];
  }
  return [
    ...lines,
    'Pick the structure (details in your instructions, section "4b"):',
    '- "children": ALTERNATIVES, only one happens. One child normally; 2-4 only when outcomes are genuinely uncertain, then add likelihoods and branchReason.',
    '- "threads" (top level): PARALLEL storylines that ALL happen, starting from this node, each { "thread": "<name>", "key": "...", ...node fields }. ' +
      'Use these when the user asks for separate branches/streams by region or topic that run at the same time; link them to each other with "@key".',
    '- "spawnThreads" (inside a child): a parallel storyline set off BY that child. Usually none.',
    'You may combine them (e.g. no children and two threads), but give at least one child or one thread.',
  ];
}

/** Lets the writer rename the stream when the story has moved on from its current name. */
function streamNameHint(tl: Timeline, job: Job, shape: 'children' | 'node'): string {
  const target = tl.nodes[job.targetNodeId];
  // A regenerated node is named by what comes before it; a new node by the node it follows.
  const from = shape === 'node' ? target?.parentId : job.targetNodeId;
  const current = from ? streamLabel(tl, from) : 'Main';
  return (
    `This stream is currently named "${current}". If your node moves its focus so far that the name no longer fits ` +
    '(a "Vietnam War" stream that is now about Iran), add "streamName": "<short new name>" to it; it renames the stream ' +
    'from your node on. Rarely needed; never for a small shift.'
  );
}

/** How the writer asks for follow-ups, or why it cannot (a follow-up job never requests more). */
function followUpLines(job: Job): string[] {
  if (job.followUpDepth) {
    return ['This job is itself a follow-up another writer requested: do not add "followUps".'];
  }
  return [
    `Optional on a child: "followUps": [ { "target": "<id>", "strength": "moderate", "guidance": "<the consequence to show>" } ] (at most ${MAX_FOLLOW_UPS} per result). ` +
      'Each one makes another writer add a NEW event to a different stream, right after `target`, showing the immediate consequence of your child there. ' +
      '`target` must be marked "latest in stream" in the nearby list or a search result. ' +
      'Use it only when the consequence there is big enough for its own event; for a smaller effect, link with "influences" instead. Most results need none.',
  ];
}

const STRENGTH_MEANING: Record<Strength, string> = {
  mild: 'it nudges this stream',
  moderate: 'it clearly shapes this stream',
  strong: 'it largely drives what happens next here',
};

const timeSpanLine = (job: Job) =>
  `Requested time span: ${job.timeSpan?.trim() || 'not specified. Choose the span that best fits the next meaningful development.'}`;

export function buildBrief(job: Job, tl: Timeline, mode: BriefMode = 'worker'): string {
  const parts: string[] = [];

  if (job.type === 'continue') {
    const chain = pathTo(tl, job.targetNodeId);
    const siblings = childrenOf(tl, job.targetNodeId).filter(
      (c) => c.id !== job.placeholderId && c.status === 'ready' && c.parentId === job.targetNodeId && !c.threadName,
    );
    parts.push(
      `# Job ${job.id}: CONTINUE`,
      `Timeline: "${tl.title}"`,
      `Task: write what happens NEXT after node ${chain.length} ("${chain.at(-1)!.title}").`,
      timeSpanLine(job),
      `User guidance: ${job.guidance?.trim() || 'none'}`,
      '',
      '## Timeline so far (oldest first, the last entry is the node you continue from)',
      chainSection(tl, chain),
    );
    if (siblings.length) {
      parts.push(
        '',
        '## Continuations that ALREADY exist from this node',
        'The user is asking for another one. Do not repeat these; write a distinct, plausible alternative.',
        ...siblings.map((s) => `- ${s.title} (${s.period}): ${s.summary}`),
      );
    }
    const target = tl.nodes[job.targetNodeId];
    parts.push(
      '',
      `You are writing in stream "${streamLabel(tl, target.id)}".`,
      ...threadContext(tl, chain, target, new Set([job.placeholderId ?? ''])),
      ...responseSection(job, tl, 'children', mode),
    );
  } else if (job.type === 'merge') {
    const chain = pathTo(tl, job.targetNodeId);
    const others = job.mergeWith ?? [];
    parts.push(
      `# Job ${job.id}: MERGE`,
      `Timeline: "${tl.title}"`,
      `Task: ${others.length + 1} separate storylines CONVERGE. Write what happens when the events of Branch A ` +
        `(ending with "${chain.at(-1)!.title}") and ${others.map((_, i) => `Branch ${String.fromCharCode(66 + i)}`).join(', ')} meet.`,
      'Treat every branch as having happened in the same world (parallel threads, e.g. different regions or themes).',
      'Where they contradict, resolve it explicitly in the narrative, favoring Branch A unless the user guidance says otherwise.',
      timeSpanLine(job),
      `User guidance: ${job.guidance?.trim() || 'none'}`,
      '',
      '## Branch A: the full timeline from the point of divergence (oldest first)',
      chainSection(tl, chain),
      ...otherBranchSections(tl, chain, others),
      ...threadContext(
        tl,
        chain,
        tl.nodes[job.targetNodeId],
        new Set([job.placeholderId ?? '', ...others.flatMap((id) => pathTo(tl, id).map((n) => n.id))]),
        latestStart(tl, [job.targetNodeId, ...others]),
      ),
      ...responseSection(job, tl, 'children', mode),
    );
  } else if (job.type === 'influence') {
    const chain = pathTo(tl, job.targetNodeId);
    const target = tl.nodes[job.targetNodeId];
    const source = tl.nodes[job.influenceFrom ?? ''];
    const strength = tl.links.find((l) => l.from === source?.id && l.to === job.placeholderId)?.strength ?? 'moderate';
    const siblings = childrenOf(tl, target.id).filter(
      (c) => c.id !== job.placeholderId && c.status === 'ready' && c.parentId === target.id && !c.threadName,
    );
    const { fork, nodes, offset } = source ? divergentPart(tl, chain, source.id) : { fork: null, nodes: [], offset: 0 };
    parts.push(
      `# Job ${job.id}: INFLUENCE`,
      `Timeline: "${tl.title}"`,
      `Task: an event in another stream, "${source?.title}" (${source?.period || 'no date'}), affects this stream. ` +
        `Write what happens NEXT in this stream, after node ${chain.length} ("${target.title}"), showing that effect.`,
      `Strength set by the ${job.followUpDepth ? 'writer who requested this follow-up' : 'user'}: ${strength} (${STRENGTH_MEANING[strength]}). ` +
        'The effect must be visible in the title or summary, and explained in the narrative.',
      'Both events happened in the same world. The new node starts no earlier than either of them.',
      timeSpanLine(job),
      job.followUpDepth
        ? `Guidance from the writer who requested this follow-up: ${job.guidance?.trim() || 'none'}`
        : `User guidance: ${job.guidance?.trim() || 'none'}`,
      '',
      `## This stream so far ("${streamLabel(tl, target.id)}", oldest first, the last entry is the node you continue from)`,
      chainSection(tl, chain),
      '',
      `## The influencing stream ("${source ? streamLabel(tl, source.id) : '?'}"): ` +
        `${fork ? `splits off after "${fork.title}"` : 'separate root'}, ends with the influencing event`,
      chainSection(tl, nodes, offset),
    );
    if (siblings.length) {
      parts.push(
        '',
        '## Continuations that ALREADY exist from this node',
        'Your node becomes an alternative to these (the world where this influence happens). Do not repeat them.',
        ...siblings.map((s) => `- ${s.title} (${s.period}): ${s.summary}`),
      );
    }
    parts.push(
      ...threadContext(
        tl,
        chain,
        target,
        new Set([job.placeholderId ?? '', ...(source ? pathTo(tl, source.id).map((n) => n.id) : [])]),
        latestStart(tl, [target.id, source?.id]),
      ),
      ...responseSection(job, tl, 'children', mode),
    );
  } else {
    const target = tl.nodes[job.targetNodeId];
    const chain = pathTo(tl, job.targetNodeId).slice(0, -1);
    parts.push(
      `# Job ${job.id}: REGENERATE`,
      `Timeline: "${tl.title}"`,
      'Task: an earlier node was edited, so this node is out of date. Rewrite it so it follows from the timeline below.',
      `Keep roughly the same time period (${target.period || 'unspecified'}) unless the changes make that impossible.`,
      `User guidance: ${job.guidance?.trim() || 'none'}`,
      '',
      `## ${target.mergeParents?.length ? 'Branch A: timeline' : 'Timeline'} up to this node (oldest first)`,
      chainSection(tl, chain),
    );
    if (target.mergeParents?.length) {
      parts.push(
        '',
        'This node is a CONVERGENCE: it must follow from Branch A and from the branch(es) below, which happened in the same world.',
        ...otherBranchSections(tl, chain, target.mergeParents),
      );
    }
    parts.push(
      '',
      '## Outdated version of this node (for reference only)',
      describeNode(tl, target, chain.length, true),
      ...threadContext(tl, [...chain, target], target, new Set([target.id])),
      ...responseSection(job, tl, 'node', mode),
    );
  }
  return parts.join('\n');
}
