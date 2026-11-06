import { config } from './config.ts';
import { pruneArticles } from './db.ts';
import type { Feed } from './db.ts';
import { fetchFeed } from './feeds/fetch.ts';
import { parseFeed } from './feeds/parse.ts';
import { log } from './logger.ts';
import { broadcast, clientCount } from './notify/stream.ts';
import {
  alertMute,
  allEnabledFeeds,
  dueFeeds,
  expireAlertMute,
  ingestItems,
  markFeedResult,
  markNotified,
  relativeMatchView,
} from './store.ts';
import type { MatchEvent } from './store.ts';

let running = false;
let timer: NodeJS.Timeout | null = null;
let lastPruneAt = 0;

export const pollerState = {
  cycles: 0,
  lastCycleAt: 0,
  lastCycleMs: 0,
  articlesStored: 0,
  alertsSent: 0,
};

async function pollOne(feed: Feed): Promise<MatchEvent[]> {
  const res = await fetchFeed(feed.url, feed.etag, feed.last_modified);

  if (res.status === 'not-modified') {
    markFeedResult(feed.id, { ok: true, status: '304 not modified' });
    return [];
  }
  if (res.status === 'error') {
    markFeedResult(feed.id, { ok: false, status: res.message });
    log.warn(`feed failed: ${feed.title || feed.url} — ${res.message}`);
    return [];
  }

  let items;
  try {
    items = parseFeed(res.body).items;
  } catch (err) {
    markFeedResult(feed.id, { ok: false, status: `parse error: ${(err as Error).message}` });
    return [];
  }

  const { stored, events } = ingestItems(feed, items);
  markFeedResult(feed.id, {
    ok: true,
    status: stored > 0 ? `ok, ${stored} new` : 'ok',
    etag: res.etag,
    lastModified: res.lastModified,
    items: items.length,
  });

  pollerState.articlesStored += stored;
  if (stored > 0) log.debug(`${feed.title || feed.url}: ${stored} new of ${items.length}`);
  return events;
}

/** Runs `workers` feeds concurrently, pulling from a shared queue. */
async function drain(feeds: Feed[], workers: number): Promise<MatchEvent[]> {
  const queue = [...feeds];
  const events: MatchEvent[] = [];

  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async () => {
      for (let feed = queue.shift(); feed; feed = queue.shift()) {
        try {
          events.push(...(await pollOne(feed)));
        } catch (err) {
          markFeedResult(feed.id, { ok: false, status: (err as Error).message });
          log.error(`unexpected error polling ${feed.url}`, err);
        }
      }
    }),
  );
  return events;
}

/**
 * @param force ignore the polling schedule and sweep every enabled feed. The
 *   manual refresh button uses this — otherwise pressing it moments after an
 *   automatic sweep would find nothing due and appear to do nothing at all.
 */
export async function runCycle(force = false): Promise<MatchEvent[]> {
  // A scheduled tick that collides with an in-flight sweep is simply skipped —
  // the next one is only seconds away. A forced sweep is a direct user action,
  // so it queues behind the running one instead of being silently dropped.
  if (running) {
    if (!force) return [];
    // `running` is set synchronously below, so only one waiter can ever win.
    while (running) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  running = true;
  const started = Date.now();

  // The tick is the expiry clock for a timed mute, so no separate timer exists.
  // Readers already treat a lapsed mute as unmuted; this is what clears the row
  // and announces it, once, to the dashboard and the tray.
  const expired = expireAlertMute();
  if (expired) broadcast('alerts', expired);

  try {
    const feeds = force ? allEnabledFeeds() : dueFeeds(config.concurrency * 4);

    const events = feeds.length > 0 ? await drain(feeds, config.concurrency) : [];

    if (events.length > 0) {
      broadcast('matches', events.map(relativeMatchView));
      markNotified(events.map((e) => e.matchId));
      pollerState.alertsSent += events.length;

      /**
       * The listener count *is* the alert path's health. Alerts are raised by
       * whoever holds the stream — the desktop shell — so zero listeners means
       * the match was recorded and nothing was announced. Logging the count
       * makes that visible; the old line reported push deliveries, which sat at
       * zero for a day without anyone being able to tell why.
       */
      const listeners = clientCount();
      const mute = alertMute();
      const muteNote = mute.muted
        ? ` (muted${mute.mutedUntil === null ? '' : ` until ${new Date(mute.mutedUntil).toISOString()}`})`
        : '';
      log.info(
        `${events.length} new match${events.length === 1 ? '' : 'es'} → ${listeners} listener${listeners === 1 ? '' : 's'}${muteNote}`,
      );
      // Two different silences. A mute is the user's own choice and says so on
      // the line above; zero listeners is the alert path being broken, which is
      // how a day of alerts was lost once, so it keeps its warning either way.
      if (listeners === 0) {
        log.warn('no alert listener connected — matches recorded, nothing announced');
      }
    }

    if (Date.now() - lastPruneAt > 3_600_000) {
      lastPruneAt = Date.now();
      pruneArticles(config.retentionDays, config.matchRetentionDays);
    }

    pollerState.cycles++;
    pollerState.lastCycleAt = Date.now();
    pollerState.lastCycleMs = Date.now() - started;
    broadcast('cycle', { feeds: feeds.length, matches: events.length, at: pollerState.lastCycleAt });
    return events;
  } finally {
    running = false;
  }
}

export function startPoller(): void {
  if (timer) return;
  timer = setInterval(() => {
    runCycle().catch((err) => log.error('poll cycle failed', err));
  }, config.tickMs);
  log.info(`poller started (tick ${config.tickMs}ms, concurrency ${config.concurrency})`);
  runCycle().catch((err) => log.error('initial poll cycle failed', err));
}

export function stopPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function isPolling(): boolean {
  return running;
}
