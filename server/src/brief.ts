import { SIGNIFICANCES, type Job, type Significance, type Strength, type Temperament, type Timeline, type TLNode } from '../../shared/types.ts';
import {
  ancestorIds,
  effectiveYear,
  INFLUENCE_WINDOW_YEARS,
  startYear,
  streamLabel,
  WorldIndex,
} from '../../shared/world.ts';
import { childrenOf, pathTo } from './store.ts';
import { MAX_FOLLOW_UPS } from './schema.ts';

/**
 * Only the node being continued gets its full narrative in the brief; earlier ones show summary and key
 * changes, which carry their facts. (Three full narratives cost ~2k input tokens per job for little gain.)
 */
const FULL_NARRATIVE_DEPTH = 1;
/**
 * The last this-many chain nodes show their summary; older ones show title, period and key changes only
 * (what an old event leaves behind). Keeps a deep chain from growing the brief by ~350 tokens per node.
 */
const SUMMARY_DEPTH = 8;
/** Influence links are listed when they touch one of the last this-many chain nodes. */
const RECENT_LINK_DEPTH = 3;
/** At most this many nearby events from other streams are listed, the closest in time first. */
const MAX_NEARBY = 8;

const FIELD_HINT =
  'significance: minor | notable | major | pivotal. tone: neutral | conflict | catastrophe | upheaval | decline | prosperity | discovery | diplomacy. strength: mild | moderate | strong.';

type Detail = 'compact' | 'summary' | 'full';

function describeNode(tl: Timeline, n: TLNode, index: number, detail: Detail): string {
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
  // Deviations keep their summary at any depth: they are what the user wrote, often with no key changes.
  if (n.summary && (detail !== 'compact' || n.kind === 'deviation' || !n.keyChanges.length)) lines.push(n.summary);
  if (n.keyChanges.length) lines.push(`Key changes: ${n.keyChanges.join('; ')}`);
  if (detail === 'full' && n.narrative) lines.push('', n.narrative);
  return lines.join('\n');
}

/**
 * A chain: the last node in full, the rest with summaries, except the first `compact` (key changes only).
 * By default everything past the last SUMMARY_DEPTH entries is compact.
 */
function chainSection(
  tl: Timeline,
  nodes: TLNode[],
  offset = 0,
  compact = Math.max(0, nodes.length - SUMMARY_DEPTH),
  fullDepth = FULL_NARRATIVE_DEPTH,
): string {
  const detail = (i: number): Detail =>
    nodes.length - i <= fullDepth ? 'full' : i < compact ? 'compact' : 'summary';
  return [
    ...(compact > 0 ? [`(The first ${compact} entries show key changes only. ${FULL_STORY_HINT})`] : []),
    ...nodes.map((n, i) => describeNode(tl, n, i + offset, detail(i))),
  ].join('\n\n');
}

const FULL_STORY_HINT = 'To read one in full, pass its id to show_event, or to search.mjs --node.';

/**
 * How many of a storyline's oldest nodes go into the brief's cacheable prefix. It grows in steps, so the
 * prefix stays byte-identical for ARCHIVE_STEP jobs in a row along one branch, and model APIs can serve it
 * from cache instead of billing it again. Up to ARCHIVE_STEP - 1 compact nodes sit in the job-specific part
 * between the prefix and the last SUMMARY_DEPTH nodes, so the brief is no longer than without a prefix.
 * Caching only starts once the prefix passes the provider's minimum (1024 tokens for most Claude models),
 * about 10 archived nodes.
 */
const ARCHIVE_STEP = 4;
const archiveSize = (len: number) => Math.max(0, Math.floor((len - SUMMARY_DEPTH) / ARCHIVE_STEP) * ARCHIVE_STEP);

