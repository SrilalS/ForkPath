import { useEffect, useState } from 'react';
import type { ServerEvent, Timeline, TimelineSummary, WorkerStatus } from '../../shared/types.ts';
import { api } from './api.ts';

export interface LiveState {
  connected: boolean;
  timelines: TimelineSummary[];
  worker: WorkerStatus | null;
  timeline: Timeline | null;
  /** True once the requested timeline was fetched (or found missing). */
  loaded: boolean;
}

/** Subscribes to server-sent events and keeps the open timeline in sync. */
export function useLive(timelineId: string | null): LiveState {
  const [connected, setConnected] = useState(false);
  const [timelines, setTimelines] = useState<TimelineSummary[]>([]);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  /** Which timeline id the last fetch finished for (null = the landing page). */
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let es: EventSource;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastMessage = Date.now();
    const reconnect = () => {
      es.close();
      setConnected(false);
      clearTimeout(retry);
      retry = setTimeout(connect, 2000);
    };
    const connect = () => {
      lastMessage = Date.now();
      es = new EventSource('/api/events');
      es.onopen = () => setConnected(true);
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
        else if (ev.type === 'timeline') setTimeline((cur) => (cur && cur.id === ev.timeline.id ? ev.timeline : cur));
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
  }, []);

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
