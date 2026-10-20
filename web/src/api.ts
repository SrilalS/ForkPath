import type { InfluenceLink, Strength, Timeline, TimelineSummary, TLNode, WorkerStatus } from '../../shared/types.ts';

export interface DeviationInput {
  title: string;
  period: string;
  summary: string;
  narrative?: string;
  /** Set to start a parallel thread (happens alongside) instead of an alternative. */
  threadName?: string;
}

export interface GenerateOptions {
  timeSpan?: string;
  guidance?: string;
}

export type NodeEdit = Partial<
  Pick<TLNode, 'title' | 'period' | 'summary' | 'narrative' | 'keyChanges' | 'significance' | 'tone' | 'streamName'>
>;

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export type EngineId = 'external' | 'builtin';
export type ProviderId = 'anthropic' | 'openai-compatible';

export interface Pricing {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cachedInputPerMTok?: number;
}

/** Built-in engine settings as the server shows them: never the key itself. */
export interface BuiltinView {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  /** 'config', 'env:NAME' or 'none'. */
  keySource: string;
  concurrency: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxRepairs: number;
  timeoutMs: number;
  pricing: Pricing;
}

export interface UsageEntry {
  at: string;
  jobId: string;
  jobType: string;
  model: string;
  outcome: 'done' | 'failed' | 'cancelled';
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd?: number;
  durationMs: number;
}

export interface EngineView {
  engine: EngineId;
  builtin: BuiltinView;
  budget: { monthlyUsd?: number };
  problem: string | null;
  status: WorkerStatus;
  usage: {
    month: { month: string; jobs: number; failed: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number; unpriced: number };
    recent: UsageEntry[];
  };
}

/** What Settings sends: only changed fields matter. apiKey '' removes the stored key; null clears a price or cap. */
export interface EnginePatch {
  engine?: EngineId;
  builtin?: Partial<Omit<BuiltinView, 'hasKey' | 'keySource' | 'pricing'>> & {
    apiKey?: string;
    pricing?: { [K in keyof Pricing]?: number | null };
  };
  budget?: { monthlyUsd?: number | null };
}

export interface ProbeResult {
  ok: boolean;
  label: string;
  ms: number;
  detail: string;
  inputTokens?: number;
  outputTokens?: number;
}

const node = (tl: string, id: string, action = '') => `/api/timelines/${tl}/nodes/${id}${action ? `/${action}` : ''}`;

export const api = {
  listTimelines: () => req<TimelineSummary[]>('GET', '/api/timelines'),
  getTimeline: (id: string) => req<Timeline>('GET', `/api/timelines/${id}`),
  createTimeline: (deviation: DeviationInput, autoContinue: boolean, options?: GenerateOptions) =>
    req<Timeline>('POST', '/api/timelines', { deviation, autoContinue, options }),
  renameTimeline: (id: string, title: string) => req<Timeline>('PATCH', `/api/timelines/${id}`, { title }),
  deleteTimeline: (id: string) => req('DELETE', `/api/timelines/${id}`),
  /** Download link: the whole timeline, or the branch leading to and following nodeId. */
  exportUrl: (id: string, nodeId?: string) => `/api/timelines/${id}/export${nodeId ? `?node=${nodeId}` : ''}`,
  importFile: (data: unknown) => req<Timeline>('POST', '/api/import', data),

  continueFrom: (tl: string, id: string, opts: GenerateOptions) => req<TLNode>('POST', node(tl, id, 'continue'), opts),
  addLink: (tl: string, from: string, to: string, strength: Strength, note: string) =>
    req<InfluenceLink>('POST', `/api/timelines/${tl}/links`, { from, to, strength, note }),
  deleteLink: (tl: string, linkId: string) => req('DELETE', `/api/timelines/${tl}/links/${linkId}`),
  /** `id` influences each target: one new event is generated after every target. Returns the placeholders. */
  influence: (tl: string, id: string, targets: string[], strength: Strength, opts: GenerateOptions) =>
    req<TLNode[]>('POST', node(tl, id, 'influence'), { targets, strength, ...opts }),
  merge: (tl: string, id: string, withIds: string[], opts: GenerateOptions) =>
    req<TLNode>('POST', node(tl, id, 'merge'), { with: withIds, ...opts }),
  branch: (tl: string, id: string, deviation: DeviationInput, autoContinue: boolean, options?: GenerateOptions) =>
    req<TLNode>('POST', node(tl, id, 'branch'), { deviation, autoContinue, options }),
  editNode: (tl: string, id: string, edit: NodeEdit) => req<TLNode>('PATCH', node(tl, id), edit),
  regenerate: (tl: string, id: string, opts: GenerateOptions = {}) => req<TLNode>('POST', node(tl, id, 'regenerate'), opts),
  keep: (tl: string, id: string, subtree = false) => req<TLNode>('POST', node(tl, id, 'keep'), { subtree }),
  cancel: (tl: string, id: string) => req('POST', node(tl, id, 'cancel'), {}),
  retry: (tl: string, id: string) => req<TLNode>('POST', node(tl, id, 'retry'), {}),
  deleteNode: (tl: string, id: string) => req('DELETE', node(tl, id)),

  getEngine: () => req<EngineView>('GET', '/api/engine'),
  saveEngine: (patch: EnginePatch) => req<EngineView>('PUT', '/api/engine', patch),
  /** Runs one tiny request with the given (unsaved) settings on top of the saved ones. */
  testEngine: (patch: EnginePatch) => req<ProbeResult>('POST', '/api/engine/test', patch),
  listModels: (patch: EnginePatch) => req<{ models: string[] }>('POST', '/api/engine/models', patch),
};
