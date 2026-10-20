// Result validation: the schema's strict shapes and rules, and the timeline-aware checks in apply.ts.
// Run: npm test (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Job, Timeline, TLNode } from '../../shared/types.ts';
import { continueResult, regenerateResult, reviewResult } from '../src/schema.ts';
import { applyContinue, continueIssues, regenerateIssues } from '../src/apply.ts';

let clock = 0;
function node(id: string, parentId: string | null, period: string, extra: Partial<TLNode> = {}): TLNode {
  const at = new Date(Date.UTC(2020, 0, 1, 0, 0, clock++)).toISOString();
  return {
    id, parentId, period,
    kind: parentId ? 'event' : 'deviation',
    source: 'llm', status: 'ready', stale: false,
    title: id, summary: '', narrative: '', keyChanges: [],
    significance: 'notable', tone: 'neutral',
    createdAt: at, updatedAt: at,
    ...extra,
  };
}

/** root (1900) -> a (1905) -> ph (placeholder); a thread "s" from root with tip s1 (1906). */
function world(): Timeline {
  const nodes = [
    node('root', null, '1900'),
    node('a', 'root', '1905'),
    node('ph', 'a', '', { status: 'generating' }),
    node('s', 'root', '1901', { threadName: 'Side' }),
    node('s1', 's', '1906'),
  ];
  return { schemaVersion: 6, id: 't', title: 't', rootId: 'root', nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), links: [], createdAt: '', updatedAt: '' };
}

const job = (extra: Partial<Job> = {}) =>
  ({ id: 'j', type: 'continue', timelineId: 't', targetNodeId: 'a', placeholderId: 'ph', status: 'claimed', createdAt: '', ...extra }) as Job;

const child = (extra: Record<string, unknown> = {}) => ({
  title: 'Next', period: '1907', summary: 's', narrative: 'n', keyChanges: ['x', 'y', 'z'], significance: 'notable', tone: 'neutral', ...extra,
});

const parse = (body: unknown) => continueResult.safeParse(body);
const messages = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map((i) => i.message));

test('schema: unknown fields are invalid', () => {
  assert.equal(parse({ children: [child({ influenced_by: [] })] }).success, false);
  assert.equal(parse({ children: [child()], extra: 1 }).success, false);
  assert.equal(regenerateResult.safeParse({ node: { ...child(), likelihood: 0.5 } }).success, false);
  assert.equal(parse({ children: [child()] }).success, true);
});

test('schema: no follow-ups when branching, and no dominant alternative', () => {
  const f = { target: 's1', strength: 'mild', guidance: 'g' };
  const branch = (a: number, b: number, extra = {}) => ({
    branchReason: 'r',
    children: [child({ likelihood: a, ...extra }), child({ title: 'Other', likelihood: b })],
  });
  assert.match(messages(parse(branch(0.5, 0.5, { followUps: [f] }))).join(), /not allowed when branching/);
  assert.match(messages(parse(branch(0.8, 0.2))).join(), /clearly dominates/);
  assert.equal(parse(branch(0.6, 0.4)).success, true);
  assert.equal(parse({ children: [child({ followUps: [f] })] }).success, true, 'a single child may request follow-ups');
});

test('continueIssues: undated periods, broken refs, follow-up targets, influence note', () => {
  const tl = world();
  const check = (body: unknown, j = job()) => continueIssues(tl, j, continueResult.parse(body), 1);
  assert.deepEqual(check({ children: [child()] }), []);
  assert.match(check({ children: [child({ period: 'The following winter' })] }).join(), /no readable year/);
  assert.match(check({ children: [child({ influencedBy: [{ node: 'nope', strength: 'mild' }] })] }).join(), /no event has that id/);
  assert.match(check({ children: [child({ influences: [{ node: '@ghost', strength: 'mild' }] })] }).join(), /no node in this result has that key/);
  assert.match(check({ children: [child({ followUps: [{ target: 's', strength: 'mild', guidance: 'g' }] })] }).join(), /not the latest event/);
  assert.deepEqual(check({ children: [child({ followUps: [{ target: 's1', strength: 'mild', guidance: 'g' }] })] }), []);
  assert.match(
    check({ children: [child({ followUps: [{ target: 's1', strength: 'mild', guidance: 'g' }] })] }, job({ followUpDepth: 1 })).join(),
    /itself a follow-up/,
  );
  assert.match(check({ children: [child()] }, job({ type: 'influence', influenceFrom: 's1' })).join(), /influenceNote is required/);
  assert.match(check({ children: [child({ period: '1903' })] }).join(), /starts before/);
});

test('regenerateIssues: may not start after its own next event, unless that one is stale', () => {
  const tl = world();
  const later = { node: child({ period: '1910' }) };
  // a's child ph is still generating; give it a ready child dated 1908.
  tl.nodes.b = node('b', 'a', '1908');
  assert.match(regenerateIssues(tl, tl.nodes.a, regenerateResult.parse(later)).join(), /starts after "b"/);
  tl.nodes.b.stale = true;
  assert.deepEqual(regenerateIssues(tl, tl.nodes.a, regenerateResult.parse(later)), []);
});

test('apply: alternatives sorted by likelihood, repeated stream name ignored', () => {
  const tl = world();
  tl.nodes.a.streamName = 'Main story';
  const r = continueResult.parse({
    branchReason: 'r',
    children: [child({ title: 'Less', likelihood: 0.4, streamName: 'main STORY' }), child({ title: 'More', likelihood: 0.6, streamName: 'New focus' })],
  });
  const report = applyContinue(tl, job(), r);
  assert.deepEqual(report.created.map((c) => c.title), ['More', 'Less']);
  const byTitle = (t: string) => Object.values(tl.nodes).find((n) => n.title === t)!;
  assert.equal(byTitle('More').streamName, 'New focus');
  assert.equal(byTitle('Less').streamName, undefined);
});

test('reviewResult: a problem verdict needs a flag; unknown fields are invalid', () => {
  const flag = { kind: 'unearned', text: 't', fix: 'f' };
  assert.equal(reviewResult.safeParse({ verdict: 'plausible', summary: 's' }).success, true);
  assert.equal(reviewResult.safeParse({ verdict: 'questionable', summary: 's', flags: [] }).success, false);
  assert.equal(reviewResult.safeParse({ verdict: 'implausible', summary: 's', flags: [flag] }).success, true);
  assert.equal(reviewResult.safeParse({ verdict: 'plausible', summary: 's', score: 3 }).success, false);
  assert.equal(reviewResult.safeParse({ verdict: 'questionable', summary: 's', flags: [{ ...flag, kind: 'vibes' }] }).success, false);
});

test('requestReview is accepted on children and thread starts', () => {
  const r = continueResult.parse({
    children: [child({ requestReview: 'casualty numbers are a guess', spawnThreads: [{ thread: 'T', ...child({ requestReview: 'why' }) }] })],
  });
  const report = applyContinue(world(), job({ review: 'auto' }), r);
  assert.deepEqual(report.created.map((c) => c.reviewReason), ['casualty numbers are a guess', 'why']);
});
