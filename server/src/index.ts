import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { SCHEMA_VERSION, type Generation, type Job, type Detail, type NodeReview, type ReviewMode, type Strength, type Temperament, type Timeline, type TLNode } from '../../shared/types.ts';
import { streamLabel, WorldIndex } from '../../shared/world.ts';
import { buildExport, exportFileName, importFile } from './transfer.ts';
import { MigrationError } from './migrate.ts';
import {
  deleteTimeline,
  ancestorIdsOf,
  descendantsOf,
  getTimeline,
  listTimelines,
  makeNode,
  newId,
  now,
  saveTimeline,
} from './store.ts';
import { addClient, broadcast } from './events.ts';
import {
  cancelJobsForNodes,
  cancelJobsForTimeline,
  cancelReviewJobs,
  enqueue,
  finishJob,
  getJob,
  markDelivered,
  nextJob,
  openJobFor,
  touchWorker,
  workerStatus,
} from './jobs.ts';
import { buildBrief } from './brief.ts';
import { searchForJob, showNode } from './search.ts';
import { builtinProblem, getConfig, publicConfig, resolveBuiltin, updateConfig } from './config.ts';
import { monthSummary, recentUsage } from './usage.ts';
import { listModels, probe } from './llm/probe.ts';
import { startRunner } from './runner.ts';
import {
  addLink,
  applyContinue,
  applyRegenerate,
  type ApplyReport,
  continueIssues,
  markStaleFrom,
  regenerateIssues,
  putLink,
  removeLinksFor,
} from './apply.ts';
import {
  continueResult,
  deviationInput,
  enginePatch,
  formatIssues,
  generateOptions,
  influenceInput,
  linkInput,
  nodeEdit,
  regenerateResult,
  reviewResult,
} from './schema.ts';

// Not PORT: dev tooling often sets PORT for the web server, which would collide with Vite.
// The ALTHISTORY_* names are read too, from before the app was named Forkpath.
const PORT = Number(process.env.FORKPATH_API_PORT ?? process.env.ALTHISTORY_API_PORT ?? 5174);
/**
 * Loopback only by default: the API can store a model API key and spend money, and has no login. Set
 * FORKPATH_HOST=0.0.0.0 only on a trusted network.
 */
const HOST = process.env.FORKPATH_HOST ?? process.env.ALTHISTORY_HOST ?? '127.0.0.1';
const MAX_WAIT_S = 590;

const app = express();
app.use(express.json({ limit: '20mb' }));

// ---- helpers ---------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function loadTimeline(req: Request): Timeline {
  const tl = getTimeline(String(req.params.id));
  if (!tl) throw new HttpError(404, 'Timeline not found');
  return tl;
}

function loadNode(tl: Timeline, req: Request): TLNode {
  const node = tl.nodes[String(req.params.nodeId)];
  if (!node) throw new HttpError(404, 'Node not found');
  return node;
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: any } }, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, `Invalid input:\n${formatIssues(r.error)}`);
  return r.data;
}

function commit(tl: Timeline) {
  saveTimeline(tl);
  broadcast({ type: 'timeline', timeline: tl });
  broadcast({ type: 'timelines', timelines: listTimelines() });
}

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h =
  (fn: Handler) =>
  async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) res.status(status).json({ error: (err as Error).message });
    }
  };

/** Jobs store a temperament only when it leans somewhere; realist is the default and stays implicit. */
const lean = (t?: Temperament) => (t && t !== 'realist' ? t : undefined);
/** Likewise the review option: off is the default. */
const reviewOn = (r?: ReviewMode) => (r && r !== 'off' ? r : undefined);

/**
 * Queues a plausibility review of `node`'s current content. The node stays usable meanwhile; its review
 * shows as pending. A newer request replaces an open one for the same node.
 */
function startReview(tl: Timeline, node: TLNode, requestedBy: NodeReview['requestedBy'], reason?: string) {
  if (node.kind !== 'event') throw new HttpError(400, 'Only generated events can be reviewed');
  if (node.status !== 'ready') throw new HttpError(409, 'Node is not ready yet');
  cancelReviewJobs(tl.id, node.id);
  const job = enqueue({ type: 'review', timelineId: tl.id, targetNodeId: node.id });
  node.review = { status: 'pending', jobId: job.id, requestedBy, ...(reason ? { reason } : {}) };
}

