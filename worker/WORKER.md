# Forkpath worker: instructions for the dispatcher session

You run the job loop behind **Forkpath**, a branching alternate-history modeler. Users build timelines in a
web UI; their requests (Continue, Merge, Influence, Regenerate) become jobs in a queue. You pick jobs up and
hand **each job to a fresh `forkpath-writer` subagent**, which reads the brief, writes the history and
submits it. You keep doing this until the user tells you to stop.

**Why subagents:** a brief is 5-8k tokens and a result 1-4k. Writing jobs yourself would pile all of that into
this session. A subagent starts clean for every job and hands back one line, so this session stays small.

**Never read a brief or write a result yourself** (unless the fallback below applies). The writing rules live
in `.claude/agents/forkpath-writer.md`; you do not need to read them.

---

## 1. The loop

Run everything from the project root (`C:\Projects\AltHistory`).

```
┌─▶ node worker/next.mjs --id-only      (Bash, timeout 600000 ms: it waits up to 9 min)
│        │
│        ├─ NO_JOB        ──────────────────────────────────────────────┐
│        ├─ SERVER_DOWN   → say so in one line ─────────────────────────┤
│        └─ JOB <id> <TYPE>                                             │
│                 │                                                     │
│                 ▼                                                     │
│     Agent tool: subagent_type "forkpath-writer"                       │
│                 prompt "Job <id> (<TYPE>)."                           │
│                 background while fewer than 2 writers are running,    │
│                 otherwise foreground (this caps it at 3 at once)      │
│                 │                                                     │
│                 ▼                                                     │
│     relay the writer's one-line report when it arrives ───────────────┘
└──────────────────────────────────────────────────────────────────────
```

Rules:

1. **Always call `next.mjs` with `--id-only`, the Bash tool and `timeout: 600000`.** The default 2-minute
   timeout kills the wait, and without `--id-only` the whole brief lands in your context.
2. **Never stop on `NO_JOB`.** Run `next.mjs --id-only` again right away. No message to the user between polls.
3. **On `SERVER_DOWN`**, tell the user in one line that the backend is not running (`npm run dev`), then keep
   polling. Do not try to start or fix the server yourself.
4. **Spawning a writer:** use the Agent tool with `subagent_type: "forkpath-writer"` and the prompt
   `Job <id> (<TYPE>).` Nothing else is needed; the writer fetches the brief itself.
5. **How many at once:** keep count of writers you started in the background that have not reported yet.
   - Fewer than 2 running: start the new one in the **background** and poll again immediately.
   - 2 running: start the new one in the **foreground** (wait for it). That caps the work at 3 jobs at once.
   - Never end your turn while the loop should be running. Always go straight back to `next.mjs`.
6. **Reports:** each writer ends with one line (`✅ <id>: <titles>`, `🗑️ <id>: discarded`, or `❌ <id>: <reason>`).
   Relay it to the user as is. Nothing more per job.
7. **A writer failed or reported nothing useful:** check the job with `node worker/next.mjs --job <id>`
   only if you must; usually just tell the user in one line. Claimed jobs that never get a result return to
   the queue after 20 minutes, so nothing is lost.
8. Do not edit the app's source code, the `data/` folder, or anything outside `worker/out/`.
9. After a context compaction, re-read this file before continuing the loop.

---

## 2. Fallback: no subagents

If the Agent tool or the `forkpath-writer` subagent is not available (it is defined in
`.claude/agents/forkpath-writer.md`; a session started before that file existed must be restarted), do the
job yourself, one at a time:

1. Read `.claude/agents/forkpath-writer.md` once (it holds every writing rule and the JSON shapes).
2. For each job: `node worker/next.mjs` (without `--id-only`, it prints the brief), write
   `worker/out/<id>.json` with the Write tool, run `node worker/submit.mjs <id>`, fix and resubmit on `INVALID`.
3. Tell the user once that you are running without subagents, so the session will need compaction sooner.

---

## 3. Command reference

| Command | Output |
|---|---|
| `node worker/next.mjs --id-only` | `JOB <id> <TYPE>`, `NO_JOB` or `SERVER_DOWN` |
| `node worker/next.mjs --job <id>` | The brief for a job (writers use this) |
| `node worker/submit.mjs <id>` | `OK`, `INVALID`, `DISCARD` or `ERROR` (writers use this) |
| `node worker/submit.mjs <id> --fail "reason"` | Marks a job failed; the user can retry it |
| `node worker/search.mjs <id> "keywords"` | Events a job may link to (writers use this) |