/** The stable opening of a brief: the timeline name and the storyline's oldest nodes, key changes only. */
function archiveSection(tl: Timeline, archive: TLNode[]): string {
  return [
    `# Timeline "${tl.title}"`,
    '',
    `## Earlier history of this storyline (oldest first, key changes only; it continues in the job below). ${FULL_STORY_HINT}`,
    '',
    archive.map((n, i) => describeNode(tl, n, i, 'compact')).join('\n\n'),
  ].join('\n');
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
  anchorYear: number | null = effectiveYear(tl, anchor.id),
): string[] {
  const out: string[] = [];
  const inChain = new Set(chain.map((n) => n.id));
  const nearby = nearbyEvents(tl, anchor, new Set([...exclude, ...inChain]), anchorYear);

  // Only links on the recent end of the chain: older ones are settled history, already reflected in the
  // chain's key changes (a time window would not help: a busy timeline fits inside one).
  const recent = new Set(chain.slice(-RECENT_LINK_DEPTH).map((n) => n.id));
  const touching = tl.links.filter((l) => (inChain.has(l.from) || inChain.has(l.to)) && tl.nodes[l.from] && tl.nodes[l.to]);
  const links = touching.filter((l) => recent.has(l.from) || recent.has(l.to));
  if (links.length) {
    out.push('', '## Influence links touching this storyline');
    // Each outside event's summary once, and not at all when the nearby list below already gives it.
    const described = new Set(nearby.map((c) => c.node.id));
    for (const l of links) {
      const f = tl.nodes[l.from];
      const t = tl.nodes[l.to];
      out.push(
        `- ${short(f)} in stream "${streamLabel(tl, f.id)}" --${l.strength}--> ${short(t)}${l.note ? `: ${l.note}` : ''}`,
      );
      if (!inChain.has(f.id) && !described.has(f.id)) {
        described.add(f.id);
        out.push(`  ${firstSentence(f.summary)}`);
      }
    }
    if (touching.length > links.length) out.push(`(${touching.length - links.length} older links omitted: settled history.)`);
  }

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
    const y = effectiveYear(tl, n.id);
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
  const years = ids.map((id) => (id && tl.nodes[id] ? effectiveYear(tl, id) : null)).filter((y): y is number => y !== null);
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
  if (job.type === 'regenerate') return { anchor, anchorYear: effectiveYear(tl, anchor.id), exclude: new Set([anchor.id]) };
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
      ? 'Major and pivotal ratings are over-used here: rate this node major only if it reshapes a whole region or field.'
      : high < highTarget - 0.15
        ? 'Major and pivotal ratings are rare here: do not hold back when this development genuinely reshapes a region or era.'
        : 'The mix is on target; keep rating each node on its own merits.';
  // Writers rarely call their own event minor, so quiet stretches get inflated to notable.
  const minorAdvice =
    share('minor') < 0.1
      ? ['Minor is almost unused: consolidation, quiet years and local effects are minor, and saying so is accurate, not dismissive.']
      : [];
  return [
    `Significance so far in this timeline (${rated.length} events): ${mix.join(', ')}.`,
    ...minorAdvice,
    // The mix is about labels. Without this, "over-used" can read as "write calmer events".
    `${advice} This is about the RATING only: never make what happens bigger or smaller to fit the mix.`,
  ];
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
  const narrative = job.detail === 'story' ? '' : '- <when>: <who did what, where, with numbers>\\n- ...\\nWhy: <the causal chain>';
  const node = `"title": "", "period": "", "summary": "", "narrative": "${narrative}", "keyChanges": [""], "significance": "notable", "tone": "neutral"`;
  const example =
    job.type === 'influence'
      ? `{ "children": [ { ${node}, "influences": [], "influencedBy": [] } ], "influenceNote": "" }`
      : shape === 'children'
        ? `{ "children": [ { ${node}, "influences": [], "influencedBy": [], "spawnThreads": [] } ], "threads": [] }`
        : `{ "node": { ${node}, "influences": [], "influencedBy": [] } }`;
  const lines = [
    ...searchSection(job, mode),
    ...realismLines(tl, job),
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
    ...(job.review === 'auto'
      ? [
          'Plausibility review: the user lets you decide. Add "requestReview": "<why>" to any node you write that you are unsure holds up ' +
            '(a contested outcome, numbers you could not ground, a big jump from the chain). Another writer then checks it. Most nodes need none.',
        ]
      : []),
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

const TEMPERAMENT_TEXT: Record<Temperament, string> = {
  realist:
    'realist (default). No thumb on the scale: the actors\' incentives, capabilities and historical base rates decide. ' +
    'Not optimistic, not pessimistic.',
  grim:
    'grim (chosen by the user for this request). Where outcomes are genuinely close, take the worse one: escalation over restraint, ' +
    'miscalculation over caution, deals that fail or never form. Stay plausible: grim, not cartoonish.',
  hopeful:
    'hopeful (chosen by the user for this request). Where outcomes are genuinely close, take the better one: restraint, cooperation, ' +
    'recovery, but only where actors have real reasons and leverage to choose it. Stay plausible: hopeful, not utopian.',
};

const temperamentLine = (job: Job) => `Temperament: ${TEMPERAMENT_TEXT[job.temperament ?? 'realist']}`;

/** How to write the narrative field. Beats must keep everything an essay would: only filler goes. */
const narrativeFormatLine = (job: Job) =>
  job.detail === 'story'
    ? 'Narrative format: full story (chosen by the user for this request): 3-6 paragraphs of prose separated by blank lines.'
    : 'Narrative format: beats (default). 4-10 dated bullet lines ("- March 2027: ..."), each naming the actor, the action, the place and any numbers; ' +
      'add "  - " sub-points for supporting detail. End with a line starting "Why:" giving the causal chain (1-3 sentences). ' +
      'Beats must keep EVERY concrete fact an essay would hold (names, places, numbers, mechanisms, consequences, who reacts how): ' +
      'cut only connective prose, restatement and mood.';

/**
 * Counterweight to the model's pull toward tidy, peaceful resolutions: makes it name the forces on both
 * sides, start from what comparable real situations did, and justify any settlement. Lives in the brief
 * (not only the writer instructions) so it applies even to a worker session started before a change.
 */
function realismLines(tl: Timeline, job: Job): string[] {
  const settled = Object.values(tl.nodes)
    .filter((n) => n.kind === 'event' && n.status === 'ready' && n.tone === 'diplomacy' && n.id !== job.placeholderId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6);
  return [
    '',
    '## Before you write: realism check (keep it to yourself, do not put it in the JSON)',
    '- Forces: name the strongest pressure toward escalation and the strongest toward settlement, each tied to a real actor with the means to act. The stronger side wins; if they are close, that is a reason to branch.',
    '- Base rate: what did comparable real situations actually do over the span you cover? Start from that, not from what feels hopeful or dramatic.',
    '- A settlement must show who forced it, with what leverage, and why each side accepts it now. Wars rarely stop at their first heavy blow; they end through exhaustion, a decisive result, a change of leadership, or outside pressure with real teeth.',
    '- An escalation needs means and motive just the same: no war that nobody would fight.',
    ...(settled.length
      ? [
          `- Settlements already in this timeline (newest first): ${settled.map((n) => `"${n.title}" (${n.period || 'no date'})`).join('; ')}. ` +
            'Do not reach for the same kind of fix (the same mediator, the same deal) unless the story truly earns it.',
        ]
      : []),
  ];
}

const STRENGTH_MEANING: Record<Strength, string> = {
  mild: 'it nudges this stream',
  moderate: 'it clearly shapes this stream',
  strong: 'it largely drives what happens next here',
};

const timeSpanLine = (job: Job) =>
  `Requested time span: ${job.timeSpan?.trim() || 'not specified. Choose the span that best fits the next meaningful development.'}`;

/**
 * A REVIEW brief: the storyline up to the node (sharing the cacheable prefix with writing jobs on the same
 * branch), the node in full, what other streams fed into it, and the checklist. No nearby events, no
 * search: a review judges what was written, so it stays a fraction of a writing job's cost.
 */
/** Chain entries before the reviewed node that keep their summary (the rest show key changes, the record a review checks against). */
const REVIEW_SUMMARY_DEPTH = 3;

function reviewSections(
  job: Job,
  tl: Timeline,
  mode: BriefMode,
  storyline: (chain: TLNode[], summaries?: number, full?: number) => string,
): string[] {
  const node = tl.nodes[job.targetNodeId];
  const chain = pathTo(tl, node.id).slice(0, -1);
  const incoming = tl.links.filter((l) => l.to === node.id && tl.nodes[l.from]);
  const outFile = `worker/out/${job.id}.json`;
  return [
    `# Job ${job.id}: REVIEW`,
    `Task: check ONE event for plausibility. You do not rewrite it; you judge it and say what a rewrite should fix.`,
    '',
    '## Timeline up to the event (oldest first)',
    storyline(chain, REVIEW_SUMMARY_DEPTH, 0),
    '',
    `## The event to review (node ${chain.length + 1})`,
    describeNode(tl, node, chain.length, 'full'),
    ...(incoming.length
      ? [
          '',
          '## What other streams fed into it',
          ...incoming.map((l) => {
            const f = tl.nodes[l.from];
            return `- ${short(f)} --${l.strength}--> this event${l.note ? `: ${l.note}` : ''}\n  ${firstSentence(f.summary)}`;
          }),
        ]
      : []),
    '',
    '## What to check',
    '- contradiction: it conflicts with an earlier event, its key changes, or a user edit (those are canon).',
    '- anachronism: people, technology, institutions or terms that cannot exist at that time in this world.',
    '- unearned: an outcome (a deal, a rescue, a collapse, a war) with no actor who had the means and motive to cause it.',
    '- causality: it does not follow from what came before, or skips a step the story needs.',
    '- scale: numbers, speed or reach out of proportion (casualties, money, distances, how fast things happen).',
    'Judge by this world\'s history above, real-world constraints and what comparable real situations did. ' +
      'Flag only real problems, most serious first; style, tone and taste are not problems. A surprising outcome with a clear cause is plausible.',
    '',
    '## Your response',
    mode === 'api'
      ? 'Reply with ONLY one JSON object of this shape: no other text, no code fences.'
      : `Write JSON to \`${outFile}\` with this shape, then run \`node worker/submit.mjs ${job.id}\`:`,
    '```json',
    '{ "verdict": "plausible", "summary": "", "flags": [ { "kind": "unearned", "text": "", "fix": "" } ] }',
    '```',
    '- verdict: "plausible" (no real problem; flags may be empty, or at most 2 minor notes), "questionable" (real problems a rewrite should fix), ' +
      '"implausible" (the core of the event does not hold up).',
    '- summary: 1-2 sentences, the overall judgment. flags: at most 5, each pointing at the specific claim ("text") and how to fix it ("fix").',
    '- kind: contradiction | anachronism | unearned | causality | scale | other.',
  ];
}

export function buildBrief(job: Job, tl: Timeline, mode: BriefMode = 'worker'): string {
  const { prefix, body } = buildBriefParts(job, tl, mode);
  return prefix ? `${prefix}\n\n---\n\n${body}` : body;
}

/**
 * The brief in two parts. `prefix` (may be empty) holds only what is the same for every job further along
 * this storyline, so a caching API reuses it across jobs: the runner sends it as its own block. `body` is
 * everything specific to this job.
 */
export function buildBriefParts(job: Job, tl: Timeline, mode: BriefMode = 'worker'): { prefix: string; body: string } {
  const parts: string[] = [];
  let prefix = '';
  /** The primary storyline: its oldest nodes go into the prefix, the rest stay here (numbered on). */
  /**
   * `summaries` and `full`: how many of the last nodes show their summary, and their full narrative. A writer
   * needs the defaults; a review (which checks one node against the record) needs less.
   */
  const storyline = (chain: TLNode[], summaries = SUMMARY_DEPTH, full = FULL_NARRATIVE_DEPTH) => {
    const k = archiveSize(chain.length);
    if (k) prefix = archiveSection(tl, chain.slice(0, k));
    return [
      ...(k ? [`(Entries 1-${k} are in "Earlier history" above.)`, ''] : []),
      // Same detail as without a prefix: nodes between the archive and the last `summaries` stay compact.
      chainSection(tl, chain.slice(k), k, Math.max(0, chain.length - summaries - k), full),
    ].join('\n');
  };

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
      temperamentLine(job),
      narrativeFormatLine(job),
      `User guidance: ${job.guidance?.trim() || 'none'}`,
      '',
      '## Timeline so far (oldest first, the last entry is the node you continue from)',
      storyline(chain),
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
      temperamentLine(job),
      narrativeFormatLine(job),
      `User guidance: ${job.guidance?.trim() || 'none'}`,
      '',
      '## Branch A: the full timeline from the point of divergence (oldest first)',
      storyline(chain),
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
      temperamentLine(job),
      narrativeFormatLine(job),
      job.followUpDepth
        ? `Guidance from the writer who requested this follow-up: ${job.guidance?.trim() || 'none'}`
        : `User guidance: ${job.guidance?.trim() || 'none'}`,
      '',
      `## This stream so far ("${streamLabel(tl, target.id)}", oldest first, the last entry is the node you continue from)`,
      storyline(chain),
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
  } else if (job.type === 'review') {
    parts.push(...reviewSections(job, tl, mode, storyline));
  } else {
    const target = tl.nodes[job.targetNodeId];
    const chain = pathTo(tl, job.targetNodeId).slice(0, -1);
    parts.push(
      `# Job ${job.id}: REGENERATE`,
      `Timeline: "${tl.title}"`,
      'Task: an earlier node was edited, so this node is out of date. Rewrite it so it follows from the timeline below.',
      `Keep roughly the same time period (${target.period || 'unspecified'}) unless the changes make that impossible.`,
      `User guidance: ${job.guidance?.trim() || 'none'}`,
      temperamentLine(job),
      narrativeFormatLine(job),
      '',
      `## ${target.mergeParents?.length ? 'Branch A: timeline' : 'Timeline'} up to this node (oldest first)`,
      storyline(chain),
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
      describeNode(tl, target, chain.length, 'full'),
      ...threadContext(tl, [...chain, target], target, new Set([target.id])),
      ...responseSection(job, tl, 'node', mode),
    );
  }
  return { prefix, body: parts.join('\n') };
}