/** After a writing job: reviews for the nodes it wrote, as its review option says ('auto': the ones the writer flagged). */
function startReviews(tl: Timeline, job: Job, written: { id: string; reviewReason?: string }[]) {
  if (!job.review) return 0;
  let n = 0;
  for (const w of written) {
    const node = tl.nodes[w.id];
    if (!node || node.kind !== 'event' || node.status !== 'ready') continue;
    if (job.review === 'always') startReview(tl, node, 'always');
    else if (w.reviewReason) startReview(tl, node, 'writer', w.reviewReason);
    else continue;
    n++;
  }
  return n;
}

function startContinue(tl: Timeline, parent: TLNode, opts: { timeSpan?: string; guidance?: string; temperament?: Temperament; detail?: Detail; review?: ReviewMode }) {
  if (parent.status !== 'ready') throw new HttpError(409, 'Node is not ready yet');
  const placeholder = makeNode({
    parentId: parent.id,
    kind: 'event',
    source: 'llm',
    status: 'generating',
    title: 'Generating...',
    period: opts.timeSpan ?? '',
  });
  tl.nodes[placeholder.id] = placeholder;
  const job = enqueue({
    type: 'continue',
    timelineId: tl.id,
    targetNodeId: parent.id,
    placeholderId: placeholder.id,
    timeSpan: opts.timeSpan || undefined,
    guidance: opts.guidance || undefined,
    temperament: lean(opts.temperament),
    detail: opts.detail === 'story' ? 'story' : undefined,
    review: reviewOn(opts.review),
  });
  placeholder.jobId = job.id;
  return placeholder;
}

/** Queues a convergence node whose parents are `a` (primary) and `b`. */
/** Up to this many nodes besides `a` can converge in one merge. */
const MAX_MERGE_WITH = 4;

/** Queues a convergence node whose parents are `a` (primary) and every node in `others`. */
function startMerge(tl: Timeline, a: TLNode, others: TLNode[], opts: { timeSpan?: string; guidance?: string; temperament?: Temperament; detail?: Detail; review?: ReviewMode }) {
  if (!others.length) throw new HttpError(400, 'Pick at least one other node to merge with');
  if (others.length > MAX_MERGE_WITH) throw new HttpError(400, `Merge at most ${MAX_MERGE_WITH + 1} nodes at once`);
  const all = [a, ...others];
  if (new Set(all.map((n) => n.id)).size !== all.length) throw new HttpError(400, 'Pick different nodes to merge');
  if (all.some((n) => n.status !== 'ready')) throw new HttpError(409, 'All nodes must be ready');
  // Every pair must sit on separate branches; merging a node with its own ancestor makes no sense.
  for (const x of all) {
    const up = ancestorIdsOf(tl, x.id);
    const clash = all.find((y) => y !== x && up.has(y.id));
    if (clash) throw new HttpError(400, `"${clash.title}" and "${x.title}" are on the same path. Merge nodes from separate branches.`);
  }
  const placeholder = makeNode({
    parentId: a.id,
    mergeParents: others.map((n) => n.id),
    kind: 'event',
    source: 'llm',
    status: 'generating',
    title: 'Generating...',
    period: opts.timeSpan ?? '',
  });
  tl.nodes[placeholder.id] = placeholder;
  const job = enqueue({
    type: 'merge',
    timelineId: tl.id,
    targetNodeId: a.id,
    mergeWith: others.map((n) => n.id),
    placeholderId: placeholder.id,
    timeSpan: opts.timeSpan || undefined,
    guidance: opts.guidance || undefined,
    temperament: lean(opts.temperament),
    detail: opts.detail === 'story' ? 'story' : undefined,
    review: reviewOn(opts.review),
  });
  placeholder.jobId = job.id;
  return placeholder;
}

/** At most this many streams can be influenced by one event at once. */
const MAX_INFLUENCE_TARGETS = 4;

