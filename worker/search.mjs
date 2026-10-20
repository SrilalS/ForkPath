#!/usr/bin/env node
// Finds events in other streams that may influence the node you are writing, however old.
//
//   node worker/search.mjs <jobId> "<keywords>"                 best matches (6)
//   node worker/search.mjs <jobId> "<keywords>" --before 1950   only events starting before 1950
//   node worker/search.mjs <jobId> "<keywords>" --after 1900    only events starting after 1900
//   node worker/search.mjs <jobId> "<keywords>" --limit 10      more results (max 12)
//   node worker/search.mjs <jobId> --node <nodeId>              one event in full
//
// Results only include events this job's node may link to. Events older than the influence window show
// only their key changes. Output starts with RESULTS, NO_RESULTS, NODE, NOT_FOUND or ERROR.

const BASE = process.env.FORKPATH_URL ?? process.env.ALTHISTORY_URL ?? 'http://127.0.0.1:5174';
const [jobId, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (!jobId) {
  console.log('ERROR usage: node worker/search.mjs <jobId> "<keywords>" [--before Y] [--after Y] [--limit N] | --node <id>');
  process.exit(1);
}

async function main() {
  const nodeId = opt('--node');
  let url;
  if (nodeId) {
    url = `${BASE}/api/worker/jobs/${jobId}/nodes/${encodeURIComponent(nodeId)}`;
  } else {
    const flags = new Set(['--before', '--after', '--limit']);
    const query = rest.filter((a, i) => !flags.has(a) && !flags.has(rest[i - 1])).join(' ');
    const params = new URLSearchParams({ q: query });
    for (const f of flags) if (opt(f) !== undefined) params.set(f.slice(2), opt(f));
    url = `${BASE}/api/worker/jobs/${jobId}/search?${params}`;
  }
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error ?? text;
    } catch {}
    console.log(`ERROR ${res.status}: ${msg}`);
    process.exit(1);
  }
  console.log(text);
}

main().catch((err) => {
  console.log(`ERROR ${err.cause?.code ?? err.message} (is the backend running at ${BASE}?)`);
  process.exit(1);
});
