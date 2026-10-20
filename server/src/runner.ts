// The built-in runner: when data/config.json selects engine "builtin", this process claims jobs itself and
// asks a model API (through server/src/llm) instead of waiting for the external worker. It reuses
// everything the worker path uses: the same brief (in API mode), the same validation and apply code (via
// `submit`), the same follow-ups. Only the transport differs.
import fs from 'node:fs';
import path from 'node:path';
import type { Generation, Job } from '../../shared/types.ts';
import type { JobSpend } from '../../shared/usage.ts';
import { API_TOOLS, buildBriefParts } from './brief.ts';
import { builtinProblem, costUsd, getConfig, onConfigChange, resolveBuiltin } from './config.ts';
import { monthSummary, recordUsage } from './usage.ts';
import { claimForBuiltin, getJob, onQueueChange, releaseJob, setBuiltinStatus } from './jobs.ts';
import { createProvider, LlmError, type ToolSpec, type Usage } from './llm/index.ts';
import { extractJson } from './llm/json.ts';
import { listModels } from './llm/probe.ts';
import { searchForJob, showNode } from './search.ts';
import { getTimeline } from './store.ts';

/** The writer instructions shared with the Claude Code subagent; one source for both engines. */
const WRITER_FILE = path.resolve(import.meta.dirname, '../../.claude/agents/forkpath-writer.md');

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
  // Shell commands and dispatcher etiquette, marked in the file, mean nothing to an API call.
  const apiOnly = withoutSteps.replace(/<!-- worker-only -->[\s\S]*?<!-- \/worker-only -->\n?/g, '');
  return API_PREAMBLE + apiOnly.trim();
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
  submit(
    jobId: string,
    body: unknown,
    gen: Omit<Generation, 'jobType' | 'at' | 'nodesInJob'>,
  ): { created?: { id: string; title: string }[]; updated?: { id: string; title: string } };
  fail(jobId: string, reason: string): void;
  /** Adds what a job spent to its world and nodes (`written`: the nodes it wrote, if it finished). */
  spend(job: Job, outcome: 'done' | 'failed' | 'cancelled', spend: JobSpend, written: string[]): void;
}

const running = new Map<string, AbortController>();
/** Set when the provider rejected the key, model or URL: the runner waits for a config change. */
let paused: string | null = null;

/** Why the monthly budget stops new jobs, or null. Jobs already running finish (and may overshoot it a little). */
function budgetProblem(): string | null {
  const cap = getConfig().budget.monthlyUsd;
  if (cap === undefined) return null;
  const spent = monthSummary().costUsd;
  return spent >= cap ? `Monthly budget reached: $${spent.toFixed(2)} of $${cap.toFixed(2)} spent this month` : null;
}

function publishStatus() {
  const cfg = getConfig();
  const r = resolveBuiltin();
  const problem = cfg.engine === 'builtin' ? (paused ?? builtinProblem(r) ?? unreachable ?? budgetProblem()) : null;
  setBuiltinStatus({ ready: cfg.engine === 'builtin' && !problem, label: createProvider(r).label, problem });
}

/**
 * Whether the configured server answers, so the status never says "running" while it is down. Set by
 * checkReachable (GET /models: no tokens, no cost) and by a connection test of the saved settings. While
 * set, jobs wait in the queue instead of failing one by one.
 */
let unreachable: string | null = null;
let lastCheck = 0;
let checking: Promise<void> | null = null;
let pumpRef: (() => void) | null = null;
const RECHECK_MS = 30_000;

/** Records whether the server answered; a recovery starts the queued jobs. */
export function noteReachability(problem: string | null) {
  lastCheck = Date.now();
  const recovered = unreachable !== null && problem === null;
  if (problem === unreachable) return;
  unreachable = problem;
  publishStatus();
  if (recovered) pumpRef?.();
}

/**
 * Checks the saved built-in settings now (or reuses a check younger than `maxAgeMs`). Only failures that
 * stop every job count: no connection, or the key rejected. Other answers (a server without /models)
 * mean it is up.
 */
