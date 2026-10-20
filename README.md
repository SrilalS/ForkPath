# Forkpath

A branching alternate-history modeler. You describe a point of divergence, and a language model maps out what
happens next, event by event, as a living map instead of a single story. It branches where outcomes are genuinely
uncertain, tracks separate storylines (regions, programs, movements) side by side, and lets them influence and
merge into each other. You can edit, regenerate, branch or delete any event, and your edits become fact for
everything after them.

Created by **Srilal Siriwardhane**. Licensed under the [MIT License](LICENSE).

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

## Quick start

1. Install and run the app:

   ```bash
   npm install
   ```

   ```bash
   npm run dev
   ```

   UI: http://localhost:5173 (API on :5174).

2. Pick an engine (see below). The default is the Claude Code worker: open a **new Claude Code session in this
   folder** and send it this prompt:

   > You are the Forkpath worker. Read `worker/WORKER.md` and follow it exactly. Start the job loop now and keep
   > it running until I tell you to stop.

   The sidebar shows **Worker online** while it is polling. Jobs created while it is offline wait in the queue.
   Restart the worker session after updating the app, so it loads the current `WORKER.md` and writer rules.

`.claude/settings.json` pre-approves the worker commands (next, submit, search) and writes to `worker/out/`, so
the worker session does not stop for permission prompts.

## Engines: Claude Code worker or a model API

Jobs go to exactly one **engine**; the other gets `NO_JOB`. The easiest way to set it up is the **Settings** page
(sidebar): pick the engine, choose a preset (Anthropic, OpenAI, Google Gemini, OpenRouter, Ollama, LM Studio),
paste a key, load the model list, **Test connection**, and save. Settings are stored in `data/config.json`
(gitignored, may hold an API key; hand edits apply without a restart).

| Engine | What runs the model | Set up |
|---|---|---|
| `external` (default) | The Claude Code worker session. A dispatcher polls for jobs and hands each to a fresh `forkpath-writer` subagent, up to 3 at once | Start the worker session |
| `builtin` | This server calls a model API directly through plain `fetch` adapters (no SDKs), up to `concurrency` jobs at once | Settings page, or `builtin` below |

