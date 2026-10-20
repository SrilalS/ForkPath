// Token and cost totals, shared by the server (which adds to them) and the web UI (which sums and shows them).
import type { TimelineUsage, TLNode, UsageTotals } from './types.ts';

/** What one job spent. costUsd is absent when no prices are configured. */
export interface JobSpend {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd?: number;
  /** costUsd is an API-equivalent estimate for the Claude Code worker, not a charge: kept in estimatedUsd. */
  estimated?: boolean;
}

export const emptyTotals = (): UsageTotals => ({ jobs: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, unpriced: 0 });

export const emptyTimelineUsage = (): TimelineUsage => ({ total: emptyTotals(), wasted: emptyTotals(), reviews: emptyTotals(), untracked: 0 });

/** Adds one job (or `share` of it, when the job wrote several nodes) to `into`. */
export function addSpend(into: UsageTotals, spend: JobSpend, share = 1) {
  into.jobs += share;
  into.inputTokens += spend.inputTokens * share;
  into.outputTokens += spend.outputTokens * share;
  into.cachedInputTokens += spend.cachedInputTokens * share;
  if (spend.estimated) into.estimatedUsd = (into.estimatedUsd ?? 0) + (spend.costUsd ?? 0) * share;
  else if (spend.costUsd === undefined) into.unpriced += share;
  else into.costUsd += spend.costUsd * share;
}

/** Sum of several totals, e.g. every node in a branch. */
export function sumTotals(list: (UsageTotals | undefined)[]): UsageTotals {
  const out = emptyTotals();
  for (const t of list) {
    if (!t) continue;
    out.jobs += t.jobs;
    out.inputTokens += t.inputTokens;
    out.outputTokens += t.outputTokens;
    out.cachedInputTokens += t.cachedInputTokens;
    out.costUsd += t.costUsd;
    out.unpriced += t.unpriced;
    if (t.estimatedUsd) out.estimatedUsd = (out.estimatedUsd ?? 0) + t.estimatedUsd;
  }
  return out;
}

/** 950, 4.2k, 38k, 1.25M. Node shares can be fractional, so it rounds first. */
export function fmtTokens(n: number) {
  const r = Math.round(n);
  return r >= 1e6 ? `${(r / 1e6).toFixed(2)}M` : r >= 1e4 ? `${Math.round(r / 1e3)}k` : r >= 1e3 ? `${(r / 1e3).toFixed(1)}k` : String(r);
}

export const fmtUsd = (n: number | undefined) => (n === undefined ? '-' : n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

/** What the nodes' `spent` adds up to: a lower bound for a world, since failed jobs and deleted nodes are not in it. */
export const nodesSpent = (nodes: TLNode[]) => sumTotals(nodes.map((n) => n.spent));