export function checkReachable(maxAgeMs = 0): Promise<void> {
  const cfg = getConfig();
  const r = resolveBuiltin();
  if (cfg.engine !== 'builtin' || builtinProblem(r)) {
    noteReachability(null);
    return Promise.resolve();
  }
  if (checking) return checking;
  if (Date.now() - lastCheck < maxAgeMs) return Promise.resolve();
  checking = listModels(r)
    .then(
      () => noteReachability(null),
      (err: Error) => {
        const msg = err.message;
        if (msg.startsWith('Cannot reach')) noteReachability(msg);
        else if (/^HTTP 40[13]\b/.test(msg)) noteReachability(`The server rejected the API key (${msg.slice(0, 8)})`);
        else noteReachability(null);
      },
    )
    .finally(() => {
      checking = null;
    });
  return checking;
}

const fmtUsage = (u: Usage) =>
  `${u.inputTokens} in (${u.cachedInputTokens} cached) / ${u.outputTokens} out, ${u.requests} request${u.requests === 1 ? '' : 's'}, ${u.toolCalls} tool call${u.toolCalls === 1 ? '' : 's'}`;

type Outcome = 'done' | 'failed' | 'cancelled' | 'released';

/** Runs one job and records its tokens and cost, whatever the outcome: in the usage ledger, and on its world and nodes. */
async function runJob(job: Job, deps: RunnerDeps, controller: AbortController) {
  const r = resolveBuiltin();
  const provider = createProvider(r);
  const started = Date.now();
  const usage: JobUsage = { value: undefined, written: [] };
  const outcome = await attemptJob(job, deps, controller, r, provider.label, started, usage);
  const u = usage.value;
  if (u && u.requests > 0) {
    const result = outcome === 'released' ? 'cancelled' : outcome;
    const spend: JobSpend = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cachedInputTokens: u.cachedInputTokens,
      costUsd: costUsd(u),
    };
    recordUsage({
      at: new Date().toISOString(),
      jobId: job.id,
      timelineId: job.timelineId,
      jobType: job.type,
      model: provider.label,
      outcome: result,
      ...spend,
      durationMs: Date.now() - started,
    });
    deps.spend(job, result, spend, usage.written);
    publishStatus(); // the budget may now be reached
  }
}

/** Filled in while a job runs: the session's token counts, and the nodes it wrote once it is saved. */
interface JobUsage {
  value: Usage | undefined;
  written: string[];
}

