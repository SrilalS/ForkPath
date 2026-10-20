# Development

TypeScript end to end: a React UI, an Express server, and types and graph rules shared between them.

```bash
npm install
npm run dev          # UI on http://localhost:5173, API on :5174
npm run typecheck
npm test             # adapter contracts, graph rules, validation, briefs
npm run build        # production UI; then `npm start` serves it on :5174
```

## How a job flows

```
 Browser (React Flow UI)          Backend (Express, :5174)                 Engine (one of)
 ───────────────────────          ────────────────────────                 ───────────────
 click Continue      ──POST──▶    placeholder node + job queued
                                  brief: context, nearby events,     ──▶   Claude Code worker session
                                  realism check, writer rules              (one writer subagent per job)
                                                                           or
                                                                           built-in runner calling a model
                                                                           API (Anthropic, OpenAI-compatible)
 node appears live   ◀──SSE──     validate, check dates, apply  ◀──────   JSON result
```

## Layout

| Path | What |
|---|---|
| `shared/types.ts` | Types used by both sides |
| `shared/world.ts` | Streams vs alternatives, which nodes share a world, valid influence links, path odds and the most likely history |
| `server/src/index.ts` | REST routes, worker API, starting jobs |
| `server/src/jobs.ts` | Job queue, long polling, engine-aware claims, worker presence, timeouts |
| `server/src/brief.ts` | Turns a job into the brief the writer reads (context, nearby events, realism check, options) |
| `server/src/schema.ts` | Zod validation of results and user input |
| `server/src/apply.ts` | Applies results (alternatives, threads, links, follow-ups, renames), chronology checks, stale propagation |
| `server/src/search.ts` | Keyword search over older events |
| `server/src/runner.ts` | The built-in engine: claims jobs, calls the provider, runs tools, repairs invalid results |
| `server/src/llm/` | Provider adapters on plain `fetch`: `anthropic.ts`, `openai.ts` (OpenAI-compatible) |
| `server/src/config.ts` | Engine config (`data/config.json`), pricing and budget |
| `server/src/usage.ts` | Token and cost ledger (`data/usage.jsonl`) |
| `server/src/migrate.ts` | Schema version upgrades for stored and imported timelines |
| `server/src/transfer.ts` | Export (timeline or branch) and import |
| `server/test/` | Tests (`npm test`) |
| `web/src/App.tsx` | Routes, sidebar, canvas, top bar |
| `web/src/placement.ts`, `layout.worker.ts`, `usePlacement.ts` | Card positions (dagre or time-aligned); from 400 nodes a changed layout runs in a Web Worker |
| `web/src/layout.ts`, `web/src/graph.ts` | Flow nodes and edges (reused when unchanged) and UI helpers over `shared/world.ts` |
| `web/src/components/` | Side panel, forms, Turning points, Settings, Guide and About pages |
| `web/src/mood.ts` | Tone colors and the mood-theme rules |
| `worker/WORKER.md` | The dispatcher's instructions: the job loop, one subagent per job |
| `.claude/agents/forkpath-writer.md` | The writer: rules, realism, when to branch, links, follow-ups, reviews, JSON shapes (both engines) |
| `worker/next.mjs`, `submit.mjs`, `search.mjs` | The worker's commands |
| `data/` | Timelines (`timelines/*.json`), job queue, engine config and usage. Delete it to start fresh |

## File format versioning

Timelines and exported files carry a `schemaVersion` (`SCHEMA_VERSION` in `shared/types.ts`).

- On startup, older files in `data/timelines/` are upgraded in place. The newest original is kept as `<id>.v<N>.bak.json`.
- Imports run the same migrations, so old exports always open.
- Current version: **v7** (v2 added significance/tone, v3 added convergence `mergeParents`, v4 added threads and influence links, v5 added stream renames `streamName`, v6 added the per-node `generation` record, v7 added the per-node plausibility `review`).
- A file from a newer app version is rejected with a clear message instead of being half-loaded.
- To change the format: bump `SCHEMA_VERSION` and add a step in `server/src/migrate.ts` keyed by the old version.
