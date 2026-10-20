import { useEffect, useMemo, useState } from 'react';
import type { Detail, Generation, Temperament, Timeline, TLNode } from '../../../shared/types.ts';
import { api, type GenerateOptions } from '../api.ts';
import { DETAIL_INFO, DetailField, GenerateOptionsFields, TEMPERAMENT_INFO, TemperamentField } from './forms.tsx';
import { isMajor, SIGNIFICANCE_LABEL, TONE_STYLE } from '../mood.ts';
import { SIGNIFICANCES, TONES, type Significance, type Tone } from '../../../shared/types.ts';
import {
  childrenOf,
  descendantIds,
  influenceTargets,
  mergeTargets,
  parentIdsOf,
  streamLabel,
  streamNameOf,
  threadColors,
  threadLabel,
  threadRootOf,
} from '../graph.ts';

export const PANEL_DEFAULT = 440;

interface Props {
  timeline: Timeline;
  node: TLNode;
  workerOnline: boolean;
  width: number;
  /** True while the canvas is in "pick a second node" mode (Escape belongs to that). */
  picking: boolean;
  onResize: (width: number) => void;
  onSelect: (id: string | null) => void;
  onBranch: (nodeId: string) => void;
  onStartMerge: (nodeId: string) => void;
  onStartLink: (nodeId: string) => void;
  /** Latest "+ on a node" click; opens the Continue form when it targets this node. */
  continueRequest: { id: string; at: number } | null;
  onError: (msg: string) => void;
}

type Mode = 'view' | 'edit' | 'continue' | 'regenerate';

export const PANEL_MIN = 360;
export const panelMax = () => Math.max(PANEL_MIN, Math.min(window.innerWidth * 0.8, 1200));

