import type { Job, Timeline, TLNode } from '../../shared/types.ts';
import { ancestorIds, sameWorld, threadLabel, threadRootOf } from '../../shared/world.ts';
import { parsePeriodStart } from '../../shared/time.ts';
import { childrenOf, pathTo } from './store.ts';

/** Ancestors this close to the target get their full narrative; older ones only the summary. */
const FULL_NARRATIVE_DEPTH = 3;
/** At most this many other threads are summarized, the most recent first. */
const MAX_OTHER_THREADS = 8;

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

const short = (n: TLNode) => `"${n.title}" (${n.period || 'no date'}) [id: ${n.id}]`;

/**
 * Influence links touching the storyline (any node in `chain`), and the latest state of every other thread
 * that coexists with `anchor` in one world, up to anchor's date.
 */
function threadContext(tl: Timeline, chain: TLNode[], anchor: TLNode, exclude: Set<string>): string[] {
  const out: string[] = [];
  const inChain = new Set(chain.map((n) => n.id));

  const links = tl.links.filter((l) => (inChain.has(l.from) || inChain.has(l.to)) && tl.nodes[l.from] && tl.nodes[l.to]);
  if (links.length) {
    out.push('', '## Influence links touching this storyline');
    for (const l of links) {
      const f = tl.nodes[l.from];
      const t = tl.nodes[l.to];
      out.push(
        `- ${short(f)} in thread "${threadLabel(tl, threadRootOf(tl, f.id))}" --${l.strength}--> ${short(t)}${l.note ? `: ${l.note}` : ''}`,
      );
      // The far end of an incoming link is outside this chain, so give its content.
      if (!inChain.has(f.id)) out.push(`  ${f.summary}`);
    }
  }

  const ownThread = threadRootOf(tl, anchor.id);
  const anchorDate = parsePeriodStart(anchor.period);
  const upstream = ancestorIds(tl, anchor.id);
  const latest = new Map<string, { node: TLNode; date: number }>();
  for (const n of Object.values(tl.nodes)) {
    if (n.status !== 'ready' || exclude.has(n.id) || inChain.has(n.id) || upstream.has(n.id)) continue;
    const thread = threadRootOf(tl, n.id);
    if (thread === ownThread) continue;
    const date = parsePeriodStart(n.period) ?? -Infinity;
    if (anchorDate !== null && date > anchorDate + 1) continue; // not yet happened at this point
    if (!sameWorld(tl, n.id, anchor.id)) continue;
    const cur = latest.get(thread);
    if (!cur || date > cur.date || (date === cur.date && n.createdAt > cur.node.createdAt)) latest.set(thread, { node: n, date });
  }
  const threads = [...latest.entries()].sort((a, b) => b[1].date - a[1].date).slice(0, MAX_OTHER_THREADS);
  if (threads.length) {
    out.push(
      '',
      '## Other threads in this world (latest known event in each, for awareness)',
      'These run in parallel with this storyline. Reflect them where relevant and link to them when there is a real effect.',
    );
    for (const [root, { node }] of threads) {
      out.push(`- Thread "${threadLabel(tl, root)}": ${short(node)}: ${node.summary}`);
      if (node.keyChanges.length) out.push(`  Key changes: ${node.keyChanges.join('; ')}`);
    }
  }
  return out;
}

function responseSection(job: Job, shape: 'children' | 'node'): string[] {
  const outFile = `worker/out/${job.id}.json`;
  const linkHint =
    'Optional on any node you write: "influences" / "influencedBy": [ { "node": "<existing id or @key>", "strength": "mild", "note": "" } ]. ' +
    'Give a node "key": "india" so other nodes in this same result can link to it as "@india".';
  const node = '"title": "", "period": "", "summary": "", "narrative": "", "keyChanges": [""], "significance": "notable", "tone": "neutral"';
  const example =
    shape === 'children'
      ? `{ "children": [ { ${node}, "likelihood": 1, "influences": [], "influencedBy": [], "spawnThreads": [] } ], "branchReason": "", "threads": [] }`
      : `{ "node": { ${node}, "influences": [], "influencedBy": [] } }`;
  const lines = [
    '',
    '## Your response',
    `Write JSON to \`${outFile}\` with this shape, then run \`node worker/submit.mjs ${job.id}\`:`,
    '```json',
    example,
    '```',
    FIELD_HINT,
    linkHint,
  ];
  if (shape === 'node') return [...lines, 'Regenerate never branches: return exactly one node.'];
  return [
    ...lines,
    'Pick the structure (details in WORKER.md "4b"):',
    '- "children": ALTERNATIVES, only one happens. One child normally; 2-4 only when outcomes are genuinely uncertain, then add likelihoods and branchReason.',
    '- "threads" (top level): PARALLEL storylines that ALL happen, starting from this node, each { "thread": "<name>", "key": "...", ...node fields }. ' +
      'Use these when the user asks for separate branches/streams by region or topic that run at the same time; link them to each other with "@key".',
    '- "spawnThreads" (inside a child): a parallel storyline set off BY that child. Usually none.',
    'You may combine them (e.g. no children and two threads), but give at least one child or one thread.',
  ];
}

const timeSpanLine = (job: Job) =>
  `Requested time span: ${job.timeSpan?.trim() || 'not specified. Choose the span that best fits the next meaningful development.'}`;

export function buildBrief(job: Job, tl: Timeline): string {
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
      `You are writing in thread "${threadLabel(tl, threadRootOf(tl, target.id))}".`,
      ...threadContext(tl, chain, target, new Set([job.placeholderId ?? ''])),
      ...responseSection(job, 'children'),
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
      ),
      ...responseSection(job, 'children'),
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
      ...responseSection(job, 'node'),
    );
  }
  return parts.join('\n');
}
