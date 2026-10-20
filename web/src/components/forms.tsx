import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { DeviationInput, GenerateOptions } from '../api.ts';
import { STRENGTHS, type Strength } from '../../../shared/types.ts';

export const SPAN_PRESETS = ['Auto', '1 year', '5 years', '10 years', '25 years', '50 years', '100 years'];

export function Modal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal__head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Time span chips plus a custom value and optional guidance. */
export function GenerateOptionsFields({ value, onChange }: { value: GenerateOptions; onChange: (v: GenerateOptions) => void }) {
  const span = value.timeSpan ?? '';
  const isPreset = span === '' || SPAN_PRESETS.includes(span);
  const [custom, setCustom] = useState(!isPreset);
  return (
    <>
      <label className="field">
        <span className="field__label">How far ahead?</span>
        <div className="chips">
          {SPAN_PRESETS.map((p) => {
            const active = !custom && (p === 'Auto' ? span === '' : span === p);
            return (
              <button
                type="button"
                key={p}
                className={`chip ${active ? 'is-active' : ''}`}
                onClick={() => {
                  setCustom(false);
                  onChange({ ...value, timeSpan: p === 'Auto' ? '' : p });
                }}
              >
                {p}
              </button>
            );
          })}
          <button type="button" className={`chip ${custom ? 'is-active' : ''}`} onClick={() => setCustom(true)}>
            Custom
          </button>
        </div>
        {custom && (
          <input
            autoFocus
            placeholder='e.g. "until 1900", "6 months", "one generation"'
            value={span}
            onChange={(e) => onChange({ ...value, timeSpan: e.target.value })}
          />
        )}
        {!custom && span === '' && <span className="field__hint">The model picks a span that fits the next development.</span>}
      </label>
      <label className="field">
        <span className="field__label">
          Guidance <em>optional</em>
        </span>
        <textarea
          rows={2}
          placeholder="e.g. focus on Asia, follow the economic fallout, keep it grim"
          value={value.guidance ?? ''}
          onChange={(e) => onChange({ ...value, guidance: e.target.value })}
        />
      </label>
    </>
  );
}

