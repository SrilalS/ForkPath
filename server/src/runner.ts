// The built-in runner: when data/config.json selects engine "builtin", this process claims jobs itself and
// asks a model API (through server/src/llm) instead of waiting for the external worker. It reuses
// everything the worker path uses: the same brief (in API mode), the same validation and apply code (via
// `submit`), the same follow-ups. Only the transport differs.
import fs from 'node:fs';
import path from 'node:path';
import type { Job } from '../../shared/types.ts';
import { API_TOOLS, buildBrief } from './brief.ts';
import { builtinProblem, getConfig, onConfigChange, resolveBuiltin } from './config.ts';
import { claimForBuiltin, getJob, onQueueChange, releaseJob, setBuiltinStatus } from './jobs.ts';
import { createProvider, LlmError, type ToolSpec, type Usage } from './llm/index.ts';
import { extractJson } from './llm/json.ts';
import { searchForJob, showNode } from './search.ts';
import { getTimeline } from './store.ts';

/** The writer instructions shared with the Claude Code subagent; one source for both engines. */
const WRITER_FILE = path.resolve(import.meta.dirname, '../../.claude/agents/althistory-writer.md');

const API_PREAMBLE = `You are called through an API, not as a Claude Code agent. Differences from the instructions below:
- You have no shell and no files. Ignore every mention of worker/*.mjs commands, worker/out files, the Write tool and OK / INVALID / DISCARD lines.
- To search, use the ${API_TOOLS.search} and ${API_TOOLS.show} tools instead of worker/search.mjs.
- Reply with ONLY the JSON result object: no prose before or after it, no code fences. If it fails validation, the errors come back to you as a message; reply with the corrected JSON.

`;

/** The writer instructions for API calls: the subagent file without its frontmatter and its shell steps. */
function writerPrompt(): string {
  const raw = fs.readFileSync(WRITER_FILE, 'utf8').replace(/\r\n/g, '\n');
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  // Section 1 is the command sequence for the shell-based worker; the preamble replaces it.
  const withoutSteps = body.replace(/\n## 1\. Your steps[\s\S]*?\n---\n/, '\n');
  return API_PREAMBLE + withoutSteps.trim();
}

function toolsFor(job: Job): ToolSpec[] {
  const timeline = () => {
    const tl = getTimeline(job.timelineId);
    if (!tl) throw new Error('timeline was deleted');
    return tl;
  };
  const year = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return [
    {
      name: API_TOOLS.search,
      description:
        'Keyword search over events in other streams that the node you are writing may link to (however old). ' +
        'Results older than the influence window show only their key changes. Use 1-3 distinctive keywords.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords, e.g. "thorium reactor"' },
          before: { type: 'integer', description: 'Only events starting before this year' },
          after: { type: 'integer', description: 'Only events starting after this year' },
          limit: { type: 'integer', description: 'Max results (default 6, max 12)' },
        },
        required: ['query'],
      },
      run: (a) =>
        searchForJob(timeline(), job, { query: String(a.query ?? ''), before: year(a.before), after: year(a.after), limit: year(a.limit) }),
    },
    {
      name: API_TOOLS.show,
      description: 'One event in full: summary, key changes and narrative.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Event id from the brief or a search' } }, required: ['id'] },
      run: (a) => showNode(timeline(), String(a.id ?? '')),
    },
  ];
}

/** How the runner hands results to the server: the same functions the worker HTTP routes use. */
export interface RunnerDeps {
  /** Validates and applies a result. Throws an error with `status` 400 (invalid), 410 (discard) or 409. */
  submit(jobId: string, body: unknown): { created?: { title: string }[]; updated?: { title: string } };
  fail(jobId: string, reason: string): void;
}

const running = new Map<string, AbortController>();
/** Set when the provider rejected the key, model or URL: the runner waits for a config change. */
let paused: string | null = null;

function publishStatus() {
  const cfg = getConfig();
  const r = resolveBuiltin();
  const problem = cfg.engine === 'builtin' ? (paused ?? builtinProblem(r)) : null;
  setBuiltinStatus({ ready: cfg.engine === 'builtin' && !problem, label: createProvider(r).label, problem });
}

const fmtUsage = (u: Usage) =>
  `${u.inputTokens} in (${u.cachedInputTokens} cached) / ${u.outputTokens} out, ${u.requests} request${u.requests === 1 ? '' : 's'}, ${u.toolCalls} tool call${u.toolCalls === 1 ? '' : 's'}`;