/**
 * Queues one job per target: the agent writes a new event after each target that shows how `source`
 * affects that stream. The influence link (source to the new node) is drawn right away, on the placeholder.
 */
function startInfluence(
  tl: Timeline,
  source: TLNode,
  targets: TLNode[],
  opts: { timeSpan?: string; guidance?: string; temperament?: Temperament; detail?: Detail; review?: ReviewMode; strength: Strength; followUpDepth?: number },
) {
  if (source.status !== 'ready') throw new HttpError(409, 'The influencing node is not ready yet');
  if (new Set(targets.map((t) => t.id)).size !== targets.length) throw new HttpError(400, 'Pick each node once');
  if (targets.length > MAX_INFLUENCE_TARGETS) throw new HttpError(400, `Influence at most ${MAX_INFLUENCE_TARGETS} streams at once`);
  const ix = new WorldIndex(tl);
  for (const t of targets) {
    const check = ix.canInfluence(source.id, t.id);
    if (!check.ok) throw new HttpError(400, `Cannot influence "${t.title}": ${check.reason}.`);
  }
  return targets.map((t) => {
    const placeholder = makeNode({
      parentId: t.id,
      kind: 'event',
      source: 'llm',
      status: 'generating',
      title: 'Generating...',
      period: opts.timeSpan ?? '',
    });
    tl.nodes[placeholder.id] = placeholder;
    putLink(tl, source.id, placeholder.id, opts.strength, '', opts.followUpDepth ? 'llm' : 'user');
    const job = enqueue({
      type: 'influence',
      timelineId: tl.id,
      targetNodeId: t.id,
      influenceFrom: source.id,
      followUpDepth: opts.followUpDepth,
      placeholderId: placeholder.id,
      timeSpan: opts.timeSpan || undefined,
      guidance: opts.guidance || undefined,
      temperament: lean(opts.temperament),
      detail: opts.detail === 'story' ? 'story' : undefined,
      review: reviewOn(opts.review),
    });
    placeholder.jobId = job.id;
    return placeholder;
  });
}

/** Follow-ups may only come from jobs the user started, so one click never cascades beyond one level. */
const MAX_FOLLOW_UP_DEPTH = 1;

/**
 * Queues the follow-ups a writer asked for (each an INFLUENCE job from a node it just wrote to the latest
 * event of another stream). Invalid ones are skipped with a reason; the rest of the result still stands.
 */
function startFollowUps(tl: Timeline, job: Job, requests: ApplyReport['followUps']) {
  const queued: { id: string; stream: string }[] = [];
  const skipped: string[] = [];
  if (!requests.length) return { queued, skipped };
  if ((job.followUpDepth ?? 0) >= MAX_FOLLOW_UP_DEPTH) {
    skipped.push('this job is itself a follow-up, so it cannot request more');
    return { queued, skipped };
  }
  for (const r of requests) {
    const source = tl.nodes[r.source];
    const target = tl.nodes[r.target];
    if (!target) {
      skipped.push(`${r.target}: no node with that id`);
      continue;
    }
    if (!new WorldIndex(tl).isTip(target.id)) {
      skipped.push(`"${target.title}" is not the latest event in its stream (pick one marked "latest in stream")`);
      continue;
    }
    try {
      const [placeholder] = startInfluence(tl, source, [target], {
        strength: r.strength,
        guidance: r.guidance,
        temperament: job.temperament,
        detail: job.detail,
        review: job.review,
        followUpDepth: (job.followUpDepth ?? 0) + 1,
      });
      queued.push({ id: placeholder.id, stream: streamLabel(tl, target.id) });
    } catch (err) {
      skipped.push(`"${target.title}": ${(err as Error).message}`);
    }
  }
  return { queued, skipped };
}

// ---- timelines -------------------------------------------------------------

app.get('/api/timelines', h(() => listTimelines()));

app.post(
  '/api/timelines',
  h((req) => {
    const body = parse(deviationInput, req.body?.deviation);
    const root = makeNode({ parentId: null, kind: 'deviation', source: 'user', ...body });
    const ts = now();
    const tl: Timeline = {
      schemaVersion: SCHEMA_VERSION,
      id: newId(),
      title: String(req.body?.title || body.title).slice(0, 140),
      rootId: root.id,
      nodes: { [root.id]: root },
      links: [],
      createdAt: ts,
      updatedAt: ts,
    };
    if (req.body?.autoContinue) startContinue(tl, root, parse(generateOptions, req.body?.options));
    commit(tl);
    return tl;
  }),
);