export function DeviationFields({ value, onChange, autoFocus }: { value: DeviationInput; onChange: (v: DeviationInput) => void; autoFocus?: boolean }) {
  return (
    <>
      <label className="field">
        <span className="field__label">What changes?</span>
        <textarea
          autoFocus={autoFocus}
          rows={3}
          placeholder="e.g. The Library of Alexandria is never burned; its scholars keep copying and expanding the collection."
          value={value.summary}
          onChange={(e) => onChange({ ...value, summary: e.target.value })}
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field__label">Short title</span>
          <input placeholder="The Library Endures" value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} />
        </label>
        <label className="field field--narrow">
          <span className="field__label">When</span>
          <input placeholder="48 BC" value={value.period} onChange={(e) => onChange({ ...value, period: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span className="field__label">
          More detail <em>optional</em>
        </span>
        <textarea
          rows={3}
          placeholder="Anything the model should know: the mechanism of the change, who is involved, what stays the same."
          value={value.narrative ?? ''}
          onChange={(e) => onChange({ ...value, narrative: e.target.value })}
        />
      </label>
    </>
  );
}

export const emptyDeviation = (): DeviationInput => ({ title: '', period: '', summary: '', narrative: '' });

/** Shared body for "new timeline" and "branch with a new deviation". */
export function DeviationDialog({
  title,
  subtitle,
  submitLabel,
  allowThread,
  onClose,
  onSubmit,
}: {
  title: string;
  subtitle?: string;
  submitLabel: string;
  /** Offer "happens alongside" (a parallel thread) next to the default alternative branch. */
  allowThread?: boolean;
  onClose: () => void;
  onSubmit: (d: DeviationInput, autoContinue: boolean, opts: GenerateOptions) => Promise<void>;
}) {
  const [dev, setDev] = useState(emptyDeviation);
  const [auto, setAuto] = useState(true);
  const [opts, setOpts] = useState<GenerateOptions>({ timeSpan: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [asThread, setAsThread] = useState(false);
  const [threadName, setThreadName] = useState('');
  const valid = dev.summary.trim().length > 0 && (!asThread || threadName.trim().length > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    try {
      const d: DeviationInput = {
        ...dev,
        title: dev.title.trim() || dev.summary.trim().split(/[.!?]/)[0].slice(0, 80),
        threadName: asThread ? threadName.trim() : undefined,
      };
      await onSubmit(d, auto, opts);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <form onSubmit={submit} className="form">
        {allowThread && (
          <div className="segmented" role="radiogroup" aria-label="Branch type">
            <button type="button" role="radio" aria-checked={!asThread} className={!asThread ? 'is-active' : ''} onClick={() => setAsThread(false)}>
              <strong>Alternative</strong>
              <span>Happens instead of what follows</span>
            </button>
            <button type="button" role="radio" aria-checked={asThread} className={asThread ? 'is-active' : ''} onClick={() => setAsThread(true)}>
              <strong>🧵 Parallel thread</strong>
              <span>Happens alongside, as its own storyline</span>
            </button>
          </div>
        )}
        {asThread && (
          <label className="field">
            <span className="field__label">Thread name</span>
            <input placeholder="e.g. Ceylon politics" value={threadName} onChange={(e) => setThreadName(e.target.value)} />
          </label>
        )}
        <DeviationFields value={dev} onChange={setDev} autoFocus />
        <label className="toggle">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>Generate what happens next right away</span>
        </label>
        {auto && <GenerateOptionsFields value={opts} onChange={setOpts} />}
        {error && <div className="alert alert--error">{error}</div>}
        <div className="form__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!valid || busy}>
            {busy ? 'Saving...' : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Confirms a convergence of 2-5 nodes on separate branches. The first one is Branch A. */
export function MergeDialog({
  nodes,
  onClose,
  onSubmit,
}: {
  nodes: { title: string; period: string }[];
  onClose: () => void;
  onSubmit: (opts: GenerateOptions) => Promise<void>;
}) {
  const [opts, setOpts] = useState<GenerateOptions>({ timeSpan: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit(opts);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Merge ${nodes.length} storylines`}
      subtitle={`All ${nodes.length === 2 ? 'both' : nodes.length} branches are treated as having happened in the same world.`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="form">
        {nodes.length === 2 ? (
          <div className="merge-pair">
            {nodes.map((n, i) => (
              <Fragment key={i}>
                {i > 0 && <div className="merge-pair__join">⤚ ⤙</div>}
                <div className="merge-pair__item">
                  <span className="merge-pair__tag">{String.fromCharCode(65 + i)}</span>
                  <strong>{n.title}</strong>
                  <span className="muted small">{n.period}</span>
                </div>
              </Fragment>
            ))}
          </div>
        ) : (
          <div className="merge-list">
            {nodes.map((n, i) => (
              <div key={i} className="merge-pair__item merge-list__item">
                <span className="merge-pair__tag">{String.fromCharCode(65 + i)}</span>
                <div>
                  <strong>{n.title}</strong>
                  <span className="muted small"> · {n.period}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="muted small">
          The model writes where they all meet. If they contradict, it favors <strong>A</strong> unless your guidance says otherwise.
        </p>
        <GenerateOptionsFields value={opts} onChange={setOpts} />
        {error && <div className="alert alert--error">{error}</div>}
        <div className="form__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={busy}>
            {busy ? 'Merging...' : 'Generate convergence'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const STRENGTH_HELP: Record<Strength, string> = {
  mild: 'Nudges it',
  moderate: 'Clearly shapes it',
  strong: 'Largely drives it',
};

export interface InfluenceTarget {
  title: string;
  period: string;
  /** Thread the target belongs to ("Main" for the main stream). */
  stream: string;
  /** Existing non-thread continuations: the new event becomes an alternative to them. */
  existing: number;
}

/** One event influences 1-4 other streams: the model writes a new event after each target showing the effect. */
export function InfluenceDialog({
  from,
  targets,
  onClose,
  onSubmit,
}: {
  from: { title: string; period: string };
  targets: InfluenceTarget[];
  onClose: () => void;
  onSubmit: (strength: Strength, opts: GenerateOptions) => Promise<void>;
}) {
  const [strength, setStrength] = useState<Strength>('moderate');
  const [opts, setOpts] = useState<GenerateOptions>({ timeSpan: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit(strength, opts);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const n = targets.length;
  return (
    <Modal
      title={n === 1 ? 'Influence a stream' : `Influence ${n} streams`}
      subtitle={`The model writes a new event after ${n === 1 ? 'the picked node' : 'each picked node'}, shaped by this event.`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="form">
        <div className="merge-list">
          <div className="merge-pair__item merge-list__item">
            <span className="merge-pair__tag">FROM</span>
            <div>
              <strong>{from.title}</strong>
              <span className="muted small"> · {from.period}</span>
            </div>
          </div>
          {targets.map((t, i) => (
            <div key={i} className="merge-pair__item merge-list__item">
              <span className="merge-pair__tag">⇢</span>
              <div>
                <strong>{t.title}</strong>
                <span className="muted small">
                  {' '}
                  · {t.period} · {t.stream}
                </span>
                {t.existing > 0 && (
                  <div className="muted small">
                    Already continues; the new event becomes an alternative to {t.existing === 1 ? 'that continuation' : `its ${t.existing} continuations`}.
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <label className="field">
          <span className="field__label">Strength</span>
          <div className="chips">
            {STRENGTHS.map((s) => (
              <button type="button" key={s} className={`chip ${strength === s ? 'is-active' : ''}`} onClick={() => setStrength(s)} title={STRENGTH_HELP[s]}>
                {s}
              </button>
            ))}
          </div>
          <span className="field__hint">{STRENGTH_HELP[strength]}</span>
        </label>
        <GenerateOptionsFields value={opts} onChange={setOpts} />
        {error && <div className="alert alert--error">{error}</div>}
        <div className="form__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={busy}>
            {busy ? 'Queuing...' : n === 1 ? 'Generate influenced event' : `Generate ${n} influenced events`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