async function runJob(job: Job, deps: RunnerDeps, controller: AbortController) {
  const r = resolveBuiltin();
  const tl = getTimeline(job.timelineId);
  if (!tl) return deps.fail(job.id, 'Timeline was deleted');
  const session = createProvider(r).open({
    system: writerPrompt(),
    tools: toolsFor(job),
    maxToolCalls: r.maxToolCalls,
    maxOutputTokens: r.maxOutputTokens,
    timeoutMs: r.timeoutMs,
    signal: controller.signal,
  });
  const started = Date.now();
  const log = (msg: string) => console.log(`[runner] ${job.id} ${job.type}: ${msg}`);
  log('started');

  let reply: string;
  try {
    reply = await session.ask(buildBrief(job, tl, 'api'));
  } catch (err) {
    return handleProviderError(err, job, deps, log);
  }

  for (let attempt = 0; ; attempt++) {
    if (controller.signal.aborted) return log('cancelled');
    let problem: string;
    try {
      const out = deps.submit(job.id, extractJson(reply));
      const titles = out.created?.map((c) => c.title) ?? (out.updated ? [out.updated.title] : []);
      log(`✅ ${titles.join(' | ')} (${Math.round((Date.now() - started) / 1000)}s; ${fmtUsage(session.usage)})`);
      return;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 410 || status === 409) return log(`discarded: ${(err as Error).message}`);
      if (status !== undefined && status !== 400) return deps.fail(job.id, (err as Error).message);
      // Unparseable JSON or a 400 from validation: the model gets the same message the worker would.
      problem = status === 400 ? (err as Error).message : `Your reply was not valid JSON (${(err as Error).message}).`;
    }
    if (attempt >= r.maxRepairs) {
      log(`failed after ${attempt} repair${attempt === 1 ? '' : 's'}`);
      return deps.fail(job.id, `The model's result stayed invalid after ${attempt} repair attempts:\n${problem}`.slice(0, 1000));
    }
    log(`repair ${attempt + 1}: ${problem.split('\n')[0]}`);
    try {
      reply = await session.ask(`That was not saved.\n${problem}\nReply with the corrected JSON object only.`);
    } catch (err) {
      return handleProviderError(err, job, deps, log);
    }
  }
}

function handleProviderError(err: unknown, job: Job, deps: RunnerDeps, log: (m: string) => void) {
  if (!(err instanceof LlmError)) {
    log(`error: ${(err as Error).message}`);
    return deps.fail(job.id, (err as Error).message);
  }
  if (err.kind === 'aborted') return log('cancelled');
  if (err.kind === 'config') {
    // Retrying cannot help and every queued job would fail the same way: put this one back and pause.
    paused = `Provider rejected the request: ${err.message}`;
    log(paused);
    const current = getJob(job.id);
    if (current) releaseJob(current);
    publishStatus();
    return;
  }
  const hint = err.kind === 'truncated' ? ' Raise maxOutputTokens in data/config.json, or retry.' : '';
  log(`failed: ${err.message}`);
  deps.fail(job.id, `${err.message}.${hint}`);
}

/** Starts as many jobs as the config allows. Called whenever the queue or the config changes. */
function pump(deps: RunnerDeps) {
  // Jobs the user cancelled (or that were deleted) stop their in-flight requests.
  for (const [id, controller] of running) {
    const job = getJob(id);
    if (!job || job.status !== 'claimed' || job.claimedBy !== 'builtin') controller.abort();
  }
  const cfg = getConfig();
  if (cfg.engine !== 'builtin' || paused || builtinProblem()) return;
  while (running.size < cfg.builtin.concurrency) {
    const job = claimForBuiltin();
    if (!job) return;
    const controller = new AbortController();
    running.set(job.id, controller);
    runJob(job, deps, controller)
      .catch((err) => console.error(`[runner] ${job.id} crashed:`, err))
      .finally(() => {
        running.delete(job.id);
        pump(deps);
      });
  }
}

export function startRunner(deps: RunnerDeps) {
  // Deferred: jobs are queued in the middle of a request (before the timeline is saved and the placeholder
  // gets its jobId), so start them only after that request has finished its work.
  let scheduled = false;
  onQueueChange(() => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      pump(deps);
    });
  });
  onConfigChange((cfg) => {
    paused = null; // a config edit is the fix for whatever paused it
    if (cfg.engine !== 'builtin') for (const c of running.values()) c.abort();
    publishStatus();
    pump(deps);
  });
  publishStatus();
  pump(deps);
}