async function attemptJob(
  job: Job,
  deps: RunnerDeps,
  controller: AbortController,
  r: ReturnType<typeof resolveBuiltin>,
  label: string,
  started: number,
  usage: JobUsage,
): Promise<Outcome> {
  const tl = getTimeline(job.timelineId);
  if (!tl) {
    deps.fail(job.id, 'Timeline was deleted');
    return 'failed';
  }
  const session = createProvider(r).open({
    system: writerPrompt(),
    // A review judges what its brief shows: no searches, which keeps it cheap.
    tools: job.type === 'review' ? [] : toolsFor(job),
    maxToolCalls: job.type === 'review' ? 0 : r.maxToolCalls,
    maxOutputTokens: r.maxOutputTokens,
    timeoutMs: r.timeoutMs,
    signal: controller.signal,
  });
  usage.value = session.usage;
  const log = (msg: string) => console.log(`[runner] ${job.id} ${job.type}: ${msg}`);
  log('started');

  let reply: string;
  try {
    const { prefix, body } = buildBriefParts(job, tl, 'api');
    reply = await session.ask(prefix ? [prefix, body] : body);
  } catch (err) {
    return handleProviderError(err, job, deps, log);
  }

  for (let attempt = 0; ; attempt++) {
    if (controller.signal.aborted) {
      log('cancelled');
      return 'cancelled';
    }
    let problem: string;
    try {
      const u = session.usage;
      const out = deps.submit(job.id, extractJson(reply), {
        engine: 'builtin',
        model: label,
        durationMs: Date.now() - started,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cachedInputTokens: u.cachedInputTokens,
        costUsd: costUsd(u),
        repairs: attempt,
      });
      const written = out.created?.length ? out.created : out.updated ? [out.updated] : [];
      usage.written = written.map((w) => w.id);
      const titles = written.map((w) => w.title);
      log(`✅ ${titles.join(' | ')} (${Math.round((Date.now() - started) / 1000)}s; ${fmtUsage(u)})`);
      return 'done';
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 410 || status === 409) {
        log(`discarded: ${(err as Error).message}`);
        return 'cancelled';
      }
      if (status !== undefined && status !== 400) {
        deps.fail(job.id, (err as Error).message);
        return 'failed';
      }
      // Unparseable JSON or a 400 from validation: the model gets the same message the worker would.
      problem = status === 400 ? (err as Error).message : `Your reply was not valid JSON (${(err as Error).message}).`;
    }
    if (attempt >= r.maxRepairs) {
      log(`failed after ${attempt} repair${attempt === 1 ? '' : 's'}`);
      deps.fail(job.id, `The model's result stayed invalid after ${attempt} repair attempts:\n${problem}`.slice(0, 1000));
      return 'failed';
    }
    log(`repair ${attempt + 1}: ${problem.split('\n')[0]}`);
    try {
      reply = await session.ask(`That was not saved.\n${problem}\nReply with the corrected JSON object only.`);
    } catch (err) {
      return handleProviderError(err, job, deps, log);
    }
  }
}

function handleProviderError(err: unknown, job: Job, deps: RunnerDeps, log: (m: string) => void): Outcome {
  if (!(err instanceof LlmError)) {
    log(`error: ${(err as Error).message}`);
    deps.fail(job.id, (err as Error).message);
    return 'failed';
  }
  if (err.kind === 'aborted') {
    log('cancelled');
    return 'cancelled';
  }
  if (err.kind === 'config') {
    // Retrying cannot help and every queued job would fail the same way: put this one back and pause.
    paused = `Provider rejected the request: ${err.message}`;
    log(paused);
    const current = getJob(job.id);
    if (current) releaseJob(current);
    publishStatus();
    return 'released';
  }
  if (err.message.startsWith('Cannot reach')) {
    // The server is down, not the job at fault: put it back and wait until the server answers again.
    log(`server unreachable, job back in the queue: ${err.message}`);
    const current = getJob(job.id);
    if (current) releaseJob(current);
    noteReachability(err.message);
    return 'released';
  }
  const hint = err.kind === 'truncated' ? ' Raise maxOutputTokens in Settings, or retry.' : '';
  log(`failed: ${err.message}`);
  deps.fail(job.id, `${err.message}.${hint}`);
  return 'failed';
}

/** Starts as many jobs as the config allows. Called whenever the queue or the config changes. */
function pump(deps: RunnerDeps) {
  // Jobs the user cancelled (or that were deleted) stop their in-flight requests.
  for (const [id, controller] of running) {
    const job = getJob(id);
    if (!job || job.status !== 'claimed' || job.claimedBy !== 'builtin') controller.abort();
  }
  const cfg = getConfig();
  if (cfg.engine !== 'builtin' || paused || builtinProblem() || unreachable || budgetProblem()) return;
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
  pumpRef = () => pump(deps);
  onConfigChange((cfg) => {
    paused = null; // a config edit is the fix for whatever paused it
    unreachable = null; // and may fix an unreachable server: check again right away
    if (cfg.engine !== 'builtin') for (const c of running.values()) c.abort();
    publishStatus();
    pump(deps);
    void checkReachable();
  });
  // Keeps the status honest while the built-in engine is active (a local server stopped, the network dropped).
  setInterval(() => void checkReachable(RECHECK_MS - 1000), RECHECK_MS).unref();
  publishStatus();
  pump(deps);
  void checkReachable();
}