app.get('/api/timelines/:id', h((req) => loadTimeline(req)));

app.patch(
  '/api/timelines/:id',
  h((req) => {
    const tl = loadTimeline(req);
    const title = String(req.body?.title ?? '').trim();
    if (!title) throw new HttpError(400, 'Title required');
    tl.title = title.slice(0, 140);
    commit(tl);
    return tl;
  }),
);

app.delete(
  '/api/timelines/:id',
  h((req) => {
    const tl = loadTimeline(req);
    cancelJobsForTimeline(tl.id);
    deleteTimeline(tl.id);
    broadcast({ type: 'timeline-deleted', id: tl.id });
    broadcast({ type: 'timelines', timelines: listTimelines() });
  }),
);

// ---- export / import -------------------------------------------------------

app.get(
  '/api/timelines/:id/export',
  h((req, res) => {
    const tl = loadTimeline(req);
    const nodeId = req.query.node ? String(req.query.node) : undefined;
    if (nodeId && !tl.nodes[nodeId]) throw new HttpError(404, 'Node not found');
    const file = buildExport(tl, nodeId);
    res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(file)}"`);
    res.type('application/json').send(JSON.stringify(file, null, 2));
  }),
);

app.post(
  '/api/import',
  h((req) => {
    let tl: Timeline;
    try {
      tl = importFile(req.body);
    } catch (err) {
      if (err instanceof MigrationError) throw new HttpError(400, err.message);
      throw err;
    }
    commit(tl);
    return tl;
  }),
);

// ---- nodes -----------------------------------------------------------------

app.post(
  '/api/timelines/:id/nodes/:nodeId/continue',
  h((req) => {
    const tl = loadTimeline(req);
    const node = startContinue(tl, loadNode(tl, req), parse(generateOptions, req.body));
    commit(tl);
    return node;
  }),
);

app.post(
  '/api/timelines/:id/nodes/:nodeId/merge',
  h((req) => {
    const tl = loadTimeline(req);
    const a = loadNode(tl, req);
    // `with` is one id or a list of ids.
    const ids: unknown[] = Array.isArray(req.body?.with) ? req.body.with : [req.body?.with];
    const others = ids.map((id) => tl.nodes[String(id ?? '')]);
    if (others.some((n) => !n)) throw new HttpError(404, 'Node to merge with not found');
    const node = startMerge(tl, a, others, parse(generateOptions, req.body));
    commit(tl);
    return node;
  }),
);

app.post(
  '/api/timelines/:id/nodes/:nodeId/influence',
  h((req) => {
    const tl = loadTimeline(req);
    const source = loadNode(tl, req);
    const body = parse(influenceInput, req.body);
    const targets = body.targets.map((id) => tl.nodes[id]);
    if (targets.some((n) => !n)) throw new HttpError(404, 'Influenced node not found');
    const nodes = startInfluence(tl, source, targets, body);
    commit(tl);
    return nodes;
  }),
);

app.post(
  '/api/timelines/:id/nodes/:nodeId/branch',
  h((req) => {
    const tl = loadTimeline(req);
    const parent = loadNode(tl, req);
    const body = parse(deviationInput, req.body?.deviation);
    const dev = makeNode({ parentId: parent.id, kind: 'deviation', source: 'user', ...body });
    tl.nodes[dev.id] = dev;
    if (req.body?.autoContinue) startContinue(tl, dev, parse(generateOptions, req.body?.options));
    commit(tl);
    return dev;
  }),
);

