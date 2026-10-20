#!/usr/bin/env node
// Submits the result for a job.
//
//   node worker/submit.mjs <jobId>                    send worker/out/<jobId>.json
//   node worker/submit.mjs <jobId> path/to/file.json  send a different file
//   node worker/submit.mjs <jobId> --fail "reason"    report that you cannot do this job
//
// Output starts with:
//   OK         accepted; go back to `node worker/next.mjs`
//   INVALID    the JSON did not match the schema; fix the listed fields and submit again
//   DISCARD    the user cancelled or deleted it; move on to the next job
//   ERROR      anything else

import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.ALTHISTORY_URL ?? 'http://localhost:5174';
const [jobId, ...rest] = process.argv.slice(2);
if (!jobId) {
  console.log('ERROR usage: node worker/submit.mjs <jobId> [file | --fail "reason"]');
  process.exit(1);
}

async function post(url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  if (rest[0] === '--fail') {
    const { status, data } = await post(`/api/worker/jobs/${jobId}/fail`, { error: rest[1] ?? 'unspecified' });
    console.log(status < 300 ? 'OK failure recorded' : `ERROR ${status}: ${data.error}`);
    return;
  }

  const file = rest[0] ?? path.join(import.meta.dirname, 'out', `${jobId}.json`);
  let body;
  try {
    body = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    console.log(`INVALID could not read JSON from ${file}: ${err.message}`);
    process.exit(1);
  }

  const { status, data } = await post(`/api/worker/jobs/${jobId}/result`, body);
  if (status < 300) {
    const nodes = data.created?.length ? data.created : data.updated;
    console.log(`OK ${JSON.stringify(nodes)}${data.links ? ` (+${data.links} link${data.links > 1 ? 's' : ''})` : ''}`);
    for (const d of data.dropped ?? []) console.log(`  dropped link: ${d}`);
    fs.rmSync(file, { force: true });
  } else if (status === 400) {
    console.log(`INVALID\n${data.error}`);
    process.exit(1);
  } else if (status === 410) {
    console.log(`DISCARD ${data.error}`);
    fs.rmSync(file, { force: true });
  } else {
    console.log(`ERROR ${status}: ${data.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.log(`ERROR ${err.cause?.code ?? err.message} (is the backend running at ${BASE}?)`);
  process.exit(1);
});
