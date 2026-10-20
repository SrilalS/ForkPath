// Worker token reporting: reading Claude Code transcripts, and pricing replies at Claude API list prices.
// Run: npm test (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repliesForJob } from '../../worker/transcript.mjs';
import { ratesFor, replyCostUsd } from '../src/pricing.ts';
import { addSpend, emptyTotals, sumTotals } from '../../shared/usage.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

const reply = (id: string, usage: Record<string, unknown>, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', message: { id, model, usage } });
const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });

/** A fake Claude config dir with one session (and its subagents) under one project. */
function fakeSession(main: string[], subagents: string[][] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forkpath-cc-'));
  const project = path.join(dir, 'projects', 'C--proj');
  fs.mkdirSync(path.join(project, 'sess', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(project, 'sess.jsonl'), main.join('\n') + '\n');
  subagents.forEach((lines, i) => fs.writeFileSync(path.join(project, 'sess', 'subagents', `agent-${i}.jsonl`), lines.join('\n') + '\n'));
  return dir;
}

test('transcript: counts from the job id on, once per message id, subagents included', () => {
  const u = (out: number) => ({ input_tokens: 2, cache_read_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 300 }, output_tokens: out });
  const configDir = fakeSession(
    [
      reply('before', u(999)), // spent on something else
      user('JOB abc123 CONTINUE'),
      reply('m1', u(10)),
      reply('m1', u(10)), // same reply, second content block
      reply('syn', u(5), '<synthetic>'),
      'not json',
    ],
    [
      [user('Write job abc123'), reply('s1', u(20)), reply('s2', u(30))],
      [user('Write job other99'), reply('x', u(500))], // another job's writer
    ],
  );
  const replies = repliesForJob('abc123', { sessionId: 'sess', configDir })!;
  assert.deepEqual(replies.map((r: { outputTokens: number }) => r.outputTokens).sort(), [10, 20, 30]);
  assert.equal(replies[0].cacheWrite1hTokens, 300);
  assert.equal(repliesForJob('missing', { sessionId: 'sess', configDir }), null);
  assert.equal(repliesForJob('abc123', { sessionId: 'nope', configDir }), null);
  assert.equal(repliesForJob('abc123', { sessionId: undefined, configDir }), null);
  fs.rmSync(configDir, { recursive: true, force: true });
});

test('pricing: longest prefix wins, dated ids work, unknown models have no price', () => {
  assert.equal(ratesFor('claude-opus-5-5')!.read, 0.2);
  assert.equal(ratesFor('claude-opus-5')!.input, 5);
  assert.equal(ratesFor('claude-opus-4-1-20250805')!.input, 15);
  assert.equal(ratesFor('claude-opus-4-20250514')!.input, 15);
  assert.equal(ratesFor('claude-sonnet-4-5-20250929')!.input, 3);
  assert.equal(ratesFor('gpt-5'), undefined);
  assert.equal(replyCostUsd({ model: 'gpt-5', inputTokens: 1, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 1 }), undefined);
});

test('pricing: a reply costs each token kind at its rate', () => {
  const r = { model: 'claude-opus-5-5', inputTokens: 1e6, cacheReadTokens: 1e6, cacheWrite5mTokens: 1e6, cacheWrite1hTokens: 1e6, outputTokens: 1e6 };
  near(replyCostUsd(r)!, 4 + 0.2 + 5 + 8 + 20);
  near(replyCostUsd({ ...r, fast: true })!, 2 * 37.2);
  near(replyCostUsd({ ...r, usOnly: true })!, 1.1 * 37.2);
  // Haiku 5.5 switches to its long-prompt prices past 100k prompt tokens.
  const haiku = (input: number) => replyCostUsd({ model: 'claude-haiku-5-5', inputTokens: input, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0 })!;
  near(haiku(100_000), 0.01);
  near(haiku(200_000), 0.1);
});

test('estimated cost is kept apart from real cost', () => {
  const t = emptyTotals();
  addSpend(t, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.5, estimated: true });
  addSpend(t, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.2 });
  near(t.costUsd, 0.2);
  near(t.estimatedUsd!, 0.5);
  assert.equal(t.unpriced, 0);
  near(sumTotals([t, t]).estimatedUsd!, 1);
});
