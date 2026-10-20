import { useMemo } from 'react';
import type { Timeline, UsageTotals } from '../../../shared/types.ts';
import { fmtTokens, fmtUsd } from '../../../shared/usage.ts';

const jobsLabel = (n: number) => `${Math.round(n)} job${Math.round(n) === 1 ? '' : 's'}`;

/**
 * Real cost and the worker's API-equivalent estimate, e.g. "$0.42 + ≈$1.80". "-" when neither is known.
 * The two are never added together: one is a charge, the other is not.
 */
function costText(t: UsageTotals) {
  const est = t.estimatedUsd ?? 0;
  const parts = [t.costUsd > 0 && fmtUsd(t.costUsd), est > 0 && `≈${fmtUsd(est)}`].filter(Boolean);
  return parts.length ? parts.join(' + ') : '-';
}

/** The short label on the top bar button: the world's cost (or estimate), else its tokens. */
export function usageLabel(tl: Timeline) {
  const t = tl.usage?.total;
  if (!t || t.jobs === 0) return 'Usage';
  return t.costUsd > 0 || t.estimatedUsd ? costText(t) : `${fmtTokens(t.inputTokens + t.outputTokens)} tokens`;
}

/** What this world has cost so far, and which events cost the most. */
export function UsagePanel({
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
  const usage = timeline.usage;
  const costliest = useMemo(() => {
    const spent = Object.values(timeline.nodes).filter((n) => n.spent && n.spent.jobs > 0);
    const byCost = spent.some((n) => n.spent!.costUsd > 0 || n.spent!.estimatedUsd);
    const weight = (t: UsageTotals) => (byCost ? t.costUsd + (t.estimatedUsd ?? 0) : t.inputTokens + t.outputTokens);
    return spent.sort((a, b) => weight(b.spent!) - weight(a.spent!)).slice(0, 8);
  }, [timeline]);

  const rows: [string, string, UsageTotals][] = usage
    ? [
        ['Σ', 'All jobs', usage.total],
        ...(usage.reviews.jobs ? [['🔍', 'Reviews', usage.reviews] as [string, string, UsageTotals]] : []),
        ...(usage.wasted.jobs ? [['⚠️', 'Wrote nothing', usage.wasted] as [string, string, UsageTotals]] : []),
      ]
    : [];

  return (
    <aside className="turning usage" aria-label="Usage">
      <header className="turning__head">
        <h2>🪙 Usage</h2>
        <button className="btn btn--small btn--ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      {!usage || (usage.total.jobs === 0 && !usage.untracked) ? (
        <p className="muted small turning__empty">
          Nothing tracked yet. Tokens and cost are counted for every job the built-in engine runs in this world.
        </p>
      ) : (
        <>
          {usage.total.jobs > 0 && (
            <table className="usage__table">
              <thead>
                <tr>
                  <th />
                  <th>Jobs</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([icon, label, t]) => (
                  <tr key={label}>
                    <th scope="row">
                      <span aria-hidden>{icon}</span> {label}
                    </th>
                    <td>{Math.round(t.jobs)}</td>
                    <td title={t.cachedInputTokens ? `${fmtTokens(t.cachedInputTokens)} of them cached` : undefined}>{fmtTokens(t.inputTokens)}</td>
                    <td>{fmtTokens(t.outputTokens)}</td>
                    <td>{costText(t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ul className="usage__notes muted small">
            {usage.total.cachedInputTokens > 0 && <li>{fmtTokens(usage.total.cachedInputTokens)} input tokens were served from the prompt cache.</li>}
            {usage.wasted.jobs > 0 && <li>"Wrote nothing" covers failed, cancelled and interrupted jobs. It is included in the total.</li>}
            {(usage.total.estimatedUsd ?? 0) > 0 && (
              <li>
                ≈ is what the Claude Code worker's tokens would cost at Claude API list prices. A Pro or Max plan is not billed per token, so it
                is a comparison, not a charge.
              </li>
            )}
            {usage.total.unpriced > 0.5 && (
              <li>{jobsLabel(usage.total.unpriced)} on the built-in engine ran without prices set, so their cost is unknown. Set prices in Settings.</li>
            )}
            {usage.untracked > 0 && (
              <li>{jobsLabel(usage.untracked)} by the Claude Code worker are not counted: they finished before the worker reported its tokens.</li>
            )}
            <li>Totals stay when events are deleted: the tokens were spent either way.</li>
          </ul>
          {costliest.length > 0 && (
            <>
              <h3 className="usage__subhead">Costliest events</h3>
              <ol className="turning__list">
                {costliest.map((n) => (
                  <li key={n.id} className="turning__item">
                    <button className={`turning__point ${selectedId === n.id ? 'is-active' : ''}`} onClick={() => onSelect(n.id)}>
                      <span className="turning__year usage__cost">
                        {costText(n.spent!) !== '-' ? costText(n.spent!) : fmtTokens(n.spent!.inputTokens + n.spent!.outputTokens)}
                      </span>
                      <span className="turning__title">{n.title}</span>
                      <span className="turning__meta muted">
                        {fmtTokens(n.spent!.inputTokens)} in / {fmtTokens(n.spent!.outputTokens)} out
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </aside>
  );
}