app.patch(
  '/api/timelines/:id/nodes/:nodeId',
  h((req) => {
    const tl = loadTimeline(req);
    const node = loadNode(tl, req);
    if (node.status === 'generating') throw new HttpError(409, 'Node is still generating');
    const edit = parse(nodeEdit, req.body);
    let changed = false;
    let contentChanged = false;
    for (const [k, raw] of Object.entries(edit) as [keyof typeof edit, unknown][]) {
      if (raw === undefined) continue;
      // An empty stream name clears the rename.
      const v = k === 'streamName' && raw === '' ? undefined : raw;
      if (JSON.stringify(node[k]) !== JSON.stringify(v)) {
        if (v === undefined) delete node[k];
        else (node as any)[k] = v;
        changed = true;
        // Re-rating or renaming the stream does not change what happened, so it does not invalidate later nodes.
        if (k !== 'significance' && k !== 'tone' && k !== 'streamName') contentChanged = true;
      }
    }
    if (changed) {
      if (node.source === 'llm') node.source = 'llm-edited';
      node.updatedAt = now();
      if (contentChanged) {
        // Editing a node means a regenerate result would have overwritten it anyway.
        node.stale = false;
        markStaleFrom(tl, node.id);
        // The review judged the old text.
        cancelReviewJobs(tl.id, node.id);
        delete node.review;
      }
      commit(tl);
    }
    return node;
  }),
);

app.post(
  '/api/timelines/:id/nodes/:nodeId/review',
  h((req) => {
    const tl = loadTimeline(req);
    const node = loadNode(tl, req);
    startReview(tl, node, 'user');
    commit(tl);
    return node;
  }),
);

app.post(
  '/api/timelines/:id/nodes/:nodeId/regenerate',
  h((req) => {
    const tl = loadTimeline(req);
    const node = loadNode(tl, req);
    if (node.kind !== 'event') throw new HttpError(400, 'Only generated nodes can be regenerated');
    if (node.status === 'generating') throw new HttpError(409, 'Node is already generating');
    const opts = parse(generateOptions, req.body);
    const job = enqueue({
      type: 'regenerate',
      timelineId: tl.id,
      targetNodeId: node.id,
      guidance: opts.guidance || undefined,
      temperament: lean(opts.temperament),
      detail: opts.detail === 'story' ? 'story' : undefined,
      review: reviewOn(opts.review),
    });
    // The rewrite replaces what any review in flight is checking.
    cancelReviewJobs(tl.id, node.id);
    if (node.review?.status === 'pending') delete node.review;
    node.status = 'generating';
    node.jobId = job.id;
    node.error = undefined;
    commit(tl);
    return node;
  }),
);

app.post(
  '/api/timelines/:id/nodes/:nodeId/keep',
  h((req) => {
    const tl = loadTimeline(req);
    const node = loadNode(tl, req);
    const targets = req.body?.subtree ? [node, ...descendantsOf(tl, node.id)] : [node];
    for (const n of targets) n.stale = false;
    commit(tl);
    return node;
  }),
);

app.post(
  '/api/timelines/:id/nodes/:nodeId/cancel',
  h((req) => {
    const tl = loadTimeline(req);
    const node = loadNode(tl, req);
    cancelJobsForNodes(tl.id, new Set([node.id]));
    if (node.review?.status === 'pending') {
      delete node.review;
      if (node.status === 'ready') commit(tl);
    }
    if (node.status !== 'ready') {
      if (node.title === 'Generating...' || !node.summary) {
        delete tl.nodes[node.id]; // empty continue placeholder
        removeLinksFor(tl, new Set([node.id]));
      } else {
        node.status = 'ready';
        node.jobId = undefined;
        node.error = undefined;
      }
      commit(tl);
    }
  }),
);

app.post(
  '/api/timelines/:id/nodes/:nodeId/retry',
  h((req) => {
    const tl = loadTimeline(req);
    const node = loadNode(tl, req);
    if (node.status !== 'error') throw new HttpError(409, 'Node has not failed');
    const old = node.jobId ? getJob(node.jobId) : undefined;
    if (!old) throw new HttpError(409, 'Original job not found, delete this node and try again');
    const job = enqueue({
      type: old.type,
      timelineId: tl.id,
      targetNodeId: old.targetNodeId,
      placeholderId: old.placeholderId,
      mergeWith: old.mergeWith,
      influenceFrom: old.influenceFrom,
      followUpDepth: old.followUpDepth,
      timeSpan: old.timeSpan,
      guidance: old.guidance,
      temperament: old.temperament,
      detail: old.detail,
      review: old.review,
    });
    node.status = 'generating';
    node.jobId = job.id;
    node.error = undefined;
    commit(tl);
    return node;
  }),
);

