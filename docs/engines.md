# Engines: Claude Code worker or a model API

Jobs go to exactly one **engine**; the other gets `NO_JOB`. The easiest way to set it up is the **Settings** page
(sidebar): pick the engine, choose a preset (Anthropic, OpenAI, Google Gemini, OpenRouter, Ollama, LM Studio),
paste a key, load the model list, **Test connection**, and save.

| Engine | What runs the model | Set up |
|---|---|---|
| `external` (default) | A Claude Code session you start. A dispatcher polls for jobs and hands each to a fresh `forkpath-writer` subagent, up to 3 at once | Start the worker session (below) |
| `builtin` | This server calls a model API directly through plain `fetch` adapters (no SDKs), up to `concurrency` jobs at once | Settings page, or `data/config.json` |

Both engines use the same briefs, validation, follow-ups and writer rules (`.claude/agents/forkpath-writer.md`).

## The Claude Code worker

Open a **new Claude Code session in the project folder** and send it this prompt:

> You are the Forkpath worker. Read `worker/WORKER.md` and follow it exactly. Start the job loop now and keep
> it running until I tell you to stop.

- The sidebar shows **Worker online** while it is polling. Jobs created while it is offline wait in the queue.
- `.claude/settings.json` pre-approves the worker commands (next, submit, search) and writes to `worker/out/`,
  so the session does not stop for permission prompts.
- Restart the worker session after updating the app, so it loads the current `WORKER.md` and writer rules.

## The built-in model API

Settings are stored in `data/config.json` (gitignored, may hold an API key; hand edits apply without a restart).

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

## Cost and tokens

- Every built-in job is logged in `data/usage.jsonl` (tokens, cost, outcome, including failed jobs). Settings
  shows the month's totals and recent jobs. Each generated node records which engine and model wrote it (with
  tokens, cost and time for built-in jobs) at the bottom of its side panel.
- Long chains stay cheap: the brief gives only key changes for all but the last 8 events, and only the influence
  links on the last 3.
- The writer rules and the brief are cached across a job's requests (Anthropic). A storyline's oldest events open
  the brief and stay byte-identical for several jobs in a row, so jobs along one branch can share that cache too.
- A plausibility review has no search tools and a compact brief: about a third to half of a writing job.

## Server settings

| Env var | Default | Used by |
|---|---|---|
| `FORKPATH_API_PORT` | `5174` | backend (also update `web/vite.config.ts` proxy if changed) |
| `FORKPATH_HOST` | `127.0.0.1` | backend bind address. Loopback only by default, because the API can hold an API key and spend money. Use `0.0.0.0` only on a trusted network |
| `FORKPATH_URL` | `http://127.0.0.1:5174` | worker scripts |

The names from before the rename (`ALTHISTORY_*`) still work.
