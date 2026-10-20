import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { SCHEMA_VERSION, type Job, type Strength, type Timeline, type TLNode } from '../../shared/types.ts';
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
  parentIdsOf,
  saveTimeline,
} from './store.ts';
import { addClient, broadcast } from './events.ts';
import {
  cancelJobsForNodes,
  cancelJobsForTimeline,
  enqueue,
  finishJob,
  getJob,
  nextJob,
  openJobFor,
  touchWorker,
  workerStatus,
} from './jobs.ts';
import { buildBrief } from './brief.ts';
import { searchForJob, showNode } from './search.ts';
import {
  addLink,
  applyContinue,
  applyRegenerate,
  type ApplyReport,
  chronologyIssues,
  continueChronology,
  markStaleFrom,
  putLink,
  removeLinksFor,
} from './apply.ts';
import {
  continueResult,
  deviationInput,
  formatIssues,
  generateOptions,
  influenceInput,
  linkInput,
  nodeEdit,
  regenerateResult,
} from './schema.ts';

// Not PORT: dev tooling often sets PORT for the web server, which would collide with Vite.
const PORT = Number(process.env.ALTHISTORY_API_PORT ?? 5174);
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

function startContinue(tl: Timeline, parent: TLNode, opts: { timeSpan?: string; guidance?: string }) {
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
  });
  placeholder.jobId = job.id;
  return placeholder;
}

/** Queues a convergence node whose parents are `a` (primary) and `b`. */
/** Up to this many nodes besides `a` can converge in one merge. */
const MAX_MERGE_WITH = 4;

/** Queues a convergence node whose parents are `a` (primary) and every node in `others`. */
function startMerge(tl: Timeline, a: TLNode, others: TLNode[], opts: { timeSpan?: string; guidance?: string }) {
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
  opts: { timeSpan?: string; guidance?: string; strength: Strength; followUpDepth?: number },
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
      }
      commit(tl);
    }
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
    const job = enqueue({ type: 'regenerate', timelineId: tl.id, targetNodeId: node.id, guidance: opts.guidance || undefined });
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
  res.json(jobPayload(job.id));
});

app.get('/api/worker/jobs/:jobId', h((req) => jobPayload(String(req.params.jobId))));

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
function rejectChronology(issues: string[]) {
  if (issues.length) throw new HttpError(400, `Chronology:\n${issues.map((i) => `- ${i}`).join('\n')}`);
}

app.post(
  '/api/worker/jobs/:jobId/result',
  h((req) => {
    touchWorker();
    const job = getJob(String(req.params.jobId));
    if (!job) throw new HttpError(404, 'Job not found');
    if (job.status === 'cancelled') throw new HttpError(410, 'Job was cancelled by the user. Discard it and move on.');
    if (job.status === 'done') throw new HttpError(409, 'Job already completed');
    const tl = getTimeline(job.timelineId);
    if (!tl) {
      finishJob(job, 'cancelled');
      throw new HttpError(410, 'Timeline was deleted. Discard this job and move on.');
    }
    if (job.type !== 'regenerate') {
      const result = parse(continueResult, req.body);
      const placeholder = tl.nodes[job.placeholderId!];
      const parent = tl.nodes[job.targetNodeId];
      const mergeParents = job.type === 'merge' ? (job.mergeWith ?? []).filter((id) => tl.nodes[id]) : undefined;
      const sourceGone = job.type === 'influence' && !tl.nodes[job.influenceFrom ?? ''];
      if (!placeholder || !parent || (mergeParents && !mergeParents.length) || sourceGone) {
        finishJob(job, 'cancelled');
        throw new HttpError(410, 'The node for this job was deleted. Discard it and move on.');
      }
      rejectChronology(continueChronology(tl, job, result));
      const report = applyContinue(tl, job, result);
      const followUps = startFollowUps(tl, job, report.followUps);
      finishJob(job, 'done');
      commit(tl);
      return { ok: true, ...report, followUps };
    }

    const result = parse(regenerateResult, req.body);
    const node = tl.nodes[job.targetNodeId];
    if (!node) {
      finishJob(job, 'cancelled');
      throw new HttpError(410, 'The node for this job was deleted. Discard it and move on.');
    }
    rejectChronology(chronologyIssues(tl, [result.node], parentIdsOf(node)));
    const report = applyRegenerate(tl, node, result);
    finishJob(job, 'done');
    commit(tl);
    return { ok: true, updated: { id: node.id, title: node.title }, ...report };
  }),
);

app.post(
  '/api/worker/jobs/:jobId/fail',
  h((req) => {
    touchWorker();
    const job = getJob(String(req.params.jobId));
    if (!job) throw new HttpError(404, 'Job not found');
    const reason = String(req.body?.error ?? 'Worker reported failure').slice(0, 1000);
    finishJob(job, 'failed', reason);
    const tl = getTimeline(job.timelineId);
    const node = tl?.nodes[job.placeholderId ?? job.targetNodeId];
    if (tl && node) {
      // A failed continue leaves an error placeholder (retryable); a failed regenerate keeps the old content.
      node.status = job.type === 'continue' ? 'error' : 'ready';
      node.error = reason;
      commit(tl);
    }
  }),
);

// ---- live updates ----------------------------------------------------------

app.get('/api/events', (_req, res) => {
  addClient(res, [
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

app.listen(PORT, () => {
  console.log(`[althistory] API on http://localhost:${PORT}`);
});
