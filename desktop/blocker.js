import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { net } from 'electron';

/**
 * Ad, tracker, annoyance and scam blocking for the reader.
 *
 * Chrome gets this from extensions — ad blockers, tracker blockers and scam-site
 * guards. Extensions are Chrome-bound, so none of them reach an Electron webview
 * and the reader would otherwise load every tracker on the page.
 *
 * The annoyance lists are the ones that matter most for how the page *feels*:
 * EasyList alone blocks ad requests but leaves cookie banners, newsletter
 * overlays and subscribe interstitials untouched, which is most of what reads as
 * "too many ads".
 *
 * System-level protection (a VPN's or the OS's DNS filtering, Defender) already
 * covers Electron where a user has it, so this deliberately does not duplicate
 * DNS filtering.
 */
const LISTS = [
  // Ads and tracking — the ad-blocker / tracker-blocker extension equivalent.
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  // Annoyances: cookie notices, newsletter overlays, social widgets.
  'https://easylist.to/easylist/fanboy-annoyance.txt',
  'https://easylist.to/easylist/fanboy-social.txt',
  'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
  // uBlock Origin's own filters — what makes it outperform plain EasyList.
  'https://ublockorigin.github.io/uAssets/filters/filters.txt',
  'https://ublockorigin.github.io/uAssets/filters/privacy.txt',
  'https://ublockorigin.github.io/uAssets/filters/badware.txt',
  'https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt',
  // Scam and malware domains — the Browser Guard equivalent.
  'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt',
  'https://malware-filter.gitlab.io/malware-filter/phishing-filter.txt',
];

/** One slow list must not hold the engine hostage. */
const LIST_TIMEOUT_MS = 20_000;

/** Rebuild from the network at most this often; lists change slowly. */
const MAX_CACHE_AGE_MS = 24 * 3_600_000;

let blocker = null;
let ready = false;
let listsLoaded = 0;
let builtAt = 0;

/** Blocked-request counts. Per-page resets on navigation; session is cumulative. */
let pageBlocked = 0;
let sessionBlocked = 0;

/** Registrable domains the user has exempted, and the session blocking is attached to. */
let allowDomains = new Set();
let attached = null;

export function setAllowlist(domains) {
  allowDomains = new Set(domains.map((d) => d.toLowerCase()));
}

