import fs from 'node:fs';
import path from 'node:path';
import type { Job, WorkerStatus } from '../../shared/types.ts';
import { DATA_DIR, newId, now, writeJsonAtomic } from './store.ts';
import { broadcast } from './events.ts';
import { getConfig, onConfigChange } from './config.ts';

/** Only the active engine is handed jobs; the other one gets NO_JOB. */
const activeEngine = () => getConfig().engine;

const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
/** A claimed job with no result after this long goes back to pending (worker crashed or lost it). */
const CLAIM_TIMEOUT_MS = 20 * 60_000;
/**
 * A claim whose brief nobody fetched within this long goes back to pending. With --id-only the writer fetches
 * the brief seconds after the claim; when that never happens, the claim most likely went to a poll left
 * running by a worker session that was stopped (its next.mjs outlives it by up to 9 minutes).
 */
const DELIVERY_TIMEOUT_MS = 3 * 60_000;
/** The worker counts as online for this long after its last poll ended. */
const ONLINE_GRACE_MS = 20_000;
const KEEP_FINISHED = 200;

const jobs = new Map<string, Job>();
try {
  for (const job of JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')) as Job[]) {
    // The built-in runner lives in this process, so its claims died with the last run: queue them again now.
    if (job.status === 'claimed' && job.claimedBy === 'builtin') {
      job.status = 'pending';
      job.claimedAt = undefined;
      job.claimedBy = undefined;
    }
    jobs.set(job.id, job);
  }
} catch {
  // first run
}

function persist() {
  const all = [...jobs.values()];
  const open = all.filter((j) => j.status === 'pending' || j.status === 'claimed');
  const finished = all
    .filter((j) => j.status !== 'pending' && j.status !== 'claimed')
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
    .slice(0, KEEP_FINISHED);
  for (const j of all) if (!open.includes(j) && !finished.includes(j)) jobs.delete(j.id);
  writeJsonAtomic(JOBS_FILE, [...open, ...finished]);
}

// ---- worker presence -------------------------------------------------------

let activePolls = 0;
let lastSeenAt: string | null = null;
let lastBroadcast = '';

/** Set by the built-in runner: whether it can run, and how to describe it. */
let builtin: { ready: boolean; label: string; problem: string | null } = { ready: false, label: '', problem: null };

export function setBuiltinStatus(s: typeof builtin) {
  builtin = s;
  broadcastStatus();
}

export function workerStatus(): WorkerStatus {
  const all = [...jobs.values()];
  const claimed = all.filter((j) => j.status === 'claimed').length;
  const pending = all.filter((j) => j.status === 'pending').length;
  if (activeEngine() === 'builtin') {
    return { engine: 'builtin', online: builtin.ready, lastSeenAt, pending, claimed, label: builtin.label, problem: builtin.problem ?? undefined };
  }
  const recentlySeen = lastSeenAt !== null && Date.now() - Date.parse(lastSeenAt) < ONLINE_GRACE_MS;
  return {
    engine: 'external',
    // A claimed job means the worker is busy writing, even though it is not polling.
    online: activePolls > 0 || recentlySeen || claimed > 0,
    lastSeenAt,
    pending,
    claimed,
  };
}

export function touchWorker() {
  lastSeenAt = now();
}

function broadcastStatus() {
  const status = workerStatus();
  lastBroadcast = JSON.stringify({ ...status, lastSeenAt: null });
  broadcast({ type: 'worker', status });
}

/** Called when the queue changes (new, cancelled or released jobs), so the built-in runner can react. */
const queueListeners = new Set<() => void>();
export function onQueueChange(fn: () => void) {
  queueListeners.add(fn);
  return () => queueListeners.delete(fn);
}
const queueChanged = () => {
  for (const fn of queueListeners) fn();
};

onConfigChange(() => {
  // Switching to the external worker lets a waiting poll pick up queued jobs right away; switching away
  // leaves its polls waiting until they time out with NO_JOB (a quick NO_JOB would make it spin).
  wakeWaiter();
  queueChanged();
  broadcastStatus();
});

setInterval(() => {
  // Requeue abandoned claims: never delivered (a poll from a stopped session), or delivered but never finished.
  let changed = false;
  for (const job of jobs.values()) {
    if (job.status !== 'claimed') continue;
    const age = Date.now() - Date.parse(job.claimedAt!);
    const undelivered = !job.deliveredAt && age > DELIVERY_TIMEOUT_MS;
    if (undelivered || age > CLAIM_TIMEOUT_MS) {
      console.log(`[jobs] ${job.id} back in the queue: ${undelivered ? 'nobody fetched its brief' : 'no result in time'}`);
      job.status = 'pending';
      job.claimedAt = undefined;
      job.claimedBy = undefined;
      job.deliveredAt = undefined;
      changed = true;
    }
  }
  if (changed) {
    persist();
    wakeWaiter();
    queueChanged();
  }
  if (changed || JSON.stringify({ ...workerStatus(), lastSeenAt: null }) !== lastBroadcast) broadcastStatus();
}, 5_000).unref();

// ---- queue -----------------------------------------------------------------

type Waiter = (job: Job | null) => void;
const waiters: Waiter[] = [];

export function getJob(id: string) {
  return jobs.get(id);
}

