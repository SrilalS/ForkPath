import fs from 'node:fs';
import path from 'node:path';
import type { Job, WorkerStatus } from '../../shared/types.ts';
import { DATA_DIR, newId, now, writeJsonAtomic } from './store.ts';
import { broadcast } from './events.ts';

const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
/** A claimed job with no result after this long goes back to pending (worker crashed or lost it). */
const CLAIM_TIMEOUT_MS = 20 * 60_000;
/** The worker counts as online for this long after its last poll ended. */
const ONLINE_GRACE_MS = 20_000;
const KEEP_FINISHED = 200;

const jobs = new Map<string, Job>();
try {
  for (const job of JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')) as Job[]) jobs.set(job.id, job);
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
let lastBroadcastOnline: boolean | null = null;

export function workerStatus(): WorkerStatus {
  const all = [...jobs.values()];
  const recentlySeen = lastSeenAt !== null && Date.now() - Date.parse(lastSeenAt) < ONLINE_GRACE_MS;
  const claimed = all.filter((j) => j.status === 'claimed').length;
  return {
    // A claimed job means the worker is busy writing, even though it is not polling.
    online: activePolls > 0 || recentlySeen || claimed > 0,
    lastSeenAt,
    pending: all.filter((j) => j.status === 'pending').length,
    claimed,
  };
}

export function touchWorker() {
  lastSeenAt = now();
}

function broadcastStatus() {
  const status = workerStatus();
  lastBroadcastOnline = status.online;
  broadcast({ type: 'worker', status });
}

setInterval(() => {
  // Requeue abandoned claims.
  let changed = false;
  for (const job of jobs.values()) {
    if (job.status === 'claimed' && Date.now() - Date.parse(job.claimedAt!) > CLAIM_TIMEOUT_MS) {
      job.status = 'pending';
      job.claimedAt = undefined;
      changed = true;
    }
  }
  if (changed) {
    persist();
    wakeWaiter();
  }
  if (changed || workerStatus().online !== lastBroadcastOnline) broadcastStatus();
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
  broadcastStatus();
  return job;
}

function oldestPending(): Job | undefined {
  return [...jobs.values()]
    .filter((j) => j.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

function claim(job: Job): Job {
  job.status = 'claimed';
  job.claimedAt = now();
  persist();
  broadcastStatus();
  return job;
}

function wakeWaiter() {
  while (waiters.length) {
    const job = oldestPending();
    if (!job) return;
    waiters.shift()!(claim(job));
  }
}

/** Long-poll: resolves with a claimed job, or null after waitMs. */
export function nextJob(waitMs: number, onAbort: (cancel: () => void) => void): Promise<Job | null> {
  touchWorker();
  const ready = oldestPending();
  if (ready) return Promise.resolve(claim(ready));
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
  broadcastStatus();
}

export function cancelJobsForNodes(timelineId: string, nodeIds: Set<string>) {
  let changed = false;
  for (const job of jobs.values()) {
    if (job.timelineId !== timelineId || (job.status !== 'pending' && job.status !== 'claimed')) continue;
    if (
      nodeIds.has(job.targetNodeId) ||
      (job.placeholderId && nodeIds.has(job.placeholderId)) ||
      job.mergeWith?.some((id) => nodeIds.has(id))
    ) {
      job.status = 'cancelled';
      job.finishedAt = now();
      changed = true;
    }
  }
  if (changed) {
    persist();
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
  broadcastStatus();
}
