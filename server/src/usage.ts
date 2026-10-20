// Token and cost ledger for the built-in engine (data/usage.jsonl): one JSON line per finished job,
// including failed ones (they cost tokens too). Feeds the monthly budget and the Settings page.
// Append-only, so recording a job writes one line instead of rewriting the whole ledger.
import fs from 'node:fs';
import path from 'node:path';
import type { JobType } from '../../shared/types.ts';
import { DATA_DIR } from './store.ts';

const USAGE_FILE = path.join(DATA_DIR, 'usage.jsonl');
/** The ledger before it was append-only: read once, converted, then removed. */
const LEGACY_FILE = path.join(DATA_DIR, 'usage.json');
/** Older entries are dropped at startup; month totals only need the current month. */
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

const line = (e: UsageEntry) => `${JSON.stringify(e)}\n`;

/** Writes the whole ledger (temp file + rename), for conversion and trimming only. */
function rewrite(list: UsageEntry[]) {
  const tmp = `${USAGE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, list.map(line).join(''));
  fs.renameSync(tmp, USAGE_FILE);
}

function load(): UsageEntry[] {
  if (fs.existsSync(USAGE_FILE)) {
    // A line cut off by a crash mid-append is skipped; every other line still counts.
    return fs
      .readFileSync(USAGE_FILE, 'utf8')
      .split('\n')
      .flatMap((l) => {
        try {
          return l.trim() ? [JSON.parse(l) as UsageEntry] : [];
        } catch {
          return [];
        }
      });
  }
  if (!fs.existsSync(LEGACY_FILE)) return []; // first run
  try {
    const old = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
    const list = Array.isArray(old) ? (old as UsageEntry[]) : [];
    rewrite(list);
    fs.rmSync(LEGACY_FILE, { force: true });
    console.log(`[usage] converted usage.json to usage.jsonl (${list.length} entries)`);
    return list;
  } catch (err) {
    console.error('[usage] could not read usage.json:', err);
    return [];
  }
}

let entries = load();
if (entries.length > KEEP) rewrite((entries = entries.slice(-KEEP)));

export function recordUsage(e: UsageEntry) {
  entries.push(e);
  fs.appendFileSync(USAGE_FILE, line(e));
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
