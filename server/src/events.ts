import type { Response } from 'express';
import type { ServerEvent } from '../../shared/types.ts';

/** Each open stream and the timeline its page shows (null on the landing and doc pages). */
const clients = new Map<Response, string | null>();

export function addClient(res: Response, timelineId: string | null, initial: ServerEvent[]) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  clients.set(res, timelineId);
  for (const ev of initial) res.write(frame(ev));
  res.on('close', () => clients.delete(res));
}

const frame = (ev: ServerEvent) => `data: ${JSON.stringify(ev)}\n\n`;

/**
 * Sends an event to every open stream. A whole timeline (the biggest event by far) goes only to streams
 * showing that timeline, and is serialized once however many streams there are.
 */
export function broadcast(ev: ServerEvent) {
  const data = frame(ev);
  const only = ev.type === 'timeline' ? ev.timeline.id : null;
  for (const [res, showing] of clients) if (!only || showing === only) res.write(data);
}

// Heartbeat as a real event: the client reconnects if these stop (a dev proxy can keep a dead stream open).
setInterval(() => broadcast({ type: 'ping' }), 5_000).unref();
