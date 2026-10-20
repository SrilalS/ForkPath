import { useEffect, useState, type ReactNode } from 'react';
import type { DeviationInput, GenerateOptions } from '../api.ts';

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
  onClose,
  onSubmit,
}: {
  title: string;
  subtitle?: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (d: DeviationInput, autoContinue: boolean, opts: GenerateOptions) => Promise<void>;
}) {
  const [dev, setDev] = useState(emptyDeviation);
  const [auto, setAuto] = useState(true);
  const [opts, setOpts] = useState<GenerateOptions>({ timeSpan: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const valid = dev.summary.trim().length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    try {
      const d = { ...dev, title: dev.title.trim() || dev.summary.trim().split(/[.!?]/)[0].slice(0, 80) };
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

/** Confirms a convergence between two nodes on separate branches. */
export function MergeDialog({
  a,
  b,
  onClose,
  onSubmit,
}: {
  a: { title: string; period: string };
  b: { title: string; period: string };
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
    <Modal title="Merge storylines" subtitle="Both branches are treated as having happened in the same world." onClose={onClose}>
      <form onSubmit={submit} className="form">
        <div className="merge-pair">
          <div className="merge-pair__item">
            <span className="merge-pair__tag">A</span>
            <strong>{a.title}</strong>
            <span className="muted small">{a.period}</span>
          </div>
          <div className="merge-pair__join">⤚ ⤙</div>
          <div className="merge-pair__item">
            <span className="merge-pair__tag">B</span>
            <strong>{b.title}</strong>
            <span className="muted small">{b.period}</span>
          </div>
        </div>
        <p className="muted small">
          The model writes where the two meet. If they contradict, it favors <strong>A</strong> unless your guidance says otherwise.
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
