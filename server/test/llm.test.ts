// Contract tests for the provider adapters, against a fake server that speaks each wire protocol.
// They pin down the request shapes we rely on, so an API change shows up here first.
// Run: npm test (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createProvider, LlmError, type SessionOptions, type ToolSpec } from '../src/llm/index.ts';
import type { ResolvedBuiltin } from '../src/config.ts';
import { extractJson } from '../src/llm/json.ts';

type Seen = { url: string; headers: http.IncomingHttpHeaders; body: any };

/** A server that answers each request with the next scripted [status, body] and records what it got. */
async function fakeServer(script: [number, unknown][]) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
      const [status, body] = script.shift() ?? [500, { error: { message: 'script exhausted' } }];
      res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { base, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const cfg = (provider: ResolvedBuiltin['provider'], baseUrl: string): ResolvedBuiltin => ({
  provider,
  model: 'test-model',
  baseUrl,
  apiKey: 'sk-test',
  keyEnv: 'TEST_KEY',
  concurrency: 1,
  maxOutputTokens: 4000,
  maxToolCalls: 2,
  maxRepairs: 2,
  timeoutMs: 10_000,
});

const searchCalls: unknown[] = [];
const tools: ToolSpec[] = [
  {
    name: 'search_events',
    description: 'search',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: (a) => (searchCalls.push(a), 'RESULTS for "x": 1 of 1'),
  },
];
const opts = (): SessionOptions => ({ system: 'SYSTEM', tools, maxToolCalls: 2, maxOutputTokens: 4000, timeoutMs: 10_000, signal: new AbortController().signal });

test('openai-compatible: tool call round trip, request shape, usage', async () => {
  const srv = await fakeServer([
    [200, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_events', arguments: '{"query":"thorium"}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }],
    [200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"node":1}' } }], usage: { prompt_tokens: 150, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 90 } } }],
  ]);
  try {
    const s = createProvider(cfg('openai-compatible', srv.base)).open(opts());
    assert.equal(await s.ask('BRIEF'), '{"node":1}');
    const [first, second] = srv.seen;
    assert.equal(first.url, '/v1/chat/completions');
    assert.equal(first.headers.authorization, 'Bearer sk-test');
    assert.deepEqual(first.body.messages.slice(0, 2), [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'BRIEF' },
    ]);
    assert.equal(first.body.max_tokens, 4000, 'non-OpenAI hosts get max_tokens');
    assert.equal(first.body.tools[0].function.name, 'search_events');
    assert.equal(first.body.tool_choice, 'auto');
    assert.deepEqual(second.body.messages.at(-1), { role: 'tool', tool_call_id: 'c1', content: 'RESULTS for "x": 1 of 1' });
    assert.deepEqual(searchCalls.at(-1), { query: 'thorium' });
    assert.deepEqual(s.usage, { inputTokens: 250, outputTokens: 30, cachedInputTokens: 90, requests: 2, toolCalls: 1 });
  } finally {
    await srv.close();
  }
});

test('anthropic: tool_use round trip, cached system prompt, headers', async () => {
  const srv = await fakeServer([
    [200, { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 't1', name: 'search_events', input: { query: 'tamil' } }], usage: { input_tokens: 50, cache_creation_input_tokens: 400, output_tokens: 15 } }],
    [200, { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"node":2}' }], usage: { input_tokens: 60, cache_read_input_tokens: 400, output_tokens: 25 } }],
  ]);
  try {
    const s = createProvider(cfg('anthropic', srv.base)).open(opts());
    assert.equal(await s.ask('BRIEF'), '{"node":2}');
    const [first, second] = srv.seen;
    assert.equal(first.url, '/v1/messages');
    assert.equal(first.headers['x-api-key'], 'sk-test');
    assert.equal(first.headers['anthropic-version'], '2023-06-01');
    assert.equal(first.headers.authorization, 'Bearer sk-test', 'non-Anthropic hosts also get a bearer token');
    assert.deepEqual(first.body.system, [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
    assert.equal(first.body.max_tokens, 4000);
    assert.equal(first.body.tools[0].input_schema.type, 'object');
    // The newest block carries the cache breakpoint, so the next request reads the brief from cache.
    assert.deepEqual(first.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'BRIEF', cache_control: { type: 'ephemeral' } }] }]);
    assert.deepEqual(second.body.messages.at(-1), {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'RESULTS for "x": 1 of 1', cache_control: { type: 'ephemeral' } }],
    });
    assert.equal(second.body.messages[0].content, 'BRIEF', 'older messages carry no breakpoint');
    assert.equal(second.body.tool_choice.type, 'auto');
    assert.deepEqual(s.usage, { inputTokens: 910, outputTokens: 40, cachedInputTokens: 400, requests: 2, toolCalls: 1 });
  } finally {
    await srv.close();
  }
});

test('tool budget: after maxToolCalls the model is told to answer and tool_choice becomes none', async () => {
  const call = (id: string) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'search_events', arguments: '{"query":"q"}' } }] } }] });
  const srv = await fakeServer([
    [200, call('a')],
    [200, call('b')],
    [200, { choices: [{ message: { role: 'assistant', content: 'done' } }] }],
  ]);
  try {
    const s = createProvider(cfg('openai-compatible', srv.base)).open(opts());
    assert.equal(await s.ask('BRIEF'), 'done');
    assert.equal(srv.seen[2].body.tool_choice, 'none');
    assert.equal(s.usage.toolCalls, 2);
  } finally {
    await srv.close();
  }
});

test('errors: 503 is retried, 401 is a config error, output limit is "truncated"', async () => {
  const ok = { choices: [{ message: { role: 'assistant', content: 'fine' } }] };
  const retry = await fakeServer([
    [503, { error: { message: 'busy' } }],
    [200, ok],
  ]);
  try {
    assert.equal(await createProvider(cfg('openai-compatible', retry.base)).open(opts()).ask('x'), 'fine');
  } finally {
    await retry.close();
  }

  const denied = await fakeServer([[401, { error: { message: 'bad key' } }]]);
  try {
    await assert.rejects(createProvider(cfg('anthropic', denied.base)).open(opts()).ask('x'), (e: LlmError) => e.kind === 'config' && /bad key/.test(e.message));
  } finally {
    await denied.close();
  }

  const cut = await fakeServer([[200, { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"node":' }] }]]);
  try {
    await assert.rejects(createProvider(cfg('anthropic', cut.base)).open(opts()).ask('x'), (e: LlmError) => e.kind === 'truncated');
  } finally {
    await cut.close();
  }
});

test('extractJson: plain, fenced, and wrapped in prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Here you go:\n{"a":3}\nHope that helps.'), { a: 3 });
  assert.throws(() => extractJson('no json here'));
});
