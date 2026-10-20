// The brief's cacheable prefix: identical for consecutive jobs along one storyline.
// Run: npm test (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Job, Timeline, TLNode } from '../../shared/types.ts';
import { buildBrief, buildBriefParts } from '../src/brief.ts';

let clock = 0;
function node(id: string, parentId: string | null, year: number): TLNode {
  const at = new Date(Date.UTC(2020, 0, 1, 0, 0, clock++)).toISOString();
  return {
    id, parentId, period: String(year),
    kind: parentId ? 'event' : 'deviation',
    source: 'llm', status: 'ready', stale: false,
    title: `Event ${id}`, summary: `Summary of ${id}.`, narrative: `Narrative of ${id}.`, keyChanges: [`change ${id}`],
    significance: 'notable', tone: 'neutral',
    createdAt: at, updatedAt: at,
  };
}

/** A single storyline n0 -> n1 -> ... of `len` nodes. */
function line(len: number): Timeline {
  const nodes = Array.from({ length: len }, (_, i) => node(`n${i}`, i ? `n${i - 1}` : null, 1900 + i));
  return { schemaVersion: 6, id: 't', title: 'Line', rootId: 'n0', nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), links: [], createdAt: '', updatedAt: '' };
}

const cont = (target: string) =>
  ({ id: `job-${target}`, type: 'continue', timelineId: 't', targetNodeId: target, placeholderId: 'ph', status: 'claimed', createdAt: '' }) as Job;

test('short storylines have no prefix', () => {
  const tl = line(10);
  assert.equal(buildBriefParts(cont('n9'), tl, 'api').prefix, '');
});

test('the prefix stays byte-identical for consecutive jobs, then grows in steps', () => {
  const tl = line(30);
  const prefixAt = (len: number) => buildBriefParts(cont(`n${len - 1}`), tl, 'api').prefix;
  // Chains of 16..19 nodes share one archive (8 nodes), 20..23 the next (12 nodes).
  assert.ok(prefixAt(16).includes('Event n7') && !prefixAt(16).includes('Event n8'));
  assert.equal(prefixAt(16), prefixAt(19));
  assert.notEqual(prefixAt(19), prefixAt(20));
  assert.ok(prefixAt(20).includes('Event n11') && !prefixAt(20).includes('Event n12'));
  // Archived nodes show key changes, not summaries; nothing job-specific leaks in.
  assert.ok(!prefixAt(20).includes('Summary of n3'));
  assert.ok(!prefixAt(20).includes('job-'));
});

test('every node appears exactly once across prefix and body', () => {
  const tl = line(21);
  const { prefix, body } = buildBriefParts(cont('n20'), tl, 'api');
  for (let i = 0; i < 21; i++) {
    const hits = (prefix + body).split(`### ${i + 1}. Event n${i} `).length - 1;
    assert.equal(hits, 1, `n${i} appears ${hits} times`);
  }
  assert.ok(body.includes('Narrative of n20'), 'the node being continued is in full');
  assert.equal(buildBrief(cont('n20'), tl, 'api'), `${prefix}\n\n---\n\n${body}`);
});
