// Usage totals: the shared helpers, the v7 -> v8 migration that seeds them, and what an export carries.
// Run: npm test (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Timeline, TLNode } from '../../shared/types.ts';
import { addSpend, emptyTimelineUsage, emptyTotals, fmtTokens, fmtUsd, sumTotals } from '../../shared/usage.ts';
import { migrateTimeline } from '../src/migrate.ts';
import { buildExport } from '../src/transfer.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

function node(id: string, parentId: string | null, extra: Partial<TLNode> = {}): TLNode {
  return {
    id, parentId, period: '1900',
    kind: parentId ? 'event' : 'deviation',
    source: 'llm', status: 'ready', stale: false,
    title: id, summary: '', narrative: '', keyChanges: [],
    significance: 'notable', tone: 'neutral',
    createdAt: `2020-01-01T00:00:0${id.length}Z`, updatedAt: '',
    ...extra,
  };
}

function world(version: number, nodes: TLNode[], extra: Partial<Timeline> = {}): Timeline {
  return { schemaVersion: version, id: 't', title: 't', rootId: 'root', nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), links: [], createdAt: '', updatedAt: '', ...extra };
}

test('addSpend splits a job between nodes and counts unpriced jobs', () => {
  const a = emptyTotals();
  addSpend(a, { inputTokens: 900, outputTokens: 300, cachedInputTokens: 90, costUsd: 0.3 }, 1 / 3);
  addSpend(a, { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 });
  near(a.jobs, 4 / 3);
  near(a.inputTokens, 400);
  near(a.outputTokens, 150);
  near(a.cachedInputTokens, 30);
  near(a.costUsd, 0.1);
  near(a.unpriced, 1);
  const sum = sumTotals([a, undefined, a]);
  near(sum.inputTokens, 800);
  near(sum.unpriced, 2);
});

test('formatters round fractional shares', () => {
  assert.equal(fmtTokens(333.4), '333');
  assert.equal(fmtTokens(4200), '4.2k');
  assert.equal(fmtTokens(38_400), '38k');
  assert.equal(fmtTokens(1_250_000), '1.25M');
  assert.equal(fmtUsd(0.004), '<$0.01');
  assert.equal(fmtUsd(undefined), '-');
});

test('v7 -> v8 seeds node spend and world totals from generations', () => {
  const builtin = { engine: 'builtin', model: 'm', jobType: 'continue', at: '', inputTokens: 3000, outputTokens: 600, cachedInputTokens: 0, costUsd: 0.06, nodesInJob: 3 } as const;
  const raw = world(7, [
    node('root', null),
    node('a', 'root', { generation: builtin }),
    node('bb', 'root', { generation: builtin }),
    node('ccc', 'root', { generation: builtin }),
    node('dddd', 'a', { generation: { engine: 'external', model: 'Claude Code worker', jobType: 'continue', at: '' } }),
    node('eeeee', 'a', { generation: { engine: 'builtin', model: 'm', jobType: 'regenerate', at: '', inputTokens: 500, outputTokens: 100 } }),
  ]);
  const { timeline } = migrateTimeline(structuredClone(raw));
  assert.equal(timeline.schemaVersion, 8);
  near(timeline.nodes.a.spent!.inputTokens, 1000);
  near(timeline.nodes.a.spent!.costUsd, 0.02);
  assert.equal(timeline.nodes.dddd.spent, undefined);
  near(timeline.nodes.eeeee.spent!.unpriced, 1);
  const u = timeline.usage!;
  assert.equal(u.total.jobs, 2); // the shared job once, plus the regenerate
  near(u.total.inputTokens, 3500);
  near(u.total.costUsd, 0.06);
  assert.equal(u.total.unpriced, 1);
  assert.equal(u.untracked, 1);
  assert.equal(u.wasted.jobs, 0);
});

test('a world with nothing generated gets no usage, and broken usage is dropped', () => {
  assert.equal(migrateTimeline(world(7, [node('root', null)])).timeline.usage, undefined);
  const bad = world(8, [node('root', null, { spent: { jobs: 'x' } as never })], { usage: { total: {} } as never });
  const { timeline } = migrateTimeline(bad);
  assert.equal(timeline.usage, undefined);
  assert.equal(timeline.nodes.root.spent, undefined);
});

test('a branch export carries only its own nodes spend', () => {
  const spent = (n: number) => {
    const t = emptyTotals();
    addSpend(t, { inputTokens: n, outputTokens: 0, cachedInputTokens: 0, costUsd: n / 1000 });
    return t;
  };
  const usage = emptyTimelineUsage();
  addSpend(usage.total, { inputTokens: 9999, outputTokens: 0, cachedInputTokens: 0, costUsd: 9 });
  const tl = world(8, [node('root', null, { spent: spent(100) }), node('a', 'root', { spent: spent(200) }), node('bb', 'root', { spent: spent(400) })], { usage });
  assert.equal(buildExport(tl).timeline.usage?.total.inputTokens, 9999);
  const branch = buildExport(tl, 'a').timeline.usage!;
  near(branch.total.inputTokens, 300); // root + a, not bb
  assert.equal(branch.wasted.jobs, 0);
});
