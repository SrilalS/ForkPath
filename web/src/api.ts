import type { InfluenceLink, Strength, Timeline, TimelineSummary, TLNode } from '../../shared/types.ts';

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
};
