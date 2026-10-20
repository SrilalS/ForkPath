import { useMemo } from 'react';
import type { Timeline, TLNode } from '../../../shared/types.ts';
import { effectiveYear, WorldIndex } from '../../../shared/world.ts';
import { formatYear } from '../../../shared/time.ts';
import { formatOdds, streamLabel } from '../graph.ts';

interface Point {
  node: TLNode;
  year: number | null;
  stream: string;
  /** Chance history reaches this point at all. */
  odds: number;
  likely: boolean;
  /** The exclusive outcomes at a fork, most likely first; empty for a pivotal event. */
  outcomes: { node: TLNode; share: number; favorite: boolean }[];
}

/** Every fork (where the model wrote exclusive outcomes) and every pivotal event, in date order. */
function turningPoints(tl: Timeline): Point[] {
  const ix = new WorldIndex(tl);
  const point = (n: TLNode): Point => {
    const fav = ix.favorite(n.id);
    return {
      node: n,
      year: effectiveYear(tl, n.id),
      stream: streamLabel(tl, n.id),
      odds: ix.pathOdds(n.id),
      likely: ix.inMostLikely(n.id),
      outcomes: ix
        .alternatives(n.id)
        .map((a) => ({ node: a, share: ix.forkShare(a), favorite: a.id === fav?.id }))
        .sort((a, b) => b.share - a.share),
    };
  };
  const forks = ix.forks();
  const forkIds = new Set(forks.map((n) => n.id));
  const pivotal = Object.values(tl.nodes).filter((n) => n.significance === 'pivotal' && n.status === 'ready' && !forkIds.has(n.id));
  return [...forks, ...pivotal]
    .map(point)
    // Undated means nothing before it is dated either (the root, typically), so it goes first.
    .sort((a, b) => (a.year ?? -Infinity) - (b.year ?? -Infinity) || a.node.createdAt.localeCompare(b.node.createdAt));
}

export function TurningPoints({
  timeline,
  selectedId,
  onSelect,
  onClose,
}: {
  timeline: Timeline;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const points = useMemo(() => turningPoints(timeline), [timeline]);

  return (
    <aside className="turning" aria-label="Turning points">
      <header className="turning__head">
        <h2>⑂ Turning points</h2>
        <button className="btn btn--small btn--ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      {points.length === 0 ? (
        <p className="muted small turning__empty">
          No forks or pivotal events yet. A fork appears when the model writes several possible outcomes for one event.
        </p>
      ) : (
        <ol className="turning__list">
          {points.map((p) => (
            <li key={p.node.id} className={`turning__item ${p.likely ? '' : 'is-unlikely'}`}>
              <button className={`turning__point ${selectedId === p.node.id ? 'is-active' : ''}`} onClick={() => onSelect(p.node.id)}>
                <span className="turning__year">{p.year === null ? '?' : formatYear(p.year)}</span>
                <span className="turning__title">{p.node.title}</span>
                <span className="turning__meta muted">
                  {p.outcomes.length ? `${p.outcomes.length} outcomes` : 'Pivotal'} · {p.stream}
                  {p.odds < 1 && ` · reached ${formatOdds(p.odds)}`}
                </span>
              </button>
              {p.outcomes.length > 0 && (
                <ul className="turning__outcomes">
                  {p.outcomes.map((o) => (
                    <li key={o.node.id}>
                      <button
                        className={`turning__outcome ${selectedId === o.node.id ? 'is-active' : ''}`}
                        onClick={() => onSelect(o.node.id)}
                        title={o.node.summary}
                      >
                        <span className="turning__bar">
                          <span style={{ width: `${Math.round(o.share * 100)}%` }} />
                        </span>
                        <span className="turning__share">{Math.round(o.share * 100)}%</span>
                        <span className="turning__otitle">
                          {o.favorite && <span title="Most likely outcome here">★ </span>}
                          {o.node.title}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