export function openJobFor(timelineId: string, nodeId: string): Job | undefined {
  return [...jobs.values()].find(
    (j) =>
      j.timelineId === timelineId &&
      (j.status === 'pending' || j.status === 'claimed') &&
      (j.placeholderId === nodeId || (j.type === 'regenerate' && j.targetNodeId === nodeId)),
  );
}

export function enqueue(input: Omit<Job, 'id' | 'status' | 'createdAt'>): Job {
  const job: Job = { ...input, id: newId(), status: 'pending', createdAt: now() };
  jobs.set(job.id, job);
  persist();
  wakeWaiter();
  queueChanged();
  broadcastStatus();
  return job;
}

function oldestPending(): Job | undefined {
  return [...jobs.values()]
    .filter((j) => j.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

function claim(job: Job, by: NonNullable<Job['claimedBy']>): Job {
  job.status = 'claimed';
  job.claimedAt = now();
  job.claimedBy = by;
  job.deliveredAt = undefined;
  persist();
  broadcastStatus();
  return job;
}

/** The claimant has the brief: from now on only the long claim timeout applies. */
export function markDelivered(job: Job) {
  if (job.status !== 'claimed' || job.deliveredAt) return;
  job.deliveredAt = now();
  persist();
}

function wakeWaiter() {
  if (activeEngine() !== 'external') return;
  while (waiters.length) {
    const job = oldestPending();
    if (!job) return;
    waiters.shift()!(claim(job, 'external'));
  }
}

/** The built-in runner's claim: the oldest pending job, or undefined (also when the runner is not active). */
export function claimForBuiltin(): Job | undefined {
  if (activeEngine() !== 'builtin') return undefined;
  const job = oldestPending();
  if (!job) return undefined;
  claim(job, 'builtin');
  markDelivered(job); // the runner builds the brief itself, in this process
  return job;
}

/** Puts a claimed job back in the queue (the runner stopped before finishing it). */
export function releaseJob(job: Job) {
  if (job.status !== 'claimed') return;
  job.status = 'pending';
  job.claimedAt = undefined;
  job.claimedBy = undefined;
  job.deliveredAt = undefined;
  persist();
  wakeWaiter();
  queueChanged();
  broadcastStatus();
}

/**
 * Long-poll for the external worker: resolves with a claimed job, or null after waitMs. While the built-in
 * runner is the active engine nothing is handed out, but the poll still waits its full time so the worker
 * does not spin on instant NO_JOBs.
 */
export function nextJob(waitMs: number, onAbort: (cancel: () => void) => void): Promise<Job | null> {
  touchWorker();
  const ready = activeEngine() === 'external' ? oldestPending() : undefined;
  if (ready) return Promise.resolve(claim(ready, 'external'));
  if (waitMs <= 0) return Promise.resolve(null);

  activePolls++;
  broadcastStatus();
  return new Promise((resolve) => {
    let done = false;
    const finish: Waiter = (job) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const i = waiters.indexOf(finish);
      if (i >= 0) waiters.splice(i, 1);
      activePolls--;
      touchWorker();
      broadcastStatus();
      resolve(job);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    waiters.push(finish);
    onAbort(() => {
      // Client went away. If a job was already handed to this waiter it stays claimed and
      // will be requeued by the claim timeout; the worker can also re-fetch it by id.
      finish(null);
    });
  });
}

export function finishJob(job: Job, status: 'done' | 'failed' | 'cancelled', error?: string) {
  job.status = status;
  job.finishedAt = now();
  if (error) job.error = error;
  persist();
  queueChanged();
  broadcastStatus();
}

export function cancelJobsForNodes(timelineId: string, nodeIds: Set<string>) {
  let changed = false;
  for (const job of jobs.values()) {
    if (job.timelineId !== timelineId || (job.status !== 'pending' && job.status !== 'claimed')) continue;
    if (
      nodeIds.has(job.targetNodeId) ||
      (job.placeholderId && nodeIds.has(job.placeholderId)) ||
      job.mergeWith?.some((id) => nodeIds.has(id)) ||
      (job.influenceFrom && nodeIds.has(job.influenceFrom))
    ) {
      job.status = 'cancelled';
      job.finishedAt = now();
      changed = true;
    }
  }
  if (changed) {
    persist();
    queueChanged();
    broadcastStatus();
  }
}

/** Cancels open REVIEW jobs for one node: its content changed, or a newer review replaces them. */
export function cancelReviewJobs(timelineId: string, nodeId: string) {
  let changed = false;
  for (const job of jobs.values()) {
    if (job.timelineId !== timelineId || job.type !== 'review' || job.targetNodeId !== nodeId) continue;
    if (job.status !== 'pending' && job.status !== 'claimed') continue;
    job.status = 'cancelled';
    job.finishedAt = now();
    changed = true;
  }
  if (changed) {
    persist();
    queueChanged();
    broadcastStatus();
  }
}

export function cancelJobsForTimeline(timelineId: string) {
  for (const job of jobs.values()) {
    if (job.timelineId === timelineId && (job.status === 'pending' || job.status === 'claimed')) {
      job.status = 'cancelled';
      job.finishedAt = now();
    }
  }
  persist();
  queueChanged();
  broadcastStatus();
}