function isAllowlisted(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const domain of allowDomains) {
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/**
 * Turns blocking off for an exempted site and back on for everything else.
 *
 * The obvious implementation — adding `@@||domain^$document` exception filters —
 * silently does nothing here, which cost a debugging round to find. Those
 * exceptions are matched against the *request* URL, so they whitelist requests
 * TO the publisher; an ad request goes to some ad network's domain and never
 * matches. uBlock treats document-exceptions specially in its extension layer,
 * and this library's `match()` has no equivalent.
 *
 * Toggling the session is the honest mechanism: the reader shows exactly one
 * page at a time, so "blocking off for this site" and "blocking off for this
 * session, while this site is open" are the same statement.
 */
export function applyForUrl(url) {
  if (!blocker || !attached) return;
  const shouldBlock = !isAllowlisted(url);
  const blocking = blocker.isBlockingEnabled(attached);
  if (shouldBlock && !blocking) blocker.enableBlockingInSession(attached);
  else if (!shouldBlock && blocking) blocker.disableBlockingInSession(attached);
}

/** Exposed for diagnostics: whether the *current* page is being filtered. */
export const isBlockingNow = () => Boolean(blocker && attached && blocker.isBlockingEnabled(attached));

export function resetPageCount() {
  pageBlocked = 0;
}

/** Diagnostics for the Developer section; never surfaced in normal use. */
export function blockerStats() {
  return {
    ready,
    lists: listsLoaded,
    listsConfigured: LISTS.length,
    builtAt,
    pageBlocked,
    sessionBlocked,
    blockingThisPage: isBlockingNow(),
  };
}

export const isReady = () => ready;

/**
 * Fetches every list with an individual timeout and tolerates failures. A dead
 * or slow host degrades coverage; it must never leave the reader with no engine
 * at all.
 *
 * **Uses `net.fetch`, not global `fetch`.** Global fetch in an Electron main
 * process is Node's undici, and on this machine every list died with
 * `UND_ERR_CONNECT_TIMEOUT` — reproducibly, 11 out of 11, on every cold start,
 * while the identical undici request from a bare script succeeded. `net.fetch`
 * goes through Chromium's network stack instead, which is what the rest of the
 * app already uses and what Electron recommends from the main process: it picks
 * up the system proxy and certificate store rather than undici's own.
 */
async function fetchLists(log) {
  const bodies = await Promise.all(
    LISTS.map(async (url) => {
      try {
        const res = await net.fetch(url, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (err) {
        // `err.message` on a failed fetch is the useless string "fetch failed";
        // the actionable part (ENOTFOUND, CONNECT_TIMEOUT, cert errors) is only
        // ever on `err.cause`. Logging without it makes this undiagnosable.
        const cause = err.cause?.code || err.cause?.message;
        log(
          `filter list unavailable: ${new URL(url).hostname} (${err.message}${cause ? `: ${cause}` : ''})`,
        );
        return '';
      }
    }),
  );
  const usable = bodies.filter(Boolean);
  return { text: usable.join('\n'), count: usable.length };
}

async function cacheAge(file) {
  try {
    return Date.now() - (await stat(file)).mtimeMs;
  } catch {
    return Infinity;
  }
}

/** The sidecar written next to the cache: how many lists went in, and when. */
async function readMeta(metaPath) {
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    return { lists: meta.lists ?? 0, builtAt: meta.builtAt ?? 0 };
  } catch {
    // A cache written before the sidecar existed, or none at all. Report what
    // is actually known rather than inventing a full-coverage number.
    return null;
  }
}

/**
 * Deserializes the cached engine, whatever its age. Returns null when there is
 * no cache or it cannot be read; the caller decides whether that matters.
 */
async function restoreCache(cachePath, metaPath) {
  try {
    const engine = ElectronBlocker.deserialize(new Uint8Array(await readFile(cachePath)));
    const meta = await readMeta(metaPath);
    return { blocker: engine, listsLoaded: meta?.lists ?? 0, builtAt: meta?.builtAt ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Attaches blocking to one session. Only ever called with the reader partition —
 * the dashboard session must stay unfiltered so localhost is never touched.
 *
 * Returns once the engine is attached. The caller shows its window *before*
 * awaiting this: a cold build takes tens of seconds, and the shell must never
 * look dead while it happens.
 */
export async function startBlocking(readerSession, userDataPath, log) {
  const cachePath = path.join(userDataPath, 'blocker-engine.bin');
  // How many lists actually went into the cached engine, and when it was really
  // built. Neither is recoverable from the serialized engine, and guessing them
  // makes the Developer panel lie — see below.
  const metaPath = path.join(userDataPath, 'blocker-engine.meta.json');
  // A fresh cache is worth far more than fresh lists: it is the difference
  // between a one-second start and a forty-second one.
  if ((await cacheAge(cachePath)) < MAX_CACHE_AGE_MS) {
    const cached = await restoreCache(cachePath, metaPath);
    if (cached) {
      ({ blocker, listsLoaded, builtAt } = cached);
      log('blocking engine restored from cache');
    } else {
      log('cached engine unreadable — rebuilding');
    }
  }

  if (!blocker) {
    const { text, count } = await fetchLists(log);

    // Older lists beat no lists. Found on 2026-09-02, with the VPN degraded:
    // 0 of 11 lists were reachable and an eleven-day-old cache was discarded in
    // favour of no engine at all, so every article sat on the "loading filters"
    // card for a full minute and then opened unfiltered. The cache is kept
    // unless the network produced at least as many lists as it holds — a
    // flaky link that yields 2 of 11 must not overwrite a complete engine and
    // then be trusted for the next 24 hours.
    const cachedMeta = await readMeta(metaPath);
    const cachedLists = cachedMeta?.lists ?? 0;
    const keepCache = count === 0 || count < cachedLists;
    const kept = keepCache ? await restoreCache(cachePath, metaPath) : null;

    if (kept) {
      ({ blocker, listsLoaded, builtAt } = kept);
      const when = builtAt ? new Date(builtAt).toISOString().slice(0, 16).replace('T', ' ') : 'an earlier run';
      log(
        `${count === 0 ? 'no' : `only ${count}/${LISTS.length}`} filter lists reachable — ` +
          `keeping the cached engine from ${when} (${listsLoaded || 'unknown'} lists)`,
      );
    } else if (count === 0) {
      log('NO filter lists reachable and no cached engine — reader would be UNFILTERED');
      return false;
    } else {
      blocker = ElectronBlocker.parse(text);
      listsLoaded = count;
      builtAt = Date.now();
      try {
        // Written to a temp path and renamed, because rename is atomic: killing
        // the app mid-write used to leave a half-written engine that the next
        // launch could only throw away, forcing a full rebuild.
        const temp = `${cachePath}.tmp`;
        await writeFile(temp, Buffer.from(blocker.serialize()));
        await rename(temp, cachePath);
        await writeFile(metaPath, JSON.stringify({ lists: count, builtAt }));
      } catch (err) {
        log(`could not cache engine (${err.message}) — next start will rebuild`);
      }
    }
  }

  blocker.on('request-blocked', () => {
    pageBlocked++;
    sessionBlocked++;
  });

  attached = readerSession;
  blocker.enableBlockingInSession(readerSession);
  ready = true;
  // 0 means a cache from before the sidecar existed: the engine is real and
  // attached, the list count simply is not knowable. Say that instead of
  // printing "0/11", which reads like nothing loaded.
  log(
    listsLoaded
      ? `blocking active (${listsLoaded}/${LISTS.length} lists)`
      : 'blocking active (restored from a cache with no recorded list count)',
  );
  return true;
}

// `stopBlocking` was exported here and never called. Blocking is turned on and
// off per navigation by `applyForUrl`, which is the only path that should exist —
// a second way to disable the engine is a second way to leave the reader
// unfiltered by accident. Removed 21 Aug 2026.
