import type { Response } from 'express';
import type { ServerEvent } from '../../shared/types.ts';

const clients = new Set<Response>();

export function addClient(res: Response, initial: ServerEvent[]) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  clients.add(res);
  for (const ev of initial) send(res, ev);
  res.on('close', () => clients.delete(res));
}

function send(res: Response, ev: ServerEvent) {
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

export function broadcast(ev: ServerEvent) {
  for (const res of clients) send(res, ev);
}

// Heartbeat as a real event: the client reconnects if these stop (a dev proxy can keep a dead stream open).
setInterval(() => broadcast({ type: 'ping' }), 5_000).unref();