app.delete(
  '/api/timelines/:id/nodes/:nodeId',
  h((req) => {
    const tl = loadTimeline(req);
    const node = loadNode(tl, req);
    if (node.id === tl.rootId) throw new HttpError(400, 'Cannot delete the root node; delete the timeline instead');
    const doomed = [node, ...descendantsOf(tl, node.id)];
    const ids = new Set(doomed.map((n) => n.id));
    cancelJobsForNodes(tl.id, ids);
    for (const id of ids) delete tl.nodes[id];
    removeLinksFor(tl, ids);
    commit(tl);
  }),
);

// ---- influence links -------------------------------------------------------

app.post(
  '/api/timelines/:id/links',
  h((req) => {
    const tl = loadTimeline(req);
    const body = parse(linkInput, req.body);
    const r = addLink(tl, body.from, body.to, body.strength, body.note, 'user');
    if ('error' in r) throw new HttpError(400, `Cannot link these nodes: ${r.error}.`);
    commit(tl);
    return r.link;
  }),
);

app.delete(
  '/api/timelines/:id/links/:linkId',
  h((req) => {
    const tl = loadTimeline(req);
    const before = tl.links.length;
    tl.links = tl.links.filter((l) => l.id !== String(req.params.linkId));
    if (tl.links.length === before) throw new HttpError(404, 'Link not found');
    commit(tl);
  }),
);

// ---- worker API (used by worker/next.mjs and worker/submit.mjs) -----------

function jobPayload(jobId: string) {
  const job = getJob(jobId);
  if (!job) throw new HttpError(404, 'Job not found');
  const tl = getTimeline(job.timelineId);
  if (!tl) throw new HttpError(410, 'Timeline was deleted');
  return { job, brief: buildBrief(job, tl) };
}

app.get('/api/worker/status', h(() => workerStatus()));

app.get('/api/worker/next', async (req, res) => {
  const waitS = Math.min(Math.max(Number(req.query.wait ?? 0) || 0, 0), MAX_WAIT_S);
  let job = await nextJob(waitS * 1000, (cancel) => res.on('close', cancel));
  // Skip jobs whose timeline vanished while queued.
  while (job && !getTimeline(job.timelineId)) {
    finishJob(job, 'cancelled');
    job = await nextJob(0, () => {});
  }
  if (res.writableEnded || res.destroyed) return;
  if (!job) return void res.status(204).end();
  // With idOnly (the dispatcher hands the job to a writer), the claim counts once the writer fetches the
  // brief; otherwise the brief is in this response, so it is delivered now.
  if (req.query.idOnly === '1') return void res.json({ job });
  markDelivered(job);
  res.json(jobPayload(job.id));
});

app.get(
  '/api/worker/jobs/:jobId',
  h((req) => {
    const payload = jobPayload(String(req.params.jobId));
    markDelivered(payload.job);
    return payload;
  }),
);

/** The job and its timeline, for the worker's search commands. */
function jobContext(req: Request) {
  touchWorker();
  const job = getJob(String(req.params.jobId));
  if (!job) throw new HttpError(404, 'Job not found');
  const tl = getTimeline(job.timelineId);
  if (!tl) throw new HttpError(410, 'Timeline was deleted');
  return { job, tl };
}

const yearParam = (v: unknown) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

app.get(
  '/api/worker/jobs/:jobId/search',
  h((req, res) => {
    const { job, tl } = jobContext(req);
    const text = searchForJob(tl, job, {
      query: String(req.query.q ?? ''),
      before: yearParam(req.query.before),
      after: yearParam(req.query.after),
      limit: yearParam(req.query.limit),
    });
    res.type('text/plain').send(text);
  }),
);

app.get(
  '/api/worker/jobs/:jobId/nodes/:nodeId',
  h((req, res) => {
    const { tl } = jobContext(req);
    res.type('text/plain').send(showNode(tl, String(req.params.nodeId)));
  }),
);

