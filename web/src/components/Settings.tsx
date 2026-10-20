import { useCallback, useEffect, useState } from 'react';
import type { WorkerStatus } from '../../../shared/types.ts';
import { api, type EngineId, type EnginePatch, type EngineView, type ProbeResult, type ProviderId } from '../api.ts';

/** Starting points for common endpoints: they fill in the protocol and URL; the model is still yours to pick. */
const PRESETS: { name: string; provider: ProviderId; baseUrl: string; hint: string }[] = [
  { name: 'Anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', hint: 'Key from console.anthropic.com' },
  { name: 'OpenAI', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', hint: 'Key from platform.openai.com' },
  { name: 'Google Gemini', provider: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', hint: 'Gemini API key, through its OpenAI-compatible endpoint' },
  { name: 'OpenRouter', provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', hint: 'One key for many providers' },
  { name: 'Ollama', provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', hint: 'Local; usually no key' },
  { name: 'LM Studio', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', hint: 'Local; it also offers Anthropic mode at the same URL' },
];

type Draft = {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  /** Typed here only; '' means "keep the stored key". */
  apiKey: string;
  concurrency: string;
  maxOutputTokens: string;
  maxToolCalls: string;
  maxRepairs: string;
  timeoutS: string;
  inputPerMTok: string;
  outputPerMTok: string;
  cachedInputPerMTok: string;
  monthlyUsd: string;
};

const str = (n: number | undefined) => (n === undefined ? '' : String(n));

function draftFrom(v: EngineView): Draft {
  const b = v.builtin;
  return {
    provider: b.provider,
    baseUrl: b.baseUrl,
    model: b.model,
    apiKey: '',
    concurrency: str(b.concurrency),
    maxOutputTokens: str(b.maxOutputTokens),
    maxToolCalls: str(b.maxToolCalls),
    maxRepairs: str(b.maxRepairs),
    timeoutS: str(Math.round(b.timeoutMs / 1000)),
    inputPerMTok: str(b.pricing.inputPerMTok),
    outputPerMTok: str(b.pricing.outputPerMTok),
    cachedInputPerMTok: str(b.pricing.cachedInputPerMTok),
    monthlyUsd: str(v.budget.monthlyUsd),
  };
}

const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
/** A price or cap field: empty clears it (null), otherwise a number. */
const optNum = (s: string) => (s.trim() === '' ? null : Number(s));

function patchFrom(d: Draft): EnginePatch {
  return {
    builtin: {
      provider: d.provider,
      baseUrl: d.baseUrl.trim(),
      model: d.model.trim(),
      ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
      concurrency: num(d.concurrency),
      maxOutputTokens: num(d.maxOutputTokens),
      maxToolCalls: num(d.maxToolCalls),
      maxRepairs: num(d.maxRepairs),
      timeoutMs: num(d.timeoutS) === undefined ? undefined : num(d.timeoutS)! * 1000,
      pricing: { inputPerMTok: optNum(d.inputPerMTok), outputPerMTok: optNum(d.outputPerMTok), cachedInputPerMTok: optNum(d.cachedInputPerMTok) },
    },
    budget: { monthlyUsd: optNum(d.monthlyUsd) },
  };
}

const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));
const fmtUsd = (n: number | undefined) => (n === undefined ? '-' : n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`);

export function SettingsPage({ worker, onError }: { worker: WorkerStatus | null; onError: (m: string) => void }) {
  const [view, setView] = useState<EngineView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | 'models' | 'engine' | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [preset, setPreset] = useState<string | null>(null);

  const load = useCallback(
    (resetDraft: boolean) =>
      api
        .getEngine()
        .then((v) => {
          setView(v);
          if (resetDraft) {
            setDraft(draftFrom(v));
            setDirty(false);
          }
        })
        .catch((e) => onError((e as Error).message)),
    [onError],
  );
  useEffect(() => {
    load(true);
  }, [load]);
  // Usage and status change as jobs finish: refresh the numbers (not the form) on every status broadcast.
  useEffect(() => {
    if (view) load(false);
  }, [worker?.pending, worker?.claimed, worker?.online, worker?.problem, worker?.engine]);

  if (!view || !draft) return <div className="loading">Loading settings...</div>;

  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
    setProbe(null);
  };

  async function run<T>(kind: NonNullable<typeof busy>, fn: () => Promise<T>) {
    setBusy(kind);
    try {
      return await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const switchEngine = (engine: EngineId) =>
    run('engine', async () => {
      // Switching to the built-in engine saves the form too, so it runs with what you see.
      const v = await api.saveEngine(engine === 'builtin' && dirty ? { ...patchFrom(draft), engine } : { engine });
      setView(v);
      if (engine === 'builtin') {
        setDraft(draftFrom(v));
        setDirty(false);
      }
    });

  const status = worker ?? view.status;
  const b = view.builtin;
  const month = view.usage.month;
  const cap = view.budget.monthlyUsd;
  const keyNote =
    b.keySource === 'config' ? 'A key is stored in data/config.json.' : b.keySource.startsWith('env:') ? `Using the ${b.keySource.slice(4)} environment variable.` : 'No key set.';

  return (
    <div className="doc">
      <div className="doc__inner settings">
        <header className="doc__head">
          <h1>Settings</h1>
          <p className="doc__lead">Choose what generates your timelines: your Claude Code worker session, or a model API called by this app.</p>
        </header>

        <section className="doc__section">
          <h2>
            <span className="doc__icon">🤖</span>Engine
          </h2>
          <div className="segmented" role="radiogroup" aria-label="Engine">
            {(
              [
                ['external', '🖥️ Claude Code worker', 'A Claude Code session you start runs the jobs (worker/WORKER.md)'],
                ['builtin', '🔌 Built-in model API', 'This app calls the model below directly'],
              ] as const
            ).map(([id, title, sub]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={view.engine === id}
                className={view.engine === id ? 'is-active' : ''}
                disabled={busy !== null}
                onClick={() => view.engine !== id && switchEngine(id)}
              >
                <strong>{title}</strong>
                <span>{sub}</span>
              </button>
            ))}
          </div>
          <div className={`settings__status ${status.online ? 'is-ok' : 'is-warn'}`}>
            <span className={`dot ${status.online ? 'dot--on' : 'dot--off'}`} />
            {status.engine === 'builtin'
              ? status.online
                ? `Running: ${status.label}`
                : `Not running: ${status.problem ?? 'check the settings below'}`
              : status.online
                ? 'The worker session is connected.'
                : 'No worker session connected. Start one with the prompt in the Guide, or switch to the built-in engine.'}
            {status.pending + status.claimed > 0 && <span className="muted"> · {status.pending + status.claimed} in queue</span>}
          </div>
          <p className="muted small">Only the active engine gets jobs; the other one waits. Queued jobs move over when you switch.</p>
        </section>

        <form
          className="doc__section form"
          onSubmit={(e) => {
            e.preventDefault();
            run('save', async () => {
              const v = await api.saveEngine(patchFrom(draft));
              setView(v);
              setDraft(draftFrom(v));
              setDirty(false);
            });
          }}
        >
          <h2>
            <span className="doc__icon">🔌</span>Built-in model
          </h2>
          <div className="chips">
            {PRESETS.map((p) => (
              <button
                type="button"
                key={p.name}
                className={`chip ${preset === p.name ? 'is-active' : ''}`}
                title={p.hint}
                onClick={() => {
                  setPreset(p.name);
                  setModels([]);
                  set({ provider: p.provider, baseUrl: p.baseUrl });
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
          {preset && <span className="field__hint">{PRESETS.find((p) => p.name === preset)?.hint}</span>}

          <div className="field-row">
            <label className="field">
              <span className="field__label">Protocol</span>
              <select value={draft.provider} onChange={(e) => set({ provider: e.target.value as ProviderId })}>
                <option value="anthropic">Anthropic Messages</option>
                <option value="openai-compatible">OpenAI-compatible (Chat Completions)</option>
              </select>
            </label>
            <label className="field">
              <span className="field__label">Base URL</span>
              <input value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.anthropic.com/v1" />
            </label>
          </div>

          <label className="field">
            <span className="field__label">API key</span>
            <input
              type="password"
              autoComplete="off"
              value={draft.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
              placeholder={b.hasKey ? 'Leave empty to keep the current key' : 'Paste a key (local servers usually need none)'}
            />
            <span className="field__hint">
              {keyNote} Keys stay on this computer (the file is not committed) and are never sent back to the browser.
              {b.keySource === 'config' && (
                <>
                  {' '}
                  <button type="button" className="link-btn" onClick={() => run('save', async () => setView(await api.saveEngine({ builtin: { apiKey: '' } })))}>
                    Remove stored key
                  </button>
                </>
              )}
            </span>
          </label>

          <label className="field">
            <span className="field__label">Model</span>
            <div className="settings__inline">
              <input list="settings-models" value={draft.model} onChange={(e) => set({ model: e.target.value })} placeholder="e.g. claude-sonnet-4-6" />
              <datalist id="settings-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <button
                type="button"
                className="btn btn--small"
                disabled={busy !== null}
                onClick={() =>
                  run('models', async () => {
                    const r = await api.listModels(patchFrom(draft));
                    setModels(r.models);
                    if (!r.models.length) onError('The endpoint listed no models.');
                  })
                }
              >
                {busy === 'models' ? 'Loading...' : models.length ? `${models.length} models` : 'Load models'}
              </button>
            </div>
          </label>

          <details className="settings__advanced">
            <summary>Advanced</summary>
            <div className="field-row">
              <NumField label="Jobs at once" value={draft.concurrency} onChange={(v) => set({ concurrency: v })} min={1} max={8} />
              <NumField label="Max output tokens" value={draft.maxOutputTokens} onChange={(v) => set({ maxOutputTokens: v })} min={1000} max={64000} />
              <NumField label="Searches per job" value={draft.maxToolCalls} onChange={(v) => set({ maxToolCalls: v })} min={0} max={10} />
            </div>
            <div className="field-row">
              <NumField label="Repair attempts" value={draft.maxRepairs} onChange={(v) => set({ maxRepairs: v })} min={0} max={5} />
              <NumField label="Timeout (seconds)" value={draft.timeoutS} onChange={(v) => set({ timeoutS: v })} min={10} max={900} />
            </div>
            <span className="field__hint">Thinking models spend part of the output tokens on hidden reasoning. Slow local models need a longer timeout.</span>
          </details>

          <h3>💲 Cost and budget</h3>
          <div className="field-row">
            <NumField label="Input $ / 1M tokens" value={draft.inputPerMTok} onChange={(v) => set({ inputPerMTok: v })} step="any" min={0} />
            <NumField label="Output $ / 1M tokens" value={draft.outputPerMTok} onChange={(v) => set({ outputPerMTok: v })} step="any" min={0} />
            <NumField label="Cached input $ / 1M" value={draft.cachedInputPerMTok} onChange={(v) => set({ cachedInputPerMTok: v })} step="any" min={0} placeholder="= input" />
          </div>
          <div className="field-row">
            <NumField label="Monthly budget ($)" value={draft.monthlyUsd} onChange={(v) => set({ monthlyUsd: v })} step="any" min={0} placeholder="No cap" />
          </div>
          <span className="field__hint">
            Prices come from your provider's price page; without them only tokens are counted. When the month's spend reaches the budget, new jobs wait
            in the queue (jobs already running finish).
          </span>

          {probe && (
            <div className={`alert ${probe.ok ? 'alert--ok' : 'alert--error'}`}>
              {probe.ok ? '✅ Connected' : '❌ Failed'}
              {probe.label && ` · ${probe.label}`} · {(probe.ms / 1000).toFixed(1)}s
              {probe.inputTokens !== undefined && ` · ${probe.inputTokens} in / ${probe.outputTokens} out`}
              <div className="small">{probe.detail}</div>
            </div>
          )}

          <div className="form__actions">
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => run('test', async () => setProbe(await api.testEngine(patchFrom(draft))))}
              title="One short request with the settings above (saved or not)"
            >
              {busy === 'test' ? 'Testing...' : 'Test connection'}
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy !== null || !dirty}>
              {busy === 'save' ? 'Saving...' : dirty ? 'Save' : 'Saved'}
            </button>
          </div>
        </form>

        <section className="doc__section">
          <h2>
            <span className="doc__icon">📊</span>Usage this month <span className="muted small">({month.month}, built-in engine)</span>
          </h2>
          <div className="settings__stats">
            <Stat label="Spent" value={fmtUsd(month.costUsd)} note={cap !== undefined ? `of ${fmtUsd(cap)} budget` : month.unpriced ? `${month.unpriced} job(s) without prices` : undefined} />
            <Stat label="Jobs" value={String(month.jobs)} note={month.failed ? `${month.failed} failed` : undefined} />
            <Stat label="Input tokens" value={fmtTokens(month.inputTokens)} note={month.cachedInputTokens ? `${fmtTokens(month.cachedInputTokens)} cached` : undefined} />
            <Stat label="Output tokens" value={fmtTokens(month.outputTokens)} />
          </div>
          {cap !== undefined && cap > 0 && (
            <div className="settings__meter" title={`${fmtUsd(month.costUsd)} of ${fmtUsd(cap)}`}>
              <span style={{ width: `${Math.min(100, (month.costUsd / cap) * 100)}%` }} />
            </div>
          )}
          {view.usage.recent.length > 0 && (
            <div className="doc__table settings__recent">
              <div className="doc__row doc__row--head">
                <span>When</span>
                <span>Job</span>
                <span>Tokens · cost · time</span>
              </div>
              {view.usage.recent.map((e) => (
                <div className="doc__row" key={e.jobId + e.at}>
                  <span className="muted">{new Date(e.at).toLocaleString()}</span>
                  <span>
                    {e.outcome === 'done' ? '✅' : e.outcome === 'failed' ? '❌' : '🗑️'} {e.jobType} <span className="muted small">{e.model}</span>
                  </span>
                  <span>
                    {fmtTokens(e.inputTokens)} in / {fmtTokens(e.outputTokens)} out · {fmtUsd(e.costUsd)} · {Math.round(e.durationMs / 1000)}s
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  ...rest
}: { label: string; value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input type="number" value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
    </label>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="settings__stat">
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}
