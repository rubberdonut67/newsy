import type { ServerResponse } from 'node:http';
import { log } from '../logger.ts';

type Client = { id: number; res: ServerResponse };

const clients = new Set<Client>();
let nextId = 1;

/** Attaches a server-sent-events stream so an open dashboard updates live. */
export function addClient(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const client: Client = { id: nextId++, res };
  clients.add(client);
  log.debug(`sse client connected (${clients.size} open)`);

  const drop = () => {
    clients.delete(client);
    log.debug(`sse client disconnected (${clients.size} open)`);
  };
  res.on('close', drop);
  res.on('error', drop);
}

export function broadcast(event: string, data: unknown): void {
  if (clients.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

export function clientCount(): number {
  return clients.size;
}

/** Proxies and load balancers hang up on idle streams; a comment keeps them open. */
export function startHeartbeat(intervalMs = 25_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    for (const client of clients) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