```json
{
  "engine": "builtin",
  "builtin": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "apiKey": "sk-...",
    "concurrency": 3
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `provider` | `anthropic` | `anthropic` (Messages API) or `openai-compatible` (Chat Completions: OpenAI, Gemini's `/v1beta/openai`, OpenRouter, Groq, DeepSeek, Mistral, Ollama, LM Studio, vLLM) |
| `model` | (required) | The provider's model id |
| `baseUrl` | `https://api.anthropic.com/v1` / `https://api.openai.com/v1` | e.g. `http://localhost:1234/v1` for LM Studio, `http://localhost:11434/v1` for Ollama |
| `apiKey` / `apiKeyEnv` | env `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Local servers on localhost may need none |
| `concurrency` | 3 | Jobs generated at once |
| `maxOutputTokens` | 8000 | Thinking models spend part of this on hidden reasoning |
| `maxToolCalls` | 4 | Searches per job |
| `maxRepairs` | 2 | Invalid results sent back for fixing before the job fails |
| `timeoutMs` | 300000 | Per request; raise it for slow local models |
| `pricing` | none | `inputPerMTok`, `outputPerMTok`, `cachedInputPerMTok` in USD per million tokens, from your provider's price page. Without them only tokens are counted |
| `budget.monthlyUsd` (top level) | none | Monthly spending cap (UTC calendar month). When reached, new jobs wait in the queue; running ones finish |

Both engines use the same briefs, validation, follow-ups and writer rules (`.claude/agents/forkpath-writer.md`).
Every built-in job is logged in `data/usage.jsonl` (tokens, cost, outcome, including failed jobs); Settings shows
the month's totals and recent jobs. Each generated node records which engine and model wrote it (with tokens,
cost and time for built-in jobs) at the bottom of its side panel.

## Concepts

| Concept | Meaning |
|---|---|
| 🌊 Streams | Your branches, "Continue another way" and parallel threads are separate lines of events in **one shared world** (one per country, say). Streams can influence each other and merge. A stream can be renamed when its focus moves on |
| 🔀 Alternatives | When the model writes several possible outcomes with likelihoods, only one of them happens. Nothing under one alternative can influence anything under another |
| 🎲 Path odds | The chance history reaches a node: each fork's share for the outcome taken (scaled so a fork adds up to 100%), multiplied over every fork on the way. Shown in the side panel |
| 🎨 Significance and tone | Every node is minor, notable, major or pivotal, with a tone (conflict, catastrophe, upheaval, decline, prosperity, discovery, diplomacy, neutral). Selecting a major or pivotal node recolors the UI; the node before one shows an "ahead" warning. Re-rating in **Edit** does not mark later nodes stale |
| ⚠️ Stale | Editing a node marks everything after it, and everything it influences, as stale until you regenerate or keep it |

## Using it

| Action | How |
|---|---|
| 🌱 New timeline | Type a "What if" on the start page, or **+ New timeline** |
| ▶️ Continue | Hover a node and click **+**, or select it and use **Continue** (optional time span and guidance) |
| 🔀 Another continuation | **Continue another way** on a node that already has children; the model sees the existing ones |
| 🌿 Branch here | Describe a new change at that point, as an **Alternative** (separate branch) or a **Parallel thread** (alongside). The original path stays |
| ⇢ Influence | **Influence...** on a node, click 1-4 highlighted nodes in other streams, then **Influence N**. Pick a strength and optional guidance; the model writes a new event after each picked node, shaped by this one, with a dotted orange arrow |
| ⤚⤙ Merge | **Merge with...** on a node, click 1-4 nodes on separate branches, then **Merge N**. The model writes where the storylines meet; Branch A wins conflicts unless your guidance says otherwise |
| ✏️ Edit | Rewrite any field, including the stream name. Later and influenced nodes get marked **Stale** |
| ♻️ Regenerate, Keep | **Regenerate** rewrites a node to fit what came before (optional guidance). **Keep** or **Keep whole branch** clears the stale mark |
| 🔍 Review | **Review** in the side panel: another writer checks the event for contradictions, anachronisms, unearned outcomes, causality gaps and numbers out of scale (a REVIEW job: no search tools, a compact brief, about a third to half of a writing job). The verdict and flags show in the panel, problems as a badge on the card; **Fix with Regenerate** sends the fixes as guidance. Editing or regenerating the event clears its review |
| ★ Most likely | Top bar toggle. Fades every node outside the most likely history: at each fork, the outcome the model rated highest |
| ⑂ Turning points | Top bar. A date-ordered list of every fork (with each outcome's share) and every pivotal event; click one to jump to it |
| ◷ Align by time | Top bar toggle. Columns follow each node's start date, so events in different branches line up. Remembered per timeline |
| 💾 Save branch, Export | **Save branch** in the side panel downloads the path to a node plus everything after it. **Export** in the top bar downloads the whole timeline |
| 📂 Import | **Import** in the sidebar opens a saved file as a new timeline (fresh ids, so importing twice is safe) |
| 📖 Guide, About, Settings | Sidebar links (`#/guide`, `#/about`, `#/settings`). The Guide explains every concept and action on screen |
| ⇤ Sidebar, ↔️ panel | The arrow next to the logo collapses the sidebar to an icon rail. Drag the side panel's left edge to resize it (double-click resets). Both are remembered |

### 🎛️ Generation options

Every Continue, Branch, Merge, Influence and Regenerate form has these, stored per request:

| Option | Choices |
|---|---|
| Time span | How far ahead the next event goes, e.g. "6 months" |
| Guidance | Free text the writer must follow |
| Temperament | **Realist** (default: incentives, capabilities and base rates decide), **Grim** or **Hopeful** (lean that way only when outcomes are close) |
| Narrative | **Beats** (default: dated bullet points that keep every fact an essay would, plus a "Why:" line) or **Full story** (prose paragraphs) |
| Plausibility review | **Off** (default), **Agent decides** (the writer adds `requestReview` to nodes it is unsure of) or **Every event**. Follow-ups inherit it |

