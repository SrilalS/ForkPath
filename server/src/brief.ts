import type { Job, Timeline, TLNode } from '../../shared/types.ts';
import { childrenOf, pathTo } from './store.ts';

/** Ancestors this close to the target get their full narrative; older ones only the summary. */
const FULL_NARRATIVE_DEPTH = 3;

const FIELD_HINT =
  'significance: minor | notable | major | pivotal. tone: neutral | conflict | catastrophe | upheaval | decline | prosperity | discovery | diplomacy.';

function describeNode(tl: Timeline, n: TLNode, index: number, full: boolean): string {
  const tags: string[] = [];
  if (n.kind === 'deviation') tags.push(index === 0 ? 'POINT OF DIVERGENCE' : 'NEW USER DEVIATION');
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

function responseSection(job: Job, shape: 'children' | 'node'): string[] {
  const outFile = `worker/out/${job.id}.json`;
  const example =
    shape === 'children'
      ? '{ "children": [ { "title": "", "period": "", "summary": "", "narrative": "", "keyChanges": [""], "significance": "notable", "tone": "neutral", "likelihood": 1 } ], "branchReason": "" }'
      : '{ "node": { "title": "", "period": "", "summary": "", "narrative": "", "keyChanges": [""], "significance": "notable", "tone": "neutral" } }';
  return [
    '',
    '## Your response',
    `Write JSON to \`${outFile}\` with this shape, then run \`node worker/submit.mjs ${job.id}\`:`,
    '```json',
    example,
    '```',
    FIELD_HINT,
    shape === 'children'
      ? 'One child normally. 2-4 children only when outcomes are genuinely uncertain (see WORKER.md); then include likelihoods and branchReason.'
      : 'Regenerate never branches: return exactly one node.',
  ];
}

const timeSpanLine = (job: Job) =>
  `Requested time span: ${job.timeSpan?.trim() || 'not specified. Choose the span that best fits the next meaningful development.'}`;

export function buildBrief(job: Job, tl: Timeline): string {
  const parts: string[] = [];

  if (job.type === 'continue') {
    const chain = pathTo(tl, job.targetNodeId);
    const siblings = childrenOf(tl, job.targetNodeId).filter(
      (c) => c.id !== job.placeholderId && c.status === 'ready' && c.parentId === job.targetNodeId,
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
    parts.push(...responseSection(job, 'children'));
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
      ...responseSection(job, 'node'),
    );
  }
  return parts.join('\n');
}
