import { useEffect, useState } from 'react';
import type { ServerEvent, Timeline, TimelineSummary, TLNode, WorkerStatus } from '../../shared/types.ts';
import { api } from './api.ts';

export interface LiveState {
  connected: boolean;
  timelines: TimelineSummary[];
  worker: WorkerStatus | null;
  timeline: Timeline | null;
  /** True once the requested timeline was fetched (or found missing). */
  loaded: boolean;
}

/** Whether two versions of a node hold the same content (fields are strings, numbers, string arrays or small objects). */
function sameNode(a: TLNode, b: TLNode): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof TLNode>;
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
    } else if (x && y && typeof x === 'object' && typeof y === 'object') {
      if (JSON.stringify(x) !== JSON.stringify(y)) return false;
    } else return false;
  }
  return true;
}

/**
 * The server sends the whole timeline on every change. Keep the old object for every node whose content is
 * the same, so the canvas re-renders only the cards that changed (see toFlow's reuse).
 */
function keepUnchanged(cur: Timeline, next: Timeline): Timeline {
  for (const [id, n] of Object.entries(next.nodes)) {
    const old = cur.nodes[id];
    if (old && sameNode(old, n)) next.nodes[id] = old;
  }
  return next;
}

/** Subscribes to server-sent events and keeps the open timeline in sync. */
export function useLive(timelineId: string | null): LiveState {
  const [connected, setConnected] = useState(false);
  const [timelines, setTimelines] = useState<TimelineSummary[]>([]);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  /** Which timeline id the last fetch finished for (null = the landing page). */
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);

  // One stream per open timeline: the server only sends a timeline's updates to pages showing it.
  useEffect(() => {
    let es: EventSource;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastMessage = Date.now();
    let opened = false;
    const reconnect = () => {
      es.close();
      setConnected(false);
      clearTimeout(retry);
      retry = setTimeout(connect, 2000);
    };
    const connect = () => {
      lastMessage = Date.now();
      es = new EventSource(timelineId ? `/api/events?timeline=${encodeURIComponent(timelineId)}` : '/api/events');
      es.onopen = () => {
        setConnected(true);
        // Updates sent while the stream was down are lost: catch up once it is back.
        if (opened && timelineId) {
          api
            .getTimeline(timelineId)
            .then((tl) => setTimeline((cur) => (cur?.id === tl.id ? tl : cur)))
            .catch(() => {});
        }
        opened = true;
      };
      es.onerror = () => {
        setConnected(false);
        // A failed proxy response (backend down) closes the stream for good; reopen it ourselves.
        if (es.readyState === EventSource.CLOSED) reconnect();
      };
      es.onmessage = (msg) => {
        lastMessage = Date.now();
        setConnected(true);
        const ev = JSON.parse(msg.data) as ServerEvent;
        if (ev.type === 'timelines') setTimelines(ev.timelines);
        else if (ev.type === 'worker') setWorker(ev.status);
        else if (ev.type === 'timeline') setTimeline((cur) => (cur && cur.id === ev.timeline.id ? keepUnchanged(cur, ev.timeline) : cur));
        else if (ev.type === 'timeline-deleted') setTimeline((cur) => (cur?.id === ev.id ? null : cur));
      };
    };
    connect();
    // The server pings every 5s; silence means the stream died without an error event.
    const watchdog = setInterval(() => {
      if (Date.now() - lastMessage > 12_000) reconnect();
    }, 3_000);
    return () => {
      clearInterval(watchdog);
      clearTimeout(retry);
      es.close();
    };
  }, [timelineId]);

  useEffect(() => {
    if (!timelineId) {
      setTimeline(null);
      setLoadedFor(null);
      return;
    }
    let alive = true;
    api
      .getTimeline(timelineId)
      .then((tl) => alive && setTimeline(tl))
      .catch(() => alive && setTimeline(null))
      .finally(() => alive && setLoadedFor(timelineId));
    return () => {
      alive = false;
    };
  }, [timelineId]);

  // Re-sync after a reconnect in case events were missed.
  useEffect(() => {
    if (connected && timelineId) api.getTimeline(timelineId).then(setTimeline).catch(() => {});
  }, [connected, timelineId]);

  // Never hand back the previous timeline while switching to another one.
  const current = timeline && timeline.id === timelineId ? timeline : null;
  return { connected, timelines, worker, timeline: current, loaded: loadedFor === timelineId };
}
