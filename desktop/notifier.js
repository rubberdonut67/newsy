import { Notification } from 'electron';
import { UNMUTED, coerceMute, muteActive } from './mute.js';
import { connectSSE } from './sse.js';

/**
 * Desktop alerts, driven by the same server-sent-events stream the dashboard
 * already listens to.
 *
 * Since Web Push was removed on 22 Aug 2026 this is Newsy's *only* alert path.
 * It needs no service worker, no VAPID subscription and no live browser profile:
 * the shell is a long-running process holding an open stream, so it raises the
 * OS notification itself. Started by `startAlerts()` in `main.js`, which runs it
 * for the life of the process — not for the life of a window.
 */

/**
 * The global mute. This is the only place a toast can be stopped from reaching
 * Windows, because `new Notification(...).show()` below is the only place one is
 * raised. Muting here rather than in the service is deliberate: collecting,
 * matching, unread counts and the dashboard's own banner all carry on, and only
 * the pop-up goes away.
 *
 * The rule itself lives in `mute.js` so it can be tested outside Electron.
 */
let mute = UNMUTED;

export function setMuteState(next) {
  const state = coerceMute(next);
  if (state) mute = state;
}

/** One notification per topic, so a burst does not become a stack of toasts. */
function groupByTopic(rows) {
  const groups = new Map();
  for (const row of rows) {
    for (const topic of row.topics ?? []) {
      const list = groups.get(topic.name);
      if (list) list.push(row);
      else groups.set(topic.name, [row]);
    }
  }
  return groups;
}

export function startNotifier({ origin, headers, onOpenArticle, onEvent, log }) {
  const controller = new AbortController();

  connectSSE(`${origin}/api/events`, {
    headers,
    signal: controller.signal,
    onStatus: (status, err) => {
      if (status === 'connected') log('alert stream connected');
      else log(`alert stream lost (${err?.message ?? 'unknown'}) — retrying`);
    },
    onEvent: (event, data) => {
      onEvent?.(event, data);
      if (event === 'alerts') setMuteState(data);
      if (event !== 'matches' || !Array.isArray(data) || data.length === 0) return;
      if (!Notification.isSupported()) return;
      if (muteActive(mute)) {
        log(`muted — ${data.length} match${data.length === 1 ? '' : 'es'} not announced`);
        return;
      }

      for (const [topic, rows] of groupByTopic(data)) {
        const newest = rows[0];
        const note = new Notification({
          title: `📰 ${topic}`,
          body:
            rows.length === 1
              ? `${newest.title}${newest.source ? ` — ${newest.source}` : ''}`
              : `${rows.length} new articles matched`,
        });
        // Clicking an alert should land on the article itself, in the reader.
        note.on('click', () => onOpenArticle(rows.length === 1 ? newest.url : null));
        note.show();
      }
    },
  });

  return () => controller.abort();
}
