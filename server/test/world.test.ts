// Path odds and the most likely history (shared/world.ts).
// Run: npm test (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Timeline, TLNode } from '../../shared/types.ts';
import { WorldIndex } from '../../shared/world.ts';

const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} != ${b}`);

let clock = 0;
function node(id: string, parentId: string | null, extra: Partial<TLNode> = {}): TLNode {
  const at = new Date(Date.UTC(2020, 0, 1, 0, 0, clock++)).toISOString();
  return {
    id,
    parentId,
    kind: parentId ? 'event' : 'deviation',
    source: 'llm',
    status: 'ready',
    stale: false,
    title: id,
    period: '1900',
    summary: '',
    narrative: '',
    keyChanges: [],
    significance: 'notable',
    tone: 'neutral',
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

function timeline(nodes: TLNode[]): Timeline {
  return {
    schemaVersion: 6,
    id: 't',
    title: 't',
    rootId: nodes[0].id,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    links: [],
    createdAt: '',
    updatedAt: '',
  };
}

// root -> a (60%) | b (40%); a -> a1 (30%) | a2 (50%) (numbers do not add up); a2 -> a2x; a thread off root.
const tl = timeline([
  node('root', null),
  node('a', 'root', { likelihood: 0.6 }),
  node('b', 'root', { likelihood: 0.4 }),
  node('a1', 'a', { likelihood: 0.3 }),
  node('a2', 'a', { likelihood: 0.5 }),
  node('a2x', 'a2'),
  node('th', 'root', { threadName: 'Side', likelihood: 0.9 }),
]);

test('fork shares are normalized per fork', () => {
  const ix = new WorldIndex(tl);
  near(ix.forkShare(tl.nodes.a), 0.6);
  near(ix.forkShare(tl.nodes.a1), 0.375);
  near(ix.forkShare(tl.nodes.a2), 0.625);
});

test('path odds multiply the forks on the way', () => {
  const ix = new WorldIndex(tl);
  near(ix.pathOdds('root'), 1);
  near(ix.pathOdds('b'), 0.4);
  near(ix.pathOdds('a2x'), 0.6 * 0.625);
  near(ix.pathOdds('th'), 1, 'a thread is not an alternative');
});

test('most likely history follows each fork favorite', () => {
  const ix = new WorldIndex(tl);
  assert.deepEqual(
    Object.keys(tl.nodes).filter((id) => ix.inMostLikely(id)),
    ['root', 'a', 'a2', 'a2x', 'th'],
  );
  assert.deepEqual(ix.forks().map((n) => n.id).sort(), ['a', 'root']);
});

test('canLink and canInfluence: path rules hold with the cached ancestor and descendant sets', () => {
  const ix = new WorldIndex(tl);
  assert.equal(ix.canLink('root', 'a2x').ok, false, 'a2x already follows from root');
  assert.equal(ix.canLink('a2x', 'a').ok, false, 'a comes before a2x on the same path');
  assert.equal(ix.canLink('th', 'a2x').ok, true, 'a thread can shape another stream');
  assert.equal(ix.canLink('b', 'a2x').ok, false, 'different alternatives are different worlds');
  assert.equal(ix.canInfluence('a2', 'a').ok, false, 'a is earlier in the same stream');
  assert.equal(ix.canInfluence('root', 'a2x').ok, false, 'a2x already follows from root');
  assert.equal(ix.canInfluence('th', 'a2x').ok, true);
  // Asking twice gives the same answer (the sets are memoized per index).
  assert.equal(ix.canInfluence('th', 'a2x').ok, true);
});

test('a convergence counts each fork once', () => {
  const t2 = timeline([
    node('r', null),
    node('x', 'r', { likelihood: 0.5 }),
    node('y', 'r', { likelihood: 0.5 }),
    node('s', 'x', { threadName: 'S' }),
    node('m', 'x', { mergeParents: ['s'] }),
  ]);
  near(new WorldIndex(t2).pathOdds('m'), 0.5);
});