export function NodePanel({
  timeline,
  node,
  workerOnline,
  width,
  picking,
  onResize,
  onSelect,
  onBranch,
  onStartMerge,
  onStartLink,
  continueRequest,
  onError,
}: Props) {
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [resizing, setResizing] = useState(false);
  const isRoot = node.id === timeline.rootId;
  const parents = parentIdsOf(node)
    .map((id) => timeline.nodes[id])
    .filter(Boolean);
  const children = useMemo(() => childrenOf(timeline, node.id), [timeline, node.id]);
  const siblings = useMemo(
    () => (node.parentId ? Object.values(timeline.nodes).filter((n) => n.parentId === node.parentId && n.likelihood !== undefined) : []),
    [timeline, node.parentId],
  );
  const descendants = useMemo(() => descendantIds(timeline, node.id).size, [timeline, node.id]);
  const canMerge = useMemo(() => mergeTargets(timeline, node.id).size > 0, [timeline, node.id]);
  const canInfluence = useMemo(() => node.status === 'ready' && influenceTargets(timeline, node.id).size > 0, [timeline, node.id, node.status]);
  const isConvergence = !!node.mergeParents?.length;
  // Thread starts are parallel storylines, not continuations of this one.
  const primaryChildren = children.filter((c) => c.parentId === node.id && !c.threadName).length;
  const threadRoot = threadRootOf(timeline, node.id);
  const threadName = streamNameOf(timeline, node.id) ?? threadLabel(timeline, threadRoot);
  const threadColor = threadColors(timeline).get(threadRoot) ?? (streamNameOf(timeline, node.id) ? '#9aa7c2' : undefined);
  /** The name this node's stream has before any rename on this node itself (shown as the edit placeholder). */
  const inheritedStream = node.parentId ? streamLabel(timeline, node.parentId) : 'Main';
  const incoming = (timeline.links ?? []).filter((l) => l.to === node.id && timeline.nodes[l.from]);
  const outgoing = (timeline.links ?? []).filter((l) => l.from === node.id && timeline.nodes[l.to]);

  /** Drag the left edge to resize; double-click it to reset. */
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setResizing(true);
    const move = (ev: PointerEvent) => onResize(Math.min(panelMax(), Math.max(PANEL_MIN, startW + (startX - ev.clientX))));
    const up = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  useEffect(() => setMode('view'), [node.id]);
  // Runs after the reset above, so a + click on a node lands on its Continue form.
  useEffect(() => {
    if (continueRequest?.id === node.id && node.status === 'ready') setMode('continue');
  }, [continueRequest]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || picking || (e.target as HTMLElement)?.closest('.modal')) return;
      if (mode !== 'view') setMode('view');
      else onSelect(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onSelect, picking]);

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const generating = node.status === 'generating';
  const ready = node.status === 'ready';

  return (
    <aside className={`panel ${resizing ? 'is-resizing' : ''}`} style={{ width }}>
      <div
        className="panel__resize"
        onPointerDown={startResize}
        onDoubleClick={() => onResize(PANEL_DEFAULT)}
        title="Drag to resize, double-click to reset"
      />
      <div className="panel__head">
        <div className="panel__meta">
          <span className={`tl-chip tl-chip--${node.kind} ${isConvergence ? 'tl-chip--merge' : ''}`}>
            {isRoot ? 'Point of divergence' : isConvergence ? 'Convergence' : node.kind === 'deviation' ? 'New deviation' : 'Event'}
          </span>
          {node.kind === 'event' && node.status === 'ready' && (
            <span className={`tone-tag ${isMajor(node) ? 'is-major' : ''}`} style={{ '--tone': TONE_STYLE[node.tone].color } as React.CSSProperties}>
              {TONE_STYLE[node.tone].icon} {SIGNIFICANCE_LABEL[node.significance]} · {TONE_STYLE[node.tone].label}
            </span>
          )}
          {node.period && <span className="muted">{node.period}</span>}
          {threadColor && (
            <span className="tl-thread" style={{ '--thread': threadColor } as React.CSSProperties} title="Parallel thread this node belongs to">
              {threadName}
            </span>
          )}
        </div>
        <button className="icon-btn" onClick={() => onSelect(null)} aria-label="Close panel">
          ×
        </button>
      </div>

      <div className="panel__scroll">
        {mode === 'edit' ? (
          <EditForm
            node={node}
            inheritedStream={inheritedStream}
            descendants={descendants}
            busy={busy}
            onCancel={() => setMode('view')}
            onSave={async (edit) => {
              const ok = await run(() => api.editNode(timeline.id, node.id, edit));
              if (ok) setMode('view');
            }}
          />
        ) : (
          <>
            <h2 className="panel__title">
              {node.title !== 'Generating...' ? node.title : generating ? 'Writing what happens next' : 'Generation failed'}
            </h2>

            {generating && (
              <div className="banner banner--info">
                <span className={`dot ${workerOnline ? 'dot--on' : 'dot--off'} dot--pulse`} />
                <div>
                  <strong>{workerOnline ? 'The worker is generating this node.' : 'Queued. The worker is offline.'}</strong>
                  {!workerOnline && <p>Start the Claude worker session (see README) and it will pick this up.</p>}
                </div>
                <button className="btn btn--small btn--ghost" disabled={busy} onClick={() => run(() => api.cancel(timeline.id, node.id))}>
                  Cancel
                </button>
              </div>
            )}

            {node.status === 'error' && (
              <div className="banner banner--error">
                <div>
                  <strong>Generation failed</strong>
                  <p>{node.error}</p>
                </div>
                <div className="banner__actions">
                  <button className="btn btn--small" disabled={busy} onClick={() => run(() => api.retry(timeline.id, node.id))}>
                    Retry
                  </button>
                  <button className="btn btn--small btn--ghost" disabled={busy} onClick={() => run(() => api.deleteNode(timeline.id, node.id)).then(() => onSelect(node.parentId))}>
                    Remove
                  </button>
                </div>
              </div>
            )}

            {ready && node.error && (
              <div className="banner banner--error">
                <div>
                  <strong>Last regeneration failed</strong>
                  <p>{node.error}</p>
                </div>
              </div>
            )}

            {node.stale && ready && (
              <div className="banner banner--warn">
                <div>
                  <strong>An earlier node changed.</strong>
                  <p>This node may no longer follow from the history before it.</p>
                </div>
                <div className="banner__actions">
                  {node.kind === 'event' && (
                    <button className="btn btn--small btn--primary" disabled={busy} onClick={() => setMode('regenerate')}>
                      Regenerate
                    </button>
                  )}
                  <button className="btn btn--small" disabled={busy} onClick={() => run(() => api.keep(timeline.id, node.id))}>
                    Keep
                  </button>
                  {descendants > 0 && (
                    <button className="btn btn--small btn--ghost" disabled={busy} onClick={() => run(() => api.keep(timeline.id, node.id, true))}>
                      Keep whole branch
                    </button>
                  )}
                </div>
              </div>
            )}

            {node.likelihood !== undefined && (
              <div className="branch-info">
                <div className="branch-info__top">
                  <span>
                    One of {siblings.length} possible outcomes
                  </span>
                  <strong>{Math.round(node.likelihood * 100)}%</strong>
                </div>
                <div className="tl-likelihood__bar tl-likelihood__bar--wide">
                  <span style={{ width: `${Math.round(node.likelihood * 100)}%` }} />
                </div>
                {node.branchReason && <p>{node.branchReason}</p>}
              </div>
            )}

            {!generating && node.status !== 'error' && (
              <>
                {node.summary && <p className="panel__summary">{node.summary}</p>}
                {node.keyChanges.length > 0 && (
                  <section className="panel__section">
                    <h3>Key changes</h3>
                    <ul className="changes">
                      {node.keyChanges.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </section>
                )}
                {node.narrative && (
                  <section className="panel__section">
                    <h3>{node.kind === 'deviation' ? 'Detail' : 'Narrative'}</h3>
                    <Narrative text={node.narrative} />
                  </section>
                )}
              </>
            )}

            {(incoming.length > 0 || outgoing.length > 0) && (
              <section className="panel__section">
                <h3>Influences</h3>
                <ul className="links">
                  {[...incoming.map((l) => ({ l, other: l.from, dir: 'in' as const })), ...outgoing.map((l) => ({ l, other: l.to, dir: 'out' as const }))].map(
                    ({ l, other, dir }) => {
                      const o = timeline.nodes[other];
                      return (
                        <li key={l.id} className={`link link--${l.strength}`}>
                          <button className="link__main" onClick={() => onSelect(o.id)}>
                            <span className="link__dir">{dir === 'in' ? '⇠ Shaped by' : '⇢ Shapes'}</span>
                            <span className={`link__strength link__strength--${l.strength}`}>{l.strength}</span>
                            <strong>{o.title}</strong>
                            <span className="muted small"> · {streamLabel(timeline, o.id)}</span>
                            {l.note && <span className="link__note">{l.note}</span>}
                          </button>
                          <button
                            className="icon-btn"
                            title="Remove this link"
                            disabled={busy}
                            onClick={() => run(() => api.deleteLink(timeline.id, l.id))}
                          >
                            ×
                          </button>
                        </li>
                      );
                    },
                  )}
                </ul>
              </section>
            )}

            <section className="panel__section panel__nav">
              {parents.map((p, i) => (
                <button key={p.id} className="nav-link" onClick={() => onSelect(p.id)}>
                  <span className="muted">{i === 0 ? (node.threadName ? '🧵 Spun off from' : '← Follows') : '⤚ Converges with'}</span> {p.title}
                </button>
              ))}
              {children.map((c) => (
                <button key={c.id} className="nav-link" onClick={() => onSelect(c.id)}>
                  <span className="muted">
                    {c.parentId !== node.id ? '⤙ Merges into' : c.threadName ? `🧵 Starts thread "${c.threadName}":` : '→ Leads to'}
                  </span>{' '}
                  {c.status === 'generating' ? 'Generating...' : c.title}
                  {c.likelihood !== undefined && <span className="muted"> ({Math.round(c.likelihood * 100)}%)</span>}
                </button>
              ))}
            </section>

            {node.generation && <GenerationLine g={node.generation} edited={node.source === 'llm-edited'} />}
          </>
        )}
      </div>

      {mode === 'regenerate' && (
        <RegenerateForm
          busy={busy}
          stale={node.stale}
          onCancel={() => setMode('view')}
          onSubmit={async (guidance, temperament, detail) => {
            const ok = await run(() => api.regenerate(timeline.id, node.id, { guidance, temperament, detail }));
            if (ok) setMode('view');
          }}
        />
      )}

      {mode === 'continue' && (
        <ContinueForm
          busy={busy}
          hasChildren={primaryChildren > 0}
          onCancel={() => setMode('view')}
          onSubmit={async (opts) => {
            const placeholder = await run(() => api.continueFrom(timeline.id, node.id, opts));
            if (placeholder) onSelect(placeholder.id);
          }}
        />
      )}

      {mode === 'view' && ready && (
        <div className="panel__actions">
          <button className="btn btn--primary" disabled={busy} onClick={() => setMode('continue')}>
            {primaryChildren ? 'Continue another way' : 'Continue'}
          </button>
          <button className="btn" disabled={busy} onClick={() => onBranch(node.id)}>
            Branch here
          </button>
          <button
            className="btn"
            disabled={busy || !canMerge}
            onClick={() => onStartMerge(node.id)}
            title={canMerge ? 'Pick a node on another branch; the model writes where the two storylines meet' : 'No node on a separate branch to merge with'}
          >
            Merge with...
          </button>
          <button
            className="btn"
            disabled={busy || !canInfluence}
            onClick={() => onStartLink(node.id)}
            title={
              canInfluence
                ? 'Pick nodes in other streams; the model writes a new event after each, shaped by this one'
                : 'No other stream in this world to influence'
            }
          >
            Influence...
          </button>
          <button className="btn btn--ghost" disabled={busy} onClick={() => setMode('edit')}>
            Edit
          </button>
          {node.kind === 'event' && (
            <button className="btn btn--ghost" disabled={busy} onClick={() => setMode('regenerate')} title="Rewrite this node">
              Regenerate
            </button>
          )}
          <a
            className="btn btn--ghost"
            href={api.exportUrl(timeline.id, node.id)}
            download
            title="Download the path to this node and everything after it, to import later"
          >
            Save branch
          </a>
          {!isRoot && (
            <button
              className="btn btn--ghost btn--danger"
              disabled={busy}
              onClick={() => {
                const extra = descendants ? ` and the ${descendants} node${descendants > 1 ? 's' : ''} after it` : '';
                if (confirm(`Delete "${node.title}"${extra}?`)) run(() => api.deleteNode(timeline.id, node.id)).then(() => onSelect(node.parentId));
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

function RegenerateForm({
  busy,
  stale,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  stale: boolean;
  onCancel: () => void;
  onSubmit: (guidance: string, temperament: Temperament, detail: Detail) => void;
}) {
  const [guidance, setGuidance] = useState('');
  const [temperament, setTemperament] = useState<Temperament>('realist');
  const [detail, setDetail] = useState<Detail>('beats');
  return (
    <form
      className="panel__continue form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(guidance.trim(), temperament, detail);
      }}
    >
      <h3>Regenerate this node</h3>
      <p className="muted small">
        {stale
          ? 'The model rewrites it to follow from the changed history before it.'
          : 'The model rewrites it from scratch, keeping roughly the same period.'}{' '}
        Nodes after it will be marked stale.
      </p>
      <label className="field">
        <span className="field__label">
          Guidance <em>optional</em>
        </span>
        <textarea
          autoFocus
          rows={3}
          placeholder="e.g. make the coup fail, put more weight on the economy, keep Nehru alive"
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit(guidance.trim(), temperament, detail);
          }}
        />
      </label>
      <TemperamentField value={temperament} onChange={setTemperament} />
      <DetailField value={detail} onChange={setDetail} />
      <div className="form__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy}>
          Regenerate
        </button>
      </div>
    </form>
  );
}

function ContinueForm({
  busy,
  hasChildren,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  hasChildren: boolean;
  onCancel: () => void;
  onSubmit: (o: GenerateOptions) => void;
}) {
  const [opts, setOpts] = useState<GenerateOptions>({ timeSpan: '' });
  return (
    <form
      className="panel__continue form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(opts);
      }}
    >
      <h3>{hasChildren ? 'Continue another way' : 'Continue the timeline'}</h3>
      {hasChildren && <p className="muted small">The model will see the existing continuations and write a different one.</p>}
      <GenerateOptionsFields value={opts} onChange={setOpts} />
      <div className="form__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy}>
          Generate
        </button>
      </div>
    </form>
  );
}

type Beat = { text: string; sub: string[] };
type Block = { kind: 'beats'; beats: Beat[] } | { kind: 'why'; text: string } | { kind: 'para'; text: string };

/** Splits a narrative into prose paragraphs, beat lists ("- ...", "  - ...") and a closing "Why:" line. */
function parseNarrative(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'para', text: para.join(' ') });
    para = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const sub = line.match(/^\s{2,}[-*]\s+(.*)$/);
    const beat = line.match(/^[-*]\s+(.*)$/);
    const last = blocks.at(-1);
    if (sub && last?.kind === 'beats' && !para.length) {
      last.beats.at(-1)!.sub.push(sub[1]);
    } else if (beat) {
      flush();
      if (last?.kind === 'beats') last.beats.push({ text: beat[1], sub: [] });
      else blocks.push({ kind: 'beats', beats: [{ text: beat[1], sub: [] }] });
    } else if (/^why:/i.test(line.trim())) {
      flush();
      blocks.push({ kind: 'why', text: line.trim().replace(/^why:\s*/i, '') });
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/** A beat's leading date ("March 2027: ...") in bold, when it has one. */
function BeatText({ text }: { text: string }) {
  const m = text.match(/^([^:]{2,32}):\s+(.*)$/);
  return m ? (
    <>
      <strong className="narrative__when">{m[1]}:</strong> {m[2]}
    </>
  ) : (
    <>{text}</>
  );
}

/** Narratives come as beats (dated bullet lines plus "Why:") or as prose paragraphs; both render here. */
function Narrative({ text }: { text: string }) {
  return (
    <div className="narrative">
      {parseNarrative(text).map((b, i) =>
        b.kind === 'beats' ? (
          <ul key={i} className="narrative__beats">
            {b.beats.map((beat, j) => (
              <li key={j}>
                <BeatText text={beat.text} />
                {beat.sub.length > 0 && (
                  <ul>
                    {beat.sub.map((s, k) => (
                      <li key={k}>{s}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        ) : b.kind === 'why' ? (
          <p key={i} className="narrative__why">
            <strong>Why:</strong> {b.text}
          </p>
        ) : (
          <p key={i}>{b.text}</p>
        ),
      )}
    </div>
  );
}

const tokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Which engine and model wrote this node, and for the built-in engine what it cost. */
function GenerationLine({ g, edited }: { g: Generation; edited: boolean }) {
  const parts = [
    g.model,
    g.inputTokens !== undefined && `${tokens(g.inputTokens)} in / ${tokens(g.outputTokens ?? 0)} out`,
    g.costUsd !== undefined && (g.costUsd > 0 && g.costUsd < 0.01 ? '<$0.01' : `$${g.costUsd.toFixed(2)}`),
    g.durationMs !== undefined && `${Math.round(g.durationMs / 1000)}s`,
    g.repairs ? `${g.repairs} repair${g.repairs > 1 ? 's' : ''}` : null,
    g.nodesInJob ? `shared by ${g.nodesInJob} nodes` : null,
    g.temperament ? `${TEMPERAMENT_INFO[g.temperament].icon} ${TEMPERAMENT_INFO[g.temperament].label.toLowerCase()}` : null,
    g.detail === 'story' ? `${DETAIL_INFO.story.icon} full story` : null,
  ].filter(Boolean);
  return (
    <p className="panel__generation muted small" title={`Generated ${new Date(g.at).toLocaleString()} (${g.jobType})`}>
      ✍️ {parts.join(' · ')}
      {edited && ' · edited since'}
    </p>
  );
}

function EditForm({
  node,
  inheritedStream,
  descendants,
  busy,
  onCancel,
  onSave,
}: {
  node: TLNode;
  /** The stream's name coming into this node, before any rename here. */
  inheritedStream: string;
  descendants: number;
  busy: boolean;
  onCancel: () => void;
  onSave: (edit: Partial<TLNode>) => void;
}) {
  const [title, setTitle] = useState(node.title);
  const [period, setPeriod] = useState(node.period);
  const [summary, setSummary] = useState(node.summary);
  const [narrative, setNarrative] = useState(node.narrative);
  const [changes, setChanges] = useState(node.keyChanges.join('\n'));
  const [significance, setSignificance] = useState<Significance>(node.significance);
  const [tone, setTone] = useState<Tone>(node.tone);
  const [streamName, setStreamName] = useState(node.streamName ?? '');

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          title: title.trim(),
          period: period.trim(),
          summary: summary.trim(),
          narrative: narrative.trim(),
          keyChanges: changes.split('\n').map((s) => s.trim()).filter(Boolean),
          significance,
          tone,
          // '' clears a rename (the server drops the field).
          streamName: streamName.trim(),
        });
      }}
    >
      <h3>Edit node</h3>
      <div className="field-row">
        <label className="field">
          <span className="field__label">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label className="field field--narrow">
          <span className="field__label">When</span>
          <input value={period} onChange={(e) => setPeriod(e.target.value)} />
        </label>
      </div>
      {node.kind === 'event' && (
        <div className="field-row">
          <label className="field">
            <span className="field__label">Significance</span>
            <select value={significance} onChange={(e) => setSignificance(e.target.value as Significance)}>
              {SIGNIFICANCES.map((s) => (
                <option key={s} value={s}>
                  {SIGNIFICANCE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Tone</span>
            <select value={tone} onChange={(e) => setTone(e.target.value as Tone)}>
              {TONES.map((t) => (
                <option key={t} value={t}>
                  {TONE_STYLE[t].icon} {TONE_STYLE[t].label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {node.parentId && (
        <label className="field">
          <span className="field__label">
            Stream name from here on <em>optional</em>
          </span>
          <input value={streamName} placeholder={inheritedStream} maxLength={80} onChange={(e) => setStreamName(e.target.value)} />
          <span className="field__hint">Renames this stream for this node and everything after it, when its focus has moved on. Leave empty to keep "{inheritedStream}".</span>
        </label>
      )}
      <label className="field">
        <span className="field__label">Summary</span>
        <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Key changes <em>one per line</em></span>
        <textarea rows={4} value={changes} onChange={(e) => setChanges(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">{node.kind === 'deviation' ? 'Detail' : 'Narrative'}</span>
        <textarea rows={10} value={narrative} onChange={(e) => setNarrative(e.target.value)} />
      </label>
      {descendants > 0 && (
        <div className="alert alert--warn">
          Saving marks the {descendants} node{descendants > 1 ? 's' : ''} after this one as stale. You can regenerate or keep each one.
        </div>
      )}
      <div className="form__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy || !title.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}
