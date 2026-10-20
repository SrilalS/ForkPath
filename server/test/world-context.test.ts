// What a writer sees of other streams: the nearby list's ranking, the "State of the world" section, and the
// confidence rating that decides plausibility reviews in "auto" mode.
// Run: npm test (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Job, Timeline, TLNode } from '../../shared/types.ts';
import { buildBrief, nearbyEvents, worldState } from '../src/brief.ts';
import { continueResult, regenerateResult } from '../src/schema.ts';
import { applyContinue, continueIssues, regenerateIssues, reviewReasonFor } from '../src/apply.ts';

let clock = 0;
function node(id: string, parentId: string | null, period: string, extra: Partial<TLNode> = {}): TLNode {
  const at = new Date(Date.UTC(2020, 0, 1, 0, 0, clock++)).toISOString();
  return {
    id, parentId, period,
    kind: parentId ? 'event' : 'deviation',
    source: 'llm', status: 'ready', stale: false,
    title: id, summary: `${id} happens.`, narrative: '', keyChanges: [`${id} change one`, `${id} change two`],
    significance: 'notable', tone: 'neutral',
    createdAt: at, updatedAt: at,
    ...extra,
  };
}

const world = (nodes: TLNode[]): Timeline => ({
  schemaVersion: 8, id: 't', title: 't', rootId: 'root', nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), links: [], createdAt: '', updatedAt: '',
});

/**
 * root (1900) -> main (1950, the node being continued).
 * Thread "Side" from root: side1 (1905, MAJOR) -> side2 (1940).
 * Thread "Fork" from root: fork (1902) with two exclusive alternatives, likely (70%) and unlikely (30%).
 */
function busyWorld() {
  return world([
    node('root', null, '1900'),
    node('main', 'root', '1950'),
    node('side', 'root', '1901', { threadName: 'Side' }),
    node('side1', 'side', '1905', { significance: 'major', keyChanges: ['The old war ends', 'A border moves'] }),
    node('side2', 'side1', '1940'),
    node('fork', 'root', '1902', { threadName: 'Fork' }),
    node('likely', 'fork', '1910', { likelihood: 0.7 }),
    node('unlikely', 'fork', '1910', { likelihood: 0.3 }),
  ]);
}

test('nearby: a major event a decade away beats same-year minor events', () => {
  const minors = Array.from({ length: 9 }, (_, i) => node(`m${i}`, i ? `m${i - 1}` : 'x', '1950', { significance: 'minor' }));
  const tl = world([
    node('root', null, '1900'),
    node('main', 'root', '1950'),
    node('x', 'root', '1949', { threadName: 'Busy', significance: 'minor' }),
    ...minors,
    node('big', 'root', '1940', { threadName: 'Other', significance: 'major' }),
  ]);
  const ids = nearbyEvents(tl, tl.nodes.main, new Set(), 1950).map((c) => c.node.id);
  assert.equal(ids.length, 8);
  assert.ok(ids.includes('big'), 'the major event is listed');
  assert.equal(ids.at(-1), 'big', 'and still listed closest first');
});

test('world state: every stream where it stands, old turning points, one consistent outcome per fork', () => {
  const tl = busyWorld();
  const { states, turning, dropped } = worldState(tl, tl.nodes.main, new Set(), 1950, new Set());
  assert.deepEqual(states.map((c) => c.node.id).sort(), ['likely', 'side2']);
  assert.deepEqual(turning.map((c) => c.node.id), ['side1'], 'a major event 45 years back is listed');
  assert.equal(dropped, 1, 'the less likely alternative is left out');
});

test('world state: nothing from the future, and nothing the nearby list already shows', () => {
  const tl = busyWorld();
  tl.nodes.later = node('later', 'side2', '1955', { significance: 'pivotal' });
  const shown = new Set(nearbyEvents(tl, tl.nodes.main, new Set(), 1950).map((c) => c.node.id));
  const { states, turning } = worldState(tl, tl.nodes.main, new Set(), 1950, shown);
  const listed = [...states, ...turning].map((c) => c.node.id);
  assert.ok(!listed.includes('later'), 'starts after the new node');
  for (const id of listed) assert.ok(!shown.has(id), `${id} is not repeated`);
});

test('the brief has the world state section, with the old major event and its key changes', () => {
  const tl = busyWorld();
  const job = { id: 'j', type: 'continue', timelineId: 't', targetNodeId: 'main', status: 'claimed', createdAt: '' } as Job;
  const brief = buildBrief(job, tl);
  assert.match(brief, /## State of the world in 1950/);
  assert.match(brief, /"side1" \(1905\) \[id: side1\]: The old war ends; A border moves/);
  assert.match(brief, /less likely alternative/);
  assert.doesNotMatch(brief, /"confidence"/, 'confidence is only asked for in auto mode');
  assert.match(buildBrief({ ...job, review: 'auto' }, tl), /EVERY node you write needs "confidence"/);
});

const child = (extra: Record<string, unknown> = {}) => ({
  title: 'Next', period: '1951', summary: 's', narrative: 'n', keyChanges: ['x', 'y', 'z'], significance: 'notable', tone: 'neutral', ...extra,
});
const job = (extra: Partial<Job> = {}) => ({ id: 'j', type: 'continue', timelineId: 't', targetNodeId: 'main', status: 'claimed', createdAt: '', ...extra }) as Job;

test('auto review: confidence is required, and a doubt unless it is high', () => {
  const tl = busyWorld();
  const check = (c: Record<string, unknown>, review?: Job['review']) => continueIssues(tl, job({ review }), continueResult.parse({ children: [child(c)] }), 1).join();
  assert.equal(check({}), '', 'not asked for outside auto mode');
  assert.match(check({}, 'auto'), /add "confidence"/);
  assert.match(check({ confidence: 'medium' }, 'auto'), /add "doubt"/);
  assert.equal(check({ confidence: 'high' }, 'auto'), '');
  assert.equal(check({ confidence: 'low', doubt: 'the numbers' }, 'auto'), '');
  const regen = regenerateResult.parse({ node: child({ period: '1950' }) });
  assert.match(regenerateIssues(tl, tl.nodes.main, regen, 'auto').join(), /add "confidence"/);
});

test('auto review: low, or medium on a major event, gets a review', () => {
  const r = (extra: Record<string, unknown>) => reviewReasonFor(child(extra) as Parameters<typeof reviewReasonFor>[0]);
  assert.equal(r({ confidence: 'high' }), undefined);
  assert.equal(r({ confidence: 'medium', doubt: 'd' }), undefined, 'medium on a notable event is fine');
  assert.match(r({ confidence: 'medium', doubt: 'the treaty terms', significance: 'major' })!, /medium on a major event: the treaty terms/);
  assert.match(r({ confidence: 'low', doubt: 'casualties' })!, /low: casualties/);
  assert.equal(r({ confidence: 'high', requestReview: 'asked anyway' }), 'asked anyway');

  const report = applyContinue(busyWorld(), job({ review: 'auto' }), continueResult.parse({
    children: [child({ confidence: 'low', doubt: 'why', spawnThreads: [{ thread: 'T', ...child({ confidence: 'high' }) }] })],
  }));
  assert.deepEqual(report.created.map((c) => !!c.reviewReason), [true, false]);
});
