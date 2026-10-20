// Token and cost ledger for the built-in engine (data/usage.json): one entry per finished job, including
// failed ones (they cost tokens too). Feeds the monthly budget and the Settings page.
import fs from 'node:fs';
import path from 'node:path';
import type { JobType } from '../../shared/types.ts';
import { DATA_DIR, writeJsonAtomic } from './store.ts';

const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
/** Older entries are dropped; month totals only need the current month. */
const KEEP = 5000;

export interface UsageEntry {
  at: string;
  jobId: string;
  timelineId: string;
  jobType: JobType;
  model: string;
  outcome: 'done' | 'failed' | 'cancelled';
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd?: number;
  durationMs: number;
}

let entries: UsageEntry[] = [];
try {
  entries = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  if (!Array.isArray(entries)) entries = [];
} catch {
  // first run
}

export function recordUsage(e: UsageEntry) {
  entries.push(e);
  if (entries.length > KEEP) entries = entries.slice(-KEEP);
  writeJsonAtomic(USAGE_FILE, entries);
}

const monthKey = (iso: string) => iso.slice(0, 7); // "2026-10" (UTC)

export interface UsageSummary {
  month: string;
  jobs: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Sum over entries that had a price; `unpriced` counts the ones that did not. */
  costUsd: number;
  unpriced: number;
}

/** Totals for the current calendar month (UTC). */
export function monthSummary(now = new Date().toISOString()): UsageSummary {
  const month = monthKey(now);
  const s: UsageSummary = { month, jobs: 0, failed: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, unpriced: 0 };
  for (const e of entries) {
    if (monthKey(e.at) !== month) continue;
    s.jobs++;
    if (e.outcome === 'failed') s.failed++;
    s.inputTokens += e.inputTokens;
    s.outputTokens += e.outputTokens;
    s.cachedInputTokens += e.cachedInputTokens;
    if (e.costUsd === undefined) s.unpriced++;
    else s.costUsd += e.costUsd;
  }
  return s;
}

/** The latest entries, newest first, for the Settings page. */
export const recentUsage = (n = 20) => entries.slice(-n).reverse();
