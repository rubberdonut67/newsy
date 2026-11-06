import { statSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HOME, ROOT, config, dataMoveError, secrets } from './config.ts';
import {
  OWNED_FILES,
  ensureWritable,
  readStoredLocation,
  validateTarget,
  writeStoredLocation,
} from './datadir.ts';
import { log } from './logger.ts';
import { QueryError } from './matcher.ts';
import { addClient, broadcast, clientCount, startHeartbeat } from './notify/stream.ts';
import { isPolling, pollerState, runCycle } from './poller.ts';
import {
  addFeed,
  addPublisher,
  alertMute,
  createTopic,
  deleteFeed,
  deletePublisher,
  deleteTopic,
  listFeeds,
  listMatches,
  listPublishers,
  listTopics,
  markRead,
  previewQuery,
  setAlertMute,
  setFeedEnabled,
  setPublisherBlocking,
  stats,
  topicCounts,
  updateTopic,
} from './store.ts';

const AUTH_COOKIE = 'newsy_session';
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/api/health', '/styles.css', '/favicon.svg']);

export async function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: true });

  await app.register(cookie, { secret: secrets.sessionSecret });
  await app.register(fastifyStatic, { root: path.join(ROOT, 'public'), index: false });

  // --- Auth -----------------------------------------------------------------

  function authed(req: FastifyRequest): boolean {
    if (!config.password) return true;
    const raw = req.cookies[AUTH_COOKIE];
    if (!raw) return false;
    const result = app.unsignCookie(raw);
    return result.valid && result.value === 'ok';
  }

  app.addHook('onRequest', async (req, reply) => {
    if (!config.password) return;
    const url = req.url.split('?')[0];
    if (PUBLIC_PATHS.has(url) || authed(req)) return;

    if (url.startsWith('/api/')) {
      return reply.code(401).send({ error: 'Not authenticated' });
    }
    return reply.redirect('/login');
  });

  app.post('/api/login', async (req, reply) => {
    const body = (req.body ?? {}) as { password?: string };
    if (!config.password) return { ok: true };
    if (typeof body.password !== 'string' || body.password !== config.password) {
      // Keep failures cheap but not instant, to blunt trivial guessing.
      await new Promise((r) => setTimeout(r, 400));
      return reply.code(401).send({ error: 'Incorrect password' });
    }
    reply.setCookie(AUTH_COOKIE, 'ok', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      secure: req.protocol === 'https',
      maxAge: 60 * 60 * 24 * 90,
    });
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(AUTH_COOKIE, { path: '/' });
    return { ok: true };
  });

  // --- Pages ----------------------------------------------------------------

  app.get('/', (_req, reply) => reply.sendFile('index.html'));
  app.get('/login', (_req, reply) => reply.sendFile('login.html'));
  // `app` and `pid` let the installed shell tell its own service apart from
  // anything else answering on the port, and stop one it did not start itself
  // (left behind by a shell that crashed).
  app.get('/api/health', async () => ({
    ok: true,
    app: 'newsy',
    pid: process.pid,
    uptime: Math.round(process.uptime()),
  }));

  // --- Where the data physically lives --------------------------------------

  /**
   * Reported to the Developer tab. `locked` means `DATA_DIR` is set in the
   * environment, which outranks anything chosen here — saying so is better than
   * accepting a change that would be silently ignored.
   */
  app.get('/api/data-location', async () => {
    const stored = readStoredLocation(HOME);
    let bytes = 0;
    for (const name of OWNED_FILES) {
      try {
        bytes += statSync(path.join(config.dataDir, name)).size;
      } catch {
        /* not every owned file exists */
      }
    }
    return {
      current: config.dataDir,
      default: path.join(HOME, 'data'),
      chosen: stored.dataDir ?? '',
      pendingMoveFrom: stored.moveFrom ?? '',
      locked: Boolean(process.env.DATA_DIR),
      bytes,
      moveError: dataMoveError ?? '',
    };
  });

  app.post('/api/data-location', async (req, reply) => {
    const body = (req.body ?? {}) as { path?: string; move?: boolean };

    if (process.env.DATA_DIR) {
      return reply
        .code(409)
        .send({ error: 'DATA_DIR is set in the environment and overrides this setting.' });
    }

    // Validate the raw input, then resolve. Resolving first turns an empty
    // string into the working directory, which passes every later check and
    // quietly points the database at the project folder.
    const raw = String(body.path ?? '').trim();
    const invalid = validateTarget(raw, config.dataDir);
    if (invalid) return reply.code(400).send({ error: invalid });

    const target = path.resolve(raw);

    const unwritable = ensureWritable(target);
    if (unwritable) return reply.code(400).send({ error: unwritable });

    // The move itself is deferred to the next startup, where nothing holds the
    // database open. Recorded here, performed in config.ts.
    writeStoredLocation(HOME, {
      dataDir: target,
      ...(body.move === false ? {} : { moveFrom: config.dataDir }),
    });

    log.info(`data directory will change to ${target} on next start`);
    return { ok: true, target, willMove: body.move !== false };
  });

  // --- State ----------------------------------------------------------------

  app.get('/api/state', async () => {
    const counts = topicCounts();
    return {
      topics: listTopics().map((t) => ({ ...t, counts: counts[t.id] ?? { total: 0, unread: 0 } })),
      stats: stats(),
      poller: { ...pollerState, running: isPolling(), streams: clientCount() },
      alerts: alertMute(),
      authEnabled: Boolean(config.password),
    };
  });

  // --- Alert mute -----------------------------------------------------------
  //
  // A global mute, on top of the per-topic `notify` flag. The service only
  // *holds* the state; the Windows notification is suppressed by the desktop
  // shell, which is the process that raises it (see desktop/notifier.js). Three
  // processes need to agree on this — the dashboard, the shell and the tray —
  // and loopback HTTP is the only thing they share.

  app.patch('/api/alerts', async (req, reply) => {
    const body = (req.body ?? {}) as { muted?: boolean; minutes?: number | null; scope?: string };

    if (body.scope !== undefined && body.scope !== 'toasts' && body.scope !== 'all') {
      return reply.code(400).send({ error: 'scope must be "toasts" or "all"' });
    }
    if (body.minutes !== undefined && body.minutes !== null && !Number.isFinite(body.minutes)) {
      return reply.code(400).send({ error: 'minutes must be a number' });
    }

    const state = setAlertMute({ muted: body.muted, minutes: body.minutes, scope: body.scope as never });
    // The shell holds the stream and gates the toast, so it has to hear about
    // this immediately rather than at the next poll cycle.
    broadcast('alerts', state);
    return state;
  });

  // --- Topics ---------------------------------------------------------------

  app.get('/api/topics', async () => listTopics());

  app.post('/api/topics', async (req, reply) => {
    const body = (req.body ?? {}) as {
      name?: string;
      query?: string;
      notify?: boolean;
      useGnews?: boolean;
    };
    if (!body.query?.trim()) return reply.code(400).send({ error: 'A query is required' });
    const topic = createTopic({
      name: (body.name ?? '').trim() || body.query.trim(),
      query: body.query,
      notify: body.notify,
      useGnews: body.useGnews,
    });
    // A brand-new topic should not wait for the next scheduled tick.
    runCycle().catch((err) => log.error('post-create poll failed', err));
    return reply.code(201).send(topic);
  });

  app.post('/api/topics/preview', async (req, reply) => {
    const body = (req.body ?? {}) as { query?: string };
    if (!body.query?.trim()) return reply.code(400).send({ error: 'A query is required' });
    return previewQuery(body.query);
  });

  app.patch('/api/topics/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as {
      name?: string;
      query?: string;
      enabled?: boolean;
      notify?: boolean;
      useGnews?: boolean;
    };
    const result = updateTopic(id, body);
    if (!result) return reply.code(404).send({ error: 'No such topic' });
    // Report what changing the query did, so the UI can say so.
    return { ...result.topic, added: result.added, removed: result.removed };
  });

  app.delete('/api/topics/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!deleteTopic(id)) return reply.code(404).send({ error: 'No such topic' });
    return { ok: true };
  });

  // --- Matches --------------------------------------------------------------

  /** `?topic=3` or `?topic=3,7,11` — several topics merge into one feed. */
  function parseTopicIds(raw: string | undefined): number[] {
    if (!raw) return [];
    return raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isInteger(id) && id > 0);
  }

  app.get('/api/matches', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return listMatches({
      topicIds: parseTopicIds(q.topic),
      unreadOnly: q.unread === '1' || q.unread === 'true',
      since: q.since ? Number(q.since) : undefined,
      limit: q.limit ? Number(q.limit) : 100,
    });
  });

  app.post('/api/matches/read', async (req) => {
    const body = (req.body ?? {}) as { ids?: number[]; all?: boolean; topicIds?: number[] };
    const changed = body.all
      ? markRead('all', (body.topicIds ?? []).map(Number))
      : markRead((body.ids ?? []).map(Number));
    return { ok: true, changed };
  });

  // --- Feeds ----------------------------------------------------------------

  app.get('/api/feeds', async () => listFeeds());

  app.post('/api/feeds', async (req, reply) => {
    const body = (req.body ?? {}) as { url?: string; title?: string; category?: string };
    if (!body.url?.trim()) return reply.code(400).send({ error: 'A feed URL is required' });
    try {
      new URL(body.url);
    } catch {
      return reply.code(400).send({ error: 'That is not a valid URL' });
    }
    const feed = addFeed(body.url, body.title, body.category);
    runCycle().catch((err) => log.error('post-add poll failed', err));
    return reply.code(201).send(feed);
  });

  app.patch('/api/feeds/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'Only `enabled` can be changed' });
    }
    if (!setFeedEnabled(id, body.enabled)) return reply.code(404).send({ error: 'No such feed' });
    return { ok: true };
  });

  app.delete('/api/feeds/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!deleteFeed(id)) {
      return reply.code(404).send({ error: 'No such feed, or it belongs to a topic' });
    }
    return { ok: true };
  });

  app.post('/api/refresh', async () => {
    const events = await runCycle(true);
    return { ok: true, matches: events.length };
  });

  // --- Publishers -----------------------------------------------------------
  //
  // Only the *registry* lives here — which sites the user subscribes to and
  // where to sign in. The signed-in session itself is held by the desktop
  // shell's cookie jar and never reaches the server, so there are no
  // credentials on these routes by design.

  app.get('/api/publishers', async () => listPublishers());

  app.post('/api/publishers', async (req, reply) => {
    const body = (req.body ?? {}) as { url?: string; name?: string };
    if (!body.url?.trim()) return reply.code(400).send({ error: 'A site URL or domain is required' });
    const publisher = addPublisher({ url: body.url, name: body.name });
    if (!publisher) return reply.code(400).send({ error: 'That is not a valid site' });
    return reply.code(201).send(publisher);
  });

  app.patch('/api/publishers/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { blockingEnabled?: boolean };
    if (typeof body.blockingEnabled !== 'boolean') {
      return reply.code(400).send({ error: 'Only `blockingEnabled` can be changed' });
    }
    const publisher = setPublisherBlocking(id, body.blockingEnabled);
    if (!publisher) return reply.code(404).send({ error: 'No such publisher' });
    return publisher;
  });

  app.delete('/api/publishers/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!deletePublisher(id)) return reply.code(404).send({ error: 'No such publisher' });
    return { ok: true };
  });

  // Web Push was removed entirely on 22 Aug 2026, along with `/api/push/*`,
  // the `subscriptions` table and the VAPID keys. Alerts are raised by whoever
  // holds `/api/events` — see `desktop/notifier.js`. A stale service worker may
  // still POST to `/api/push/subscribe`; Fastify answers 404 and the worker
  // gives up, which is the intended outcome.

  // --- Live stream ----------------------------------------------------------

  app.get('/api/events', (_req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    addClient(reply.raw);
  });

  startHeartbeat();

  // --- Errors ---------------------------------------------------------------

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof QueryError) return reply.code(400).send({ error: err.message });
    log.error(`request failed: ${err.message}`, err.stack);
    return reply.code(err.statusCode ?? 500).send({ error: err.message || 'Internal error' });
  });

  return app;
}