/** A node dated before what it follows breaks the timeline; nothing is saved and the worker fixes it. */
/** A result that the schema accepted but the timeline does not: nothing is applied, the writer fixes it. */
function rejectIssues(issues: string[]) {
  if (issues.length) throw new HttpError(400, `Fix these and resubmit:\n${issues.map((i) => `- ${i}`).join('\n')}`);
}

/**
 * Validates and applies a job result: what submit.mjs posts for the external worker, and what the built-in
 * runner passes in directly. Throws HttpError: 400 = invalid (fix and resubmit), 410 = discard.
 */
function submitResult(jobId: string, body: unknown, gen?: GenerationInfo) {
  const job = getJob(jobId);
  if (!job) throw new HttpError(404, 'Job not found');
  if (job.status === 'cancelled') throw new HttpError(410, 'Job was cancelled by the user. Discard it and move on.');
  if (job.status === 'done') throw new HttpError(409, 'Job already completed');
  const tl = getTimeline(job.timelineId);
  if (!tl) {
    finishJob(job, 'cancelled');
    throw new HttpError(410, 'Timeline was deleted. Discard this job and move on.');
  }
  if (job.type === 'review') {
    const result = parse(reviewResult, body);
    const node = tl.nodes[job.targetNodeId];
    // The node was rewritten (or reviewed again) since: this verdict is about content that is gone.
    if (!node || node.review?.jobId !== job.id) {
      finishJob(job, 'cancelled');
      throw new HttpError(410, 'The node changed since this review was requested. Discard it and move on.');
    }
    node.review = {
      ...node.review,
      status: 'done',
      verdict: result.verdict,
      summary: result.summary,
      flags: result.verdict === 'plausible' ? result.flags.slice(0, 2) : result.flags,
      model: gen?.model ?? 'Claude Code worker',
      at: now(),
    };
    finishJob(job, 'done');
    commit(tl);
    return { ok: true, updated: { id: node.id, title: node.title }, verdict: result.verdict, flags: result.flags.length };
  }

  if (job.type !== 'regenerate') {
    const result = parse(continueResult, body);
    const placeholder = tl.nodes[job.placeholderId!];
    const parent = tl.nodes[job.targetNodeId];
    const mergeParents = job.type === 'merge' ? (job.mergeWith ?? []).filter((id) => tl.nodes[id]) : undefined;
    const sourceGone = job.type === 'influence' && !tl.nodes[job.influenceFrom ?? ''];
    if (!placeholder || !parent || (mergeParents && !mergeParents.length) || sourceGone) {
      finishJob(job, 'cancelled');
      throw new HttpError(410, 'The node for this job was deleted. Discard it and move on.');
    }
    rejectIssues(continueIssues(tl, job, result, MAX_FOLLOW_UP_DEPTH));
    const report = applyContinue(tl, job, result);
    stampGeneration(tl, job, report.created.map((c) => c.id), gen);
    const followUps = startFollowUps(tl, job, report.followUps);
    const reviews = startReviews(tl, job, report.created);
    finishJob(job, 'done');
    commit(tl);
    return { ok: true, ...report, followUps, reviews };
  }

  const result = parse(regenerateResult, body);
  const node = tl.nodes[job.targetNodeId];
  if (!node) {
    finishJob(job, 'cancelled');
    throw new HttpError(410, 'The node for this job was deleted. Discard it and move on.');
  }
  rejectIssues(regenerateIssues(tl, node, result));
  const report = applyRegenerate(tl, node, result);
  stampGeneration(tl, job, [node.id], gen);
  const reviews = startReviews(tl, job, [{ id: node.id, reviewReason: result.node.requestReview }]);
  finishJob(job, 'done');
  commit(tl);
  return { ok: true, updated: { id: node.id, title: node.title }, ...report, reviews };
}

/** What the engine knows about how a result was produced; the rest of Generation is filled in here. */
type GenerationInfo = Omit<Generation, 'jobType' | 'at' | 'nodesInJob'>;

