import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { SCHEMA_VERSION, type Timeline, type TLNode } from '../../shared/types.ts';
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
  enqueue,
  finishJob,
  getJob,
  nextJob,
  openJobFor,
  touchWorker,
  workerStatus,
} from './jobs.ts';
import { buildBrief } from './brief.ts';
import {
  continueResult,
  deviationInput,
  formatIssues,
  generateOptions,
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
function startMerge(tl: Timeline, a: TLNode, b: TLNode, opts: { timeSpan?: string; guidance?: string }) {
  if (a.id === b.id) throw new HttpError(400, 'Pick two different nodes to merge');
  if (a.status !== 'ready' || b.status !== 'ready') throw new HttpError(409, 'Both nodes must be ready');
  if (ancestorIdsOf(tl, a.id).has(b.id) || ancestorIdsOf(tl, b.id).has(a.id)) {
    throw new HttpError(400, 'These nodes are on the same path. Merge two nodes from separate branches.');
  }
  const placeholder = makeNode({
    parentId: a.id,
    mergeParents: [b.id],
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
    mergeWith: [b.id],
    placeholderId: placeholder.id,
    timeSpan: opts.timeSpan || undefined,
    guidance: opts.guidance || undefined,
  });
  placeholder.jobId = job.id;
  return placeholder;
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
    const b = tl.nodes[String(req.body?.with ?? '')];
    if (!b) throw new HttpError(404, 'Node to merge with not found');
    const node = startMerge(tl, a, b, parse(generateOptions, req.body));
    commit(tl);
    return node;
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
    for (const [k, v] of Object.entries(edit) as [keyof typeof edit, unknown][]) {
      if (v === undefined) continue;
      if (JSON.stringify(node[k]) !== JSON.stringify(v)) {
        (node as any)[k] = v;
        changed = true;
        // Re-rating significance or tone does not change what happened, so it does not invalidate later nodes.
        if (k !== 'significance' && k !== 'tone') contentChanged = true;
      }
    }
    if (changed) {
      if (node.source === 'llm') node.source = 'llm-edited';
      node.updatedAt = now();
      if (contentChanged) {
        // Editing a node means a regenerate result would have overwritten it anyway.
        node.stale = false;
        for (const d of descendantsOf(tl, node.id)) if (d.status === 'ready') d.stale = true;
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
    const ts = now();

    if (job.type === 'continue' || job.type === 'merge') {
      const result = parse(continueResult, req.body);
      const placeholder = tl.nodes[job.placeholderId!];
      const parent = tl.nodes[job.targetNodeId];
      const mergeParents = job.type === 'merge' ? (job.mergeWith ?? []).filter((id) => tl.nodes[id]) : undefined;
      if (!placeholder || !parent || (mergeParents && !mergeParents.length)) {
        finishJob(job, 'cancelled');
        throw new HttpError(410, 'The node for this job was deleted. Discard it and move on.');
      }
      const branching = result.children.length > 1;
      const total = result.children.reduce((s, c) => s + (c.likelihood ?? 0), 0) || 1;
      const created: TLNode[] = [];
      result.children.forEach((c, i) => {
        const target =
          i === 0 ? placeholder : makeNode({ parentId: parent.id, mergeParents, kind: 'event', source: 'llm' });
        Object.assign(target, {
          title: c.title,
          period: c.period,
          summary: c.summary,
          narrative: c.narrative,
          keyChanges: c.keyChanges,
          significance: c.significance,
          tone: c.tone,
          likelihood: branching ? (c.likelihood ?? 0) / total : undefined,
          branchReason: branching ? result.branchReason : undefined,
          status: 'ready',
          stale: false,
          jobId: undefined,
          error: undefined,
          updatedAt: ts,
        } satisfies Partial<TLNode>);
        tl.nodes[target.id] = target;
        created.push(target);
      });
      finishJob(job, 'done');
      commit(tl);
      return { ok: true, created: created.map((n) => ({ id: n.id, title: n.title })) };
    }

    const result = parse(regenerateResult, req.body);
    const node = tl.nodes[job.targetNodeId];
    if (!node) {
      finishJob(job, 'cancelled');
      throw new HttpError(410, 'The node for this job was deleted. Discard it and move on.');
    }
    Object.assign(node, result.node, {
      source: 'llm',
      status: 'ready',
      stale: false,
      jobId: undefined,
      error: undefined,
      updatedAt: ts,
    } satisfies Partial<TLNode>);
    // Its children were based on the outdated version.
    for (const d of descendantsOf(tl, node.id)) if (d.status === 'ready') d.stale = true;
    finishJob(job, 'done');
    commit(tl);
    return { ok: true, updated: { id: node.id, title: node.title } };
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