### 🧠 What the writer does on its own

- **Branches** into exclusive alternatives with likelihoods when the outcome is genuinely uncertain, and explains why.
- **Realism check** before writing: actors' incentives, capabilities and historical base rates, so outcomes are
  neither optimistic nor pessimistic by default.
- **Links** its event to events in other streams within 15 years (`INFLUENCE_WINDOW_YEARS` in `shared/world.ts`),
  and can **search** older ones (old hits show only their key changes). It never links alternatives that
  exclude each other.
- **Follow-ups**: when an event hits another stream hard, it can request up to 2 events after that stream's latest
  one. They run as parallel jobs and cannot request more.
- **Renames a stream** when its focus has moved on (a "Vietnam War" thread that is now about Iran).
- Results are checked before anything is saved, and sent back for fixing when they break a rule: unknown
  fields, dates that run backwards or have no year, links or follow-ups to events that do not exist (or are
  not the latest in their stream), follow-ups from alternatives, an alternative with over 75% of the odds, or
  an INFLUENCE result without its note.
- Long chains stay cheap: the brief gives only key changes for all but the last 8 events, and only the
  influence links on the last 3. The built-in engine caches the writer rules and the brief across a job's
  requests (Anthropic).

## File format versioning

Timelines and exported files carry a `schemaVersion` (`SCHEMA_VERSION` in `shared/types.ts`).

- On startup, older files in `data/timelines/` are upgraded in place. The original is kept as `<id>.v<N>.bak.json`.
- Imports run the same migrations, so old exports always open.
- Current version: **v7** (v2 added significance/tone, v3 added convergence `mergeParents`, v4 added threads and influence links, v5 added stream renames `streamName`, v6 added the per-node `generation` record, v7 added the per-node plausibility `review`).
- A file from a newer app version is rejected with a clear message instead of being half-loaded.
- To change the format: bump `SCHEMA_VERSION` and add a step in `server/src/migrate.ts` keyed by the old version.

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
| `server/test/` | Adapter contract tests and graph rule tests (`npm test`) |
| `web/src/App.tsx` | Routes, sidebar, canvas, top bar |
| `web/src/placement.ts`, `web/src/layout.worker.ts`, `web/src/usePlacement.ts` | Card positions (dagre or time-aligned); from 400 nodes a changed layout runs in a Web Worker |
| `web/src/layout.ts`, `web/src/graph.ts` | Flow nodes and edges (reused when unchanged) and UI helpers over `shared/world.ts` |
| `web/src/components/` | Side panel, forms, Turning points, Settings, Guide and About pages |
| `web/src/mood.ts` | Tone colors and the mood-theme rules |
| `worker/WORKER.md` | The dispatcher's instructions: the job loop, one subagent per job |
| `.claude/agents/forkpath-writer.md` | The writer: rules, realism, when to branch, links, follow-ups, JSON shapes (both engines) |
| `worker/next.mjs`, `worker/submit.mjs`, `worker/search.mjs` | The worker's commands |
| `data/` | Timelines (`timelines/*.json`), job queue, engine config and usage. Delete it to start fresh |

## Config

| Env var | Default | Used by |
|---|---|---|
| `FORKPATH_API_PORT` | `5174` | backend (also update `web/vite.config.ts` proxy if changed) |
| `FORKPATH_HOST` | `127.0.0.1` | backend bind address. Loopback only by default, because the API can hold an API key and spend money. Use `0.0.0.0` only on a trusted network |
| `FORKPATH_URL` | `http://127.0.0.1:5174` | worker scripts |

The names from before the rename (`ALTHISTORY_*`) still work.

Production-style run: `npm run build` then `npm start`, and open http://localhost:5174.

## License

[MIT](LICENSE), copyright (c) 2026 Srilal Siriwardhane.