/** Records on each written node which engine and model wrote it (and, for the built-in engine, the cost). */
function stampGeneration(tl: Timeline, job: Job, nodeIds: string[], gen?: GenerationInfo) {
  const info: GenerationInfo = gen ?? {
    engine: 'external',
    model: 'Claude Code worker',
    durationMs: job.claimedAt ? Date.now() - Date.parse(job.claimedAt) : undefined,
  };
  for (const id of nodeIds) {
    const node = tl.nodes[id];
    if (node) {
      node.generation = {
        ...info,
        jobType: job.type,
        at: now(),
        ...(nodeIds.length > 1 ? { nodesInJob: nodeIds.length } : {}),
        ...(job.temperament ? { temperament: job.temperament } : {}),
        ...(job.detail ? { detail: job.detail } : {}),
      };
    }
  }
}

/** Marks a job failed. Its placeholder shows the reason and can be retried; a regenerate keeps the old content. */
function failJob(jobId: string, reason: string) {
  const job = getJob(jobId);
  if (!job) throw new HttpError(404, 'Job not found');
  finishJob(job, 'failed', reason.slice(0, 1000));
  const tl = getTimeline(job.timelineId);
  if (job.type === 'review') {
    // A failed review leaves the node as it was; only its review shows the failure.
    const reviewed = tl?.nodes[job.targetNodeId];
    if (tl && reviewed?.review?.jobId === job.id) {
      reviewed.review = { ...reviewed.review, status: 'failed', error: reason.slice(0, 500) };
      commit(tl);
    }
    return;
  }
  const node = tl?.nodes[job.placeholderId ?? job.targetNodeId];
  if (tl && node) {
    node.status = job.type === 'regenerate' ? 'ready' : 'error';
    node.error = reason.slice(0, 1000);
    commit(tl);
  }
}

app.post(
  '/api/worker/jobs/:jobId/result',
  h((req) => {
    touchWorker();
    return submitResult(String(req.params.jobId), req.body);
  }),
);

app.post(
  '/api/worker/jobs/:jobId/fail',
  h((req) => {
    touchWorker();
    failJob(String(req.params.jobId), String(req.body?.error ?? 'Worker reported failure'));
  }),
);

// ---- live updates ----------------------------------------------------------

app.get('/api/events', (req, res) => {
  // ?timeline=<id>: the page shows that timeline and gets its updates (others' are not sent).
  const tl = typeof req.query.timeline === 'string' ? req.query.timeline : null;
  addClient(res, tl, [
    { type: 'timelines', timelines: listTimelines() },
    { type: 'worker', status: workerStatus() },
  ]);
});

// ---- built web UI (npm run build && npm start) ----------------------------

const dist = path.resolve(import.meta.dirname, '../../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ---- engine config and the built-in runner ---------------------------------

/** Config (never the key), live status, and this month's usage for the Settings page. */
const engineView = () => ({ ...publicConfig(), status: workerStatus(), usage: { month: monthSummary(), recent: recentUsage(15) } });

app.get('/api/engine', h(() => engineView()));

app.put(
  '/api/engine',
  h((req) => {
    updateConfig(parse(enginePatch, req.body));
    return engineView();
  }),
);

/**
 * The saved built-in settings with unsaved form values on top, so Settings can test before saving.
 * A missing or empty apiKey keeps the stored one.
 */
function draftBuiltin(body: unknown) {
  const patch = parse(enginePatch, body).builtin ?? {};
  const { pricing: _pricing, ...rest } = patch;
  const merged = { ...getConfig().builtin, ...rest };
  if (!patch.apiKey) merged.apiKey = getConfig().builtin.apiKey;
  return resolveBuiltin(merged);
}

app.post(
  '/api/engine/models',
  h(async (req) => {
    try {
      return { models: await listModels(draftBuiltin(req.body)) };
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  }),
);

app.post(
  '/api/engine/test',
  h(async (req) => {
    const cfg = draftBuiltin(req.body);
    const problem = builtinProblem(cfg);
    if (problem) return { ok: false, label: '', ms: 0, detail: problem };
    return probe(cfg);
  }),
);

startRunner({
  submit: (jobId, body, gen) => submitResult(jobId, body, gen),
  fail: (jobId, reason) => failJob(jobId, reason),
});

app.listen(PORT, HOST, () => {
  console.log(`[forkpath] API on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`);
});
