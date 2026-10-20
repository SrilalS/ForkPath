#!/usr/bin/env node
// Waits for the next generation job and prints its brief.
//
//   node worker/next.mjs              wait up to 540s for a job
//   node worker/next.mjs --wait 60    wait up to 60s
//   node worker/next.mjs --job <id>   re-print the brief for a job you already claimed
//   node worker/next.mjs --id-only    claim a job but print only its id and type (the dispatcher hands
//                                     the job to a subagent, which reads the brief with --job <id>)
//
// Output starts with one of these markers on the first line:
//   JOB <id> <TYPE>  a job was claimed; the brief follows (unless --id-only)
//   NO_JOB           nothing arrived in time; run this again
//   SERVER_DOWN      backend not reachable; check `npm run dev` is running, then run this again

const BASE = process.env.ALTHISTORY_URL ?? 'http://127.0.0.1:5174';
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const waitS = Math.min(Number(opt('--wait') ?? 540), 590);
const jobId = opt('--job');
const idOnly = args.includes('--id-only');
const deadline = Date.now() + waitS * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function print(payload) {
  const head = `JOB ${payload.job.id} ${payload.job.type.toUpperCase()}`;
  if (idOnly) return console.log(head);
  console.log(`${head}\n`);
  console.log(payload.brief);
}

async function main() {
  if (jobId) {
    const res = await fetch(`${BASE}/api/worker/jobs/${jobId}`);
    if (!res.ok) {
      console.log(`ERROR ${res.status}: ${(await res.json().catch(() => ({}))).error ?? res.statusText}`);
      process.exit(1);
    }
    return print(await res.json());
  }

  while (true) {
    const left = Math.floor((deadline - Date.now()) / 1000);
    if (left <= 0) return console.log('NO_JOB');
    try {
      const res = await fetch(`${BASE}/api/worker/next?wait=${left}`, {
        signal: AbortSignal.timeout((left + 15) * 1000),
      });
      if (res.status === 204) return console.log('NO_JOB');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return print(await res.json());
    } catch (err) {
      if (Date.now() + 5000 >= deadline) {
        return console.log(`SERVER_DOWN (${BASE}): ${err.cause?.code ?? err.message}`);
      }
      await sleep(5000);
    }
  }
}

main();
