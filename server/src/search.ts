// Keyword search the worker runs while writing a job (worker/search.mjs), to find events in other streams
// that may influence the node, however old. Output is plain text sized for a model's context: events older
// than the influence window show only their key changes, which is what an old event leaves behind.
import type { Job, Timeline, TLNode } from '../../shared/types.ts';
import { INFLUENCE_WINDOW_YEARS, startYear, streamLabel } from '../../shared/world.ts';
import { jobScope, linkCandidates, type Candidate } from './brief.ts';

export const SEARCH_DEFAULT_LIMIT = 6;
export const SEARCH_MAX_LIMIT = 12;

const STOPWORDS = new Set(
  'the and for with from into that this then than over under after before about between during their there were was are has have had its not but who whom which what when where why how all any new old'.split(
    ' ',
  ),
);

/** Lowercase words of 3+ letters (or any number), minus common words. */
function terms(q: string): string[] {
  return [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOPWORDS.has(w));
}

/** Weighted hits: title and key changes count most, the narrative least. Prefix matches count ("nuclear" finds "nuclear-armed"). */
function score(n: TLNode, words: string[]): number {
  const fields: [string, number][] = [
    [n.title, 4],
    [n.keyChanges.join(' '), 3],
    [n.summary, 2],
    [n.narrative, 1],
    [n.threadName ?? '', 2],
  ];
  let total = 0;
  let matched = 0;
  for (const w of words) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu');
    let hit = 0;
    for (const [text, weight] of fields) if (re.test(text)) hit += weight;
    if (hit) matched++;
    total += hit;
  }
  // Nodes matching more of the query words rank first.
  return matched ? matched * 100 + total : 0;
}

const when = (gap: number | null) => (gap === null ? 'undated' : gap === 0 ? 'same year' : gap < 0 ? `${-gap}y earlier` : `${gap}y later`);

function formatHit(tl: Timeline, { node, gap }: Candidate): string {
  const head = `- [${streamLabel(tl, node.id)}, ${when(gap)}] "${node.title}" (${node.period || 'no date'}) [id: ${node.id}]`;
  // An old event matters through what it changed; its summary and narrative are detail.
  if (gap !== null && gap < -INFLUENCE_WINDOW_YEARS) return `${head}\n  Key changes: ${node.keyChanges.join('; ') || '(none)'}`;
  return `${head}\n  ${node.summary}`;
}

export interface SearchOptions {
  query: string;
  /** Only events starting before / after this year. */
  before?: number;
  after?: number;
  limit?: number;
}

export function searchForJob(tl: Timeline, job: Job, opts: SearchOptions): string {
  const scope = jobScope(tl, job);
  if (!scope) return 'NO_RESULTS the node for this job no longer exists';
  const words = terms(opts.query);
  const limit = Math.min(Math.max(1, opts.limit ?? SEARCH_DEFAULT_LIMIT), SEARCH_MAX_LIMIT);
  const pool = linkCandidates(tl, scope.anchor, scope.exclude, scope.anchorYear).filter(({ node }) => {
    const y = startYear(node);
    if (opts.before !== undefined && (y === null || y >= opts.before)) return false;
    if (opts.after !== undefined && (y === null || y <= opts.after)) return false;
    return true;
  });
  const ranked = (
    words.length
      ? pool.map((c) => ({ c, s: score(c.node, words) })).filter((x) => x.s > 0)
      : pool.map((c) => ({ c, s: 0 })) // filters only: newest first
  ).sort((a, b) => b.s - a.s || (startYear(b.c.node) ?? -Infinity) - (startYear(a.c.node) ?? -Infinity));

  const filters = [opts.before !== undefined && `before ${opts.before}`, opts.after !== undefined && `after ${opts.after}`].filter(Boolean);
  const label = `"${opts.query}"${filters.length ? ` (${filters.join(', ')})` : ''}`;
  if (!ranked.length) {
    return `NO_RESULTS for ${label} among ${pool.length} linkable events. Try fewer or different keywords.`;
  }
  const shown = ranked.slice(0, limit);
  return [
    `RESULTS for ${label}: ${shown.length} of ${ranked.length} matches (anchor year ${scope.anchorYear ?? 'unknown'})`,
    ...shown.map((x) => formatHit(tl, x.c)),
  ].join('\n');
}

/** One event in full, for when a search hit looks relevant but its key changes are not enough. */
export function showNode(tl: Timeline, id: string): string {
  const n = tl.nodes[id];
  if (!n) return `NOT_FOUND no node ${id} in this timeline`;
  return [
    `NODE "${n.title}" (${n.period || 'no date'}) [id: ${n.id}] in stream "${streamLabel(tl, n.id)}"`,
    n.summary,
    `Key changes: ${n.keyChanges.join('; ') || '(none)'}`,
    '',
    n.narrative,
  ].join('\n');
}
