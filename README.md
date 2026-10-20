# AltHistory

A branching alternate-history modeler. You describe a point of divergence, and a language model maps out what
happens next, node by node. You can edit any node, continue from it, or branch off with a new deviation. The model
branches on its own when outcomes are genuinely uncertain.

There is no API key. The language model is a **Claude Code session** that polls the backend for jobs and writes
the results back.

```
 Browser (React Flow UI)          Backend (Express, :5174)              Claude Code worker session
 ───────────────────────          ────────────────────────              ──────────────────────────
 click Continue        ──POST──▶  placeholder node + job queued
                                  GET /api/worker/next (long poll) ◀── node worker/next.mjs
                                  ── job brief (markdown) ────────────▶ writes worker/out/<id>.json
                                  POST /api/worker/jobs/<id>/result ◀── node worker/submit.mjs <id>
 node appears live     ◀──SSE──   validate, apply, broadcast
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

2. Start the worker: open a **new Claude Code session in this folder** and send it this prompt:

   > You are the AltHistory worker. Read `worker/WORKER.md` and follow it exactly. Start the job loop now and keep
   > it running until I tell you to stop.

   The sidebar shows **Worker online** while it is polling. Jobs created while it is offline wait in the queue.

`.claude/settings.json` pre-approves the two worker commands and writes to `worker/out/`, so the worker session
does not stop for permission prompts.

## Using it

| Action | How |
|---|---|
| 🌱 New timeline | Type a "What if" on the start page, or **+ New timeline** |
| ▶️ Continue | Hover a node and click **+**, or select it and use **Continue** (optional time span and guidance) |
| 🔀 Another continuation | **Continue another way** on a node that already has children; the model sees the existing ones |
| 🌿 New deviation | **Branch here**: you describe a change at that point; the original path stays |
| ✏️ Edit | **Edit** a node. Every node after it gets marked **Stale** |
| ♻️ Stale nodes | **Regenerate** (model rewrites it to fit), **Keep**, or **Keep whole branch** |

| ⤚⤙ Merge | **Merge with...** on a node, then click a highlighted node on a separate branch. The model writes where the two storylines meet (same world, Branch A wins conflicts unless your guidance says otherwise) |
| ◷ Align by time | Top-bar toggle. Columns are ordered by each node's start date (parsed from its period), so events in different branches line up. Undated nodes sit just after their parent. Remembered per timeline |
| ↔️ Panel width | Drag the side panel's left edge; double-click it to reset. The width is remembered |
| 💾 Save branch | **Save branch** in the side panel downloads the path to that node plus everything after it. **Export** in the top bar downloads the whole timeline |
| 📂 Import | **Import** in the sidebar opens a saved file as a new timeline (fresh ids, so importing twice is safe) |

Model-made branches show a likelihood on the edge and card, plus the reason for the split in the side panel.

### 🎨 Mood theme

Every generated node has a **significance** (minor, notable, major, pivotal) and a **tone** (conflict,
catastrophe, upheaval, decline, prosperity, discovery, diplomacy, neutral). Selecting a major or pivotal node
recolors the UI in its tone. Selecting the node just before one gives a faint tint and an "ahead" pill, as a
warning. You can re-rate both in **Edit** without marking later nodes stale.

## File format versioning

Timelines and exported files carry a `schemaVersion` (`SCHEMA_VERSION` in `shared/types.ts`).

- On startup, older files in `data/timelines/` are upgraded in place. The original is kept as `<id>.v<N>.bak.json`.
- Imports run the same migrations, so old exports always open.
- Current version: **v3** (v2 added significance/tone, v3 added convergence `mergeParents`).
- A file from a newer app version is rejected with a clear message instead of being half-loaded.
- To change the format: bump `SCHEMA_VERSION` and add a step in `server/src/migrate.ts` keyed by the old version.

## Layout

| Path | What |
|---|---|
| `server/src/index.ts` | REST routes, worker API, applying results |
| `server/src/jobs.ts` | Job queue, long polling, worker presence, claim timeout (20 min) |
| `server/src/brief.ts` | Turns a job into the markdown brief the worker reads |
| `server/src/schema.ts` | Zod validation of worker results and user input |
| `server/src/migrate.ts` | Schema version upgrades for stored and imported timelines |
| `server/src/transfer.ts` | Export (timeline or branch) and import |
| `web/src/mood.ts` | Tone colors and the mood-theme rules |
| `web/src/` | React UI (React Flow canvas, dagre layout, side panel) |
| `shared/types.ts` | Types used by both sides |
| `worker/WORKER.md` | The worker's instructions: loop, writing rules, when to branch, JSON shape |
| `worker/next.mjs`, `worker/submit.mjs` | The worker's two commands |
| `data/` | Timelines (`timelines/*.json`) and the job queue (`jobs.json`). Delete it to start fresh |

## Config

| Env var | Default | Used by |
|---|---|---|
| `ALTHISTORY_API_PORT` | `5174` | backend (also update `web/vite.config.ts` proxy if changed) |
| `ALTHISTORY_URL` | `http://localhost:5174` | worker scripts |

Production-style run: `npm run build` then `npm start`, and open http://localhost:5174.
