import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserWindow,
  WebContentsView,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
} from 'electron';
import {
  applyForUrl,
  blockerStats,
  isReady,
  resetPageCount,
  setAllowlist,
  startBlocking,
} from './blocker.js';
import { SIGNIN_GRACE_MS, signinWindowOpen } from './grace.js';
import { setMuteState, startNotifier } from './notifier.js';
import { checkForNewsyUpdate } from './release-check.js';
import { createService, serviceEntry } from './service.js';
import { createLoginItem, createTray } from './tray.js';
import { checkForUpdate } from './update-check.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Installed app or run from source — the two differ in who runs the service.
 *
 * From source, the shell is a *client* of a service that scripts and a
 * scheduled task start; it never starts, stops or embeds the server. The
 * installed app has none of those scripts, so it runs the service itself as a
 * child process and owns the tray icon too (see `service.js`, `tray.js`).
 * `NEWSY_MANAGED=1` selects the installed behaviour without packaging, for tests.
 */
const MANAGED = app.isPackaged || process.env.NEWSY_MANAGED === '1';

/**
 * Test hook: a scratch profile, so a test run never touches the real one. Has to
 * be set before anything reads `userData`, and before the single-instance lock.
 */
if (process.env.NEWSY_PROFILE) app.setPath('userData', process.env.NEWSY_PROFILE);

/**
 * The installed app listens on its own port, not 3000. Port 3000 is the default
 * of half the developer tools in existence, and if one of them were answering
 * there the shell would load someone else's page as the dashboard.
 */
const PORT = process.env.PORT || (MANAGED ? '47392' : '3000');

const ORIGIN = (
  process.env.NEWSY_URL || `http://${MANAGED ? '127.0.0.1' : 'localhost'}:${PORT}`
).replace(/\/$/, '');

/**
 * Publisher sign-in is parked for the first public release (Nov 2026); see the
 * matching flag in `public/app.js`. With it off no sign-in grace period can be
 * opened, so pop-ups and storage access stay denied everywhere.
 */
const PUBLISHER_SIGNIN = false;

/**
 * Every publisher session lives in this partition — a cookie jar belonging to
 * Newsy alone. It is what makes the app standalone from Chrome: signing in to a
 * paid subscription here neither reads from nor writes to the browser profile,
 * and it survives restarts because the name is prefixed `persist:`.
 */
const PARTITION = 'persist:newsy-reader';

/** Height of the reader chrome the dashboard draws above the embedded page. */
const TOOLBAR_H = 44;

/**
 * Shown inside the reader when there is nothing else to show — a page that
 * failed to load, or one being held back until the blocking engine attaches.
 *
 * Both of those used to render as an empty view: a failed navigation lands on
 * `chrome-error://chromewebdata/` with no body, and Electron ships none of
 * Chrome's error pages. The result was an invisible panel covering the dashboard
 * that the user could only close, with nothing saying what had happened.
 */
const STATUS_PAGE = path.join(DIR, 'reader-status.html');
const isStatusPage = (url) => typeof url === 'string' && url.includes('reader-status.html');

/**
 * Identity Windows attributes notifications to. See `ensureToastIdentity`.
 *
 * The installed app uses its own ID, matching `build.appId` in package.json, so
 * the installer's Start Menu shortcut carries it and Windows names the toasts
 * "Newsy". A fresh ID also keeps clear of anything Windows cached for the
 * run-from-source registration, which never stopped reading "Electron".
 */
const APP_ID = MANAGED ? 'com.newsy.app' : 'com.newsy.desktop';

/** Where that identity's friendly name and icon live. */
const APP_ID_KEY = `HKCU\\SOFTWARE\\Classes\\AppUserModelId\\${APP_ID}`;

/**
 * Makes Windows call the app "Newsy" in notifications instead of "Electron".
 *
 * Two registrations are needed, and it was the second that actually mattered:
 *
 * 1. A **Start Menu shortcut carrying the AppUserModelID**. `setAppUserModelId`
 *    alone is not enough, and the shortcut `newsy.cmd install` writes carries no
 *    ID at all, because `WScript.Shell` cannot set one — hence writing it here.
 * 2. **`HKCU\Software\Classes\AppUserModelId\<id>`** holding `DisplayName` and
 *    `IconUri`. This is how the working desktop toasts of other installed apps
 *    are registered.
 *
 * **`IconUri` must point at a PNG** — an `.ico` there is actively harmful. Swapping
 * only that value flipped a toast from "Electron" to "Newsy" and back again,
 * reproduced in both directions, so a bad icon does not merely lose the icon: it
 * takes `DisplayName` down with it and Windows falls back to the executable name.
 *
 * **Run from source this is necessary but NOT sufficient.** With the
 * registration correct, toasts still usually read "Electron". Measured 21 Aug,
 * so none of it gets re-attempted blind:
 *
 * - `setAppUserModelId` itself works. Firing under another installed app's AUMID
 *   produced a toast headed with that app's name and icon — so the API and the
 *   registry route are both fine, and the problem is specific to this app's
 *   registration.
 * - The AUMID is not poisoned: a brand-new, never-used ID behaved identically.
 * - Not a stale cache. `Notifications\Settings\com.newsy.desktop` does not exist,
 *   `HandlerAssets` for it is empty (so is that of an app whose toasts work), and
 *   restarting `WpnUserService` changed nothing.
 * - `CustomActivator`/`IconBackgroundColor`, which the working registrations
 *   carry, made no difference when added.
 * - The display name tracks the **Start Menu shortcut's file name** once indexed:
 *   a probe shortcut named `Newsy Alerts.lnk` targeting `electron.exe` produced a
 *   group literally called "Newsy Alerts". Newsy's own shortcut must target
 *   `wscript.exe` (it has to start the service first), and a duplicate named
 *   shortcut in a `Programs\Newsy` subfolder targeting `electron.exe` did not fix
 *   it — though indexing latency makes that result soft.
 *
 * Resolution is also inconsistent between surfaces: the same toast has appeared
 * under "Electron" in the banner while the Notification Center grouped it under
 * "Newsy". So judge this by the Notification Center, not a banner screenshot.
 *
 * **Packaging fixed it** (confirmed 5 Nov 2026): the installer's Start Menu
 * shortcut targets Newsy.exe and carries `com.newsy.app`, and its toasts read
 * "Newsy". The installed app therefore skips this function entirely; it remains
 * for running from source.
 *
 * Both registrations are rewritten whenever they do not match, so they are right
 * no matter which route created them last.
 */
function ensureToastIdentity(log) {
  if (process.platform !== 'win32') return;

  const project = path.join(DIR, '..');
  // Independent of each other: a correct shortcut must not skip the registry
  // write, which is what an early return out of a single combined check did.
  ensureToastShortcut(project, log);
  ensureToastRegistration(project, log);
}

/** The Start Menu shortcut Windows resolves `APP_ID` through. */
function ensureToastShortcut(project, log) {
  const link = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Newsy.lnk',
  );

  // Deliberately the same target as `newsy.cmd install` writes, so the two
  // cannot disagree about what clicking Newsy actually does. In particular it
  // must go through the VBS, which starts the *service* first — pointing this
  // straight at electron.exe gives a shell with nothing behind it.
  const wanted = {
    target: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'),
    args: `"${path.join(project, 'scripts', 'newsy-open.vbs')}"`,
    icon: path.join(project, 'public', 'newsy.ico'),
    iconIndex: 0,
    description: 'Newsy — instant alerts for the topics you follow',
    appUserModelId: APP_ID,
  };

  try {
    const found = shell.readShortcutLink(link);
    // Check the target too, not just the ID: a shortcut with the right ID
    // pointing somewhere else is still wrong, and comparing only the ID meant a
    // bad target survived every relaunch.
    if (
      found.appUserModelId === APP_ID &&
      found.target === wanted.target &&
      found.args === wanted.args
    ) {
      return;
    }
  } catch {
    // Missing or unreadable — writing it below is the fix either way.
  }

  try {
    shell.writeShortcutLink(link, 'create', wanted);
    log('Start-menu shortcut stamped with the Newsy notification identity');
  } catch (err) {
    // Not fatal: alerts still arrive, they just carry the wrong name.
    log(`could not stamp notification identity (${err.message}) — alerts may read "Electron"`);
  }
}

/** Reads one `REG_SZ` value from `APP_ID_KEY`, or null if it is not set. */
function regRead(name) {
  try {
    const out = execFileSync('reg.exe', ['query', APP_ID_KEY, '/v', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // `reg query` prints "    <name>    REG_SZ    <value>". The value is a path
    // and contains spaces, so split on the type and keep the remainder whole.
    return out.match(/REG_(?:EXPAND_)?SZ\s{4}(.*)/)?.[1].trim() ?? null;
  } catch {
    return null; // Key or value missing — the caller writes it.
  }
}

/** The `DisplayName`/`IconUri` pair Windows renders in the toast header. */
function ensureToastRegistration(project, log) {
  // A PNG, deliberately. See the note on `ensureToastIdentity` — `newsy.ico`
  // here silently voids the registration and the toast reverts to "Electron".
  const icon = path.join(project, 'public', 'icon-192.png');

  if (regRead('DisplayName') === 'Newsy' && regRead('IconUri') === icon) return;

  for (const [name, value] of [
    ['DisplayName', 'Newsy'],
    ['IconUri', icon],
  ]) {
    try {
      execFileSync('reg.exe', ['add', APP_ID_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], {
        stdio: 'ignore',
      });
    } catch (err) {
      log(`could not register toast ${name} (${err.message}) — alerts may read "Electron"`);
      return;
    }
  }
  log('notification identity registered — alerts will read "Newsy"');
}

let win = null;
let reader = null;
let stopNotifier = null;
let signinStartedAt = 0;
let blockingActive = false;

/**
 * Guards the once-per-process half of `createWindow`.
 *
 * Closing the window no longer quits Newsy, so the window can be built more than
 * once in a single run — something that was impossible before and that two bits
 * of setup quietly assume cannot happen. `hardenReaderSession` attaches a
 * `will-download` listener (additive: a second pass means two download prompts
 * for one file) and `startBlocking` builds and installs the filter engine.
 * Both belong to the reader session, which outlives any individual window.
 */
let readerSessionReady = false;

/**
 * The page the user actually asked for. The reader's own URL is not a substitute:
 * while the status page is up, `getURL()` is a `file://` path, and reporting that
 * would put it in the toolbar and hand it to "Open in browser".
 */
let readerTarget = '';

/** True while the user is inside the grace period opened by clicking "Sign in". */
const inSigninWindow = () => signinWindowOpen(Date.now(), signinStartedAt);

// --- Server handshake -------------------------------------------------------

/**
 * With NEWSY_PASSWORD set, every route but the login endpoints is gated. The
 * embedded dashboard gets its cookie by loading `/login` like any browser would,
 * but the main process holds its own stream to `/api/events` and has to
 * authenticate separately.
 */
async function authHeaders() {
  const password = process.env.NEWSY_PASSWORD;
  if (!password) return {};
  try {
    const res = await fetch(`${ORIGIN}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const cookie = res.headers.getSetCookie?.().join('; ');
    return cookie ? { cookie } : {};
  } catch {
    return {};
  }
}

/** Polls `/api/health` so a window is never shown against a dead server. */
async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      /* service is probably still coming up after logon */
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

// --- Reader -----------------------------------------------------------------

function readerBounds() {
  const { width, height } = win.getContentBounds();
  return { x: 0, y: TOOLBAR_H, width, height: Math.max(0, height - TOOLBAR_H) };
}

function layoutReader() {
  if (reader && win && !win.isDestroyed()) reader.setBounds(readerBounds());
}

/** Tells the dashboard what to render in the toolbar strip above the page. */
function pushReaderState() {
  if (!win || win.isDestroyed()) return;
  const wc = reader?.webContents;
  const live = wc && !wc.isDestroyed();
  const current = live ? wc.getURL() : '';
  // While the status card is up, report the page the user asked for — showing
  // them a file:// path to Newsy's own error page would be meaningless.
  const onStatus = isStatusPage(current);
  win.webContents.send('reader:state', {
    open: Boolean(reader),
    url: onStatus ? readerTarget : current,
    title: live && !onStatus ? wc.getTitle() : '',
    loading: live ? wc.isLoading() : false,
    canGoBack: live ? wc.navigationHistory.canGoBack() : false,
  });
}

/**
 * Pop-ups are denied by default, as they are in Chrome.
 *
 * The exception is auth: publishers run "sign in with…" through pop-up windows,
 * and one swallowed into the same view loses the OAuth redirect while one opened
 * in Chrome would deposit the session in the wrong cookie jar. So a pop-up is
 * allowed only inside the grace period that clicking "Sign in" opens — a real
 * user action, not a page deciding for itself.
 *
 * This is applied to spawned windows too, via `did-create-window`. A child
 * window gets its own `webContents` and therefore its own handler; without this
 * an allowed auth pop-up could open unlimited further pop-ups, and they would
 * keep working long after the grace period closed.
 */
function applyPopupPolicy(wc) {
  wc.setWindowOpenHandler(({ url: target }) => {
    if (!/^https?:/i.test(target)) return { action: 'deny' };

    if (!inSigninWindow()) {
      // Silent blocking looks like a broken page, so say so.
      win?.webContents.send('reader:popup-blocked', { url: target });
      return { action: 'deny' };
    }

    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520,
        height: 720,
        autoHideMenuBar: true,
        webPreferences: {
          partition: PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    };
  });

  /** Keeps the reader on the web: no file://, no custom protocol handlers. */
  wc.on('will-navigate', (event, target) => {
    if (!/^https?:/i.test(target)) event.preventDefault();
  });

  wc.on('did-create-window', (child) => applyPopupPolicy(child.webContents));
}

/**
 * Puts the status card in the reader. Never let a failure here cascade: if the
 * card itself will not load there is nothing better to fall back to, and an
 * exception would take the open path down with it.
 */
function showReaderStatus(mode, { code, description } = {}) {
  if (!reader || reader.webContents.isDestroyed()) return;
  const query = new URLSearchParams({ mode, url: readerTarget });
  if (code !== undefined) query.set('code', String(code));
  if (description) query.set('desc', description);
  reader.webContents.loadFile(STATUS_PAGE, { search: `?${query}` }).catch(() => {});
}

function openReader(url) {
  if (!win || win.isDestroyed()) return;

  readerTarget = url;

  if (!reader) {
    reader = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        // The reader renders untrusted third-party pages. It gets no preload, no
        // Node integration, and no reach into anything Newsy owns.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const wc = reader.webContents;
    for (const event of [
      'did-navigate',
      'did-navigate-in-page',
      'did-finish-load',
      'did-stop-loading',
      'did-start-loading',
      'page-title-updated',
    ]) {
      wc.on(event, pushReaderState);
    }

    wc.on('did-start-navigation', (_e, navUrl, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      resetPageCount();
      // Re-evaluated per page: the exemption follows the site, not the session.
      applyForUrl(navUrl);
      // Retrying from the status card navigates the view itself, so the target
      // has to follow or the toolbar would still point at the previous page.
      if (/^https?:/i.test(navUrl)) readerTarget = navUrl;
    });

    /**
     * Without this the view simply goes blank and stays blank.
     *
     * `-3` is `ERR_ABORTED`, which fires during ordinary redirects and whenever
     * the user opens something else mid-load. Treating it as a failure would
     * replace perfectly good pages with an error card.
     */
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      if (isStatusPage(validatedURL)) return; // never let the card fail into itself
      console.log(`[newsy] reader load failed: ${errorDescription} (${errorCode}) ${validatedURL}`);
      showReaderStatus('error', { code: errorCode, description: errorDescription });
    });

    applyPopupPolicy(wc);
    win.contentView.addChildView(reader);
  }

  layoutReader();
  resetPageCount();

  // Deferred, never skipped: loading before the engine attaches would render one
  // page with no blocking at all, which is exactly what this is meant to prevent.
  if (isReady()) {
    applyForUrl(url);
    reader.webContents.loadURL(url).catch(() => {});
  } else {
    // This used to send a `reader:waiting` IPC message that nothing anywhere
    // listened for — not in the preload, not in the dashboard — so the wait was
    // an unexplained blank panel. Say so in the view itself instead.
    showReaderStatus('waiting');
    whenBlockingReady().then(() => {
      if (!reader || reader.webContents.isDestroyed()) return;
      // The user may have opened something else while this was waiting; loading
      // the stale URL over it would yank the page out from under them.
      if (readerTarget !== url) return;
      applyForUrl(url);
      reader.webContents.loadURL(url).catch(() => {});
    });
  }
  pushReaderState();
}

/** Resolves once the engine is attached, or after a hard cap so a page is never stranded. */
function whenBlockingReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (isReady() || Date.now() > deadline) return resolve(isReady());
      setTimeout(poll, 250);
    };
    poll();
  });
}

function closeReader() {
  if (!reader || !win || win.isDestroyed()) return;
  win.contentView.removeChildView(reader);
  reader.webContents.close();
  reader = null;
  readerTarget = '';
  pushReaderState();
}

// --- Reader session hardening -----------------------------------------------

/**
 * Permissions a news reader has any business granting. Everything else is
 * refused outright.
 *
 * Electron *approves* permission requests when no handler is installed, where
 * Chrome would prompt — so without this a publisher page can quietly take
 * geolocation or start sending notifications. Fullscreen is allowed because
 * embedded video is legitimate news content.
 */
const ALLOWED_PERMISSIONS = new Set(['fullscreen']);

/**
 * `storage-access` is the one permission a sign-in genuinely needs. Publishers
 * run auth through a third-party frame, and without storage access that frame
 * cannot reach its own cookies, so the login posts and then silently does
 * nothing — which is exactly what "it won't let me log back in" looks like.
 *
 * Granting it permanently would hand every embedded tracker its cookies back,
 * so it rides the same grace period the pop-up exception already uses: opened by
 * clicking "Sign in", closing itself three minutes later. Outside that window it
 * is refused like everything else.
 */
const SIGNIN_PERMISSIONS = new Set(['storage-access']);

function permissionAllowed(permission) {
  if (ALLOWED_PERMISSIONS.has(permission)) return true;
  return SIGNIN_PERMISSIONS.has(permission) && inSigninWindow();
}

function hardenReaderSession(readerSession, log) {
  readerSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = permissionAllowed(permission);
    if (!allowed) log(`denied permission request: ${permission}`);
    callback(allowed);
  });

  // Covers the synchronous checks a page can make without a prompt. This path
  // used to deny in total silence, which hid the fact that a paywall was asking
  // for storage access on every article and being refused.
  readerSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    const allowed = permissionAllowed(permission);
    if (!allowed) {
      let from = requestingOrigin || '';
      try {
        if (!from && wc) from = wc.getURL();
      } catch {
        from = '';
      }
      log(`denied permission check: ${permission}${from ? ` for ${from}` : ''}`);
    }
    return allowed;
  });

  /**
   * Downloads start with no interaction at all, so a drive-by download would
   * otherwise land on disk unannounced. Defaulting to cancel means the risky
   * answer is never the one you get by dismissing the dialog.
   */
  readerSession.on('will-download', (_event, item) => {
    const name = item.getFilename();
    const from = (() => {
      try {
        return new URL(item.getURL()).hostname;
      } catch {
        return 'an unknown site';
      }
    })();

    // Pause rather than preventDefault: a cancelled download cannot be resumed,
    // so answering "Save file" would do nothing at all.
    item.setSavePath(path.join(app.getPath('downloads'), name));
    item.pause();

    dialog
      .showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancel', 'Save file'],
        defaultId: 0,
        cancelId: 0,
        title: 'Download requested',
        message: `${from} wants to download a file.`,
        detail: `${name}

Newsy blocks downloads unless you allow them. Only continue if you started this one.`,
      })
      .then(({ response }) => {
        if (response === 1) {
          item.resume();
          log(`download allowed: ${name} from ${from}`);
        } else {
          item.cancel();
          log(`download cancelled: ${name} from ${from}`);
        }
      });
  });
}

// --- Subscriptions ----------------------------------------------------------

/**
 * Session presence is reported honestly as "persistent cookies, or none".
 * Probing for a *valid* subscription would mean fetching a paid article and
 * inspecting what came back, which is both fragile and rude to the publisher.
 */
async function sessionStatus(domain) {
  const jar = session.fromPartition(PARTITION).cookies;
  const cookies = await jar.get({ domain });
  const persistent = cookies.filter((c) => c.expirationDate && !c.session);
  return {
    domain,
    cookies: cookies.length,
    signedIn: persistent.length > 0,
    // The soonest expiry is the practical answer to "how long will this last".
    expiresAt: persistent.length
      ? Math.min(...persistent.map((c) => c.expirationDate)) * 1000
      : null,
  };
}

async function clearSession(domain) {
  const jar = session.fromPartition(PARTITION).cookies;
  for (const cookie of await jar.get({ domain })) {
    const host = cookie.domain.replace(/^\./, '');
    await jar.remove(`http${cookie.secure ? 's' : ''}://${host}${cookie.path}`, cookie.name);
  }
  return sessionStatus(domain);
}

// --- Window -----------------------------------------------------------------

/** Shows the dashboard, or the offline card if the service is not up yet. */
async function loadDashboard() {
  if (!win || win.isDestroyed()) return false;
  const alive = await waitForServer();
  await win.loadURL(alive ? ORIGIN : `file://${path.join(DIR, 'offline.html')}`);
  return alive;
}


async function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    show: false,
    // Painted before the first frame arrives; matching the real palette avoids a
    // white flash on launch in dark mode.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f6f7f9',
    title: 'Newsy',
    icon: path.join(DIR, '..', 'public', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on('resize', layoutReader);
  win.on('closed', () => {
    win = null;
    reader = null;
  });

  /**
   * This window carries the preload that exposes `window.newsy`. If it were ever
   * navigated off the Newsy origin — a redirect, a form post, a stray
   * `window.location` — the third-party page would inherit that bridge. Anything
   * external is pushed into the reader instead, which has no preload at all.
   */
  win.webContents.on('will-navigate', (event, target) => {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(target).origin === new URL(ORIGIN).origin;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin) return;
    event.preventDefault();
    if (/^https?:/i.test(target)) openReader(target);
  });

  // The dashboard has no legitimate reason to open a window of its own.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) openReader(target);
    return { action: 'deny' };
  });

  const readerSession = session.fromPartition(PARTITION);
  const firstWindow = !readerSessionReady;
  if (firstWindow) {
    readerSessionReady = true;
    hardenReaderSession(readerSession, (message) => console.log(`[newsy] ${message}`));
  }

  await loadDashboard();
  win.show();

  /**
   * Blocking loads *after* the window is up. A cold build downloads and compiles
   * eleven filter lists, which took ~40s in testing — gating the window on that
   * made the app look dead on first launch. Any article opened before the engine
   * attaches waits for it (see `openReader`), so a slow start delays a page but
   * never leaves one unprotected.
   *
   * Only on the first window: the engine is installed into the session, not the
   * window, and survives the window being closed and reopened.
   */
  if (firstWindow) {
    startBlocking(readerSession, app.getPath('userData'), (message) =>
      console.log(`[newsy] ${message}`),
    ).then((active) => {
      blockingActive = active;
      if (!active) console.log('[newsy] reader is running UNFILTERED');
    });
  }

  if (MANAGED) {
    // A user of the installed app cannot act on "update Electron"; what they can
    // act on is a newer Newsy, which brings a newer Electron with it.
    checkForNewsyUpdate(app.getVersion()).then((release) => {
      if (release) win?.webContents.send('app:update', release);
    });
  } else {
    // Reported, never applied unattended: an Electron major could break the shell.
    checkForUpdate(process.versions.electron).then((version) => {
      if (version) win?.webContents.send('security:update', { current: process.versions.electron, latest: version });
    });
  }

}

// --- Alerts -----------------------------------------------------------------

/**
 * Alerts belong to the *app*, not to the window.
 *
 * This used to run at the end of `createWindow`, and `window-all-closed` tore it
 * down and quit. Closing the window therefore switched Newsy's alerting off for
 * the rest of the session — silently, because the service carried on polling,
 * matching and storing exactly as before, so everything still looked healthy.
 * Web Push covered for it until that was removed on 22 Aug 2026; with the shell
 * now the only path, a notifier that lives and dies with a window is not one.
 *
 * The notifier runs for as long as the process does. The window is a viewer that
 * may or may not be open.
 */
async function startAlerts() {
  if (stopNotifier) return;

  // Before the first alert can fire, or that one still reads "Electron". The
  // installed app needs none of this: its installer writes the shortcut.
  if (!MANAGED) ensureToastIdentity((message) => console.log(`[newsy] ${message}`));

  const headers = await authHeaders();

  // Seed the mute before the stream opens. Without this a shell started while
  // muted would raise one toast for the first burst and only then be told to be
  // quiet, which is exactly the moment a mute has to be trusted.
  try {
    const res = await fetch(`${ORIGIN}/api/state`, { headers, signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      const state = await res.json();
      if (state.alerts) setMuteState(state.alerts);
      if (state.alerts?.muted) console.log('[newsy] starting muted — no notifications will be raised');
    }
  } catch {
    // Unreachable service means no alerts to mute yet; the stream will deliver
    // the state as soon as it connects.
  }

  stopNotifier = startNotifier({
    origin: ORIGIN,
    headers,
    log: (message) => console.log(`[newsy] ${message}`),
    onOpenArticle: async (url) => {
      // A toast can now arrive with no window open — that is the normal resting
      // state — so clicking one has to be able to build the window it needs.
      if (!win || win.isDestroyed()) await createWindow();
      else {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      if (url) openReader(url);
    },
  });
}

// --- Installed app: service and tray ---------------------------------------

let service = null;
let tray = null;

/** Brings up the window from the tray, a toast or a second launch. */
async function showWindow() {
  if (!win || win.isDestroyed()) {
    await createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function quitEverything() {
  console.log('[newsy] quit requested: stopping the service and exiting');
  tray?.destroy();
  stopNotifier?.();
  await service?.stop();
  app.exit(0);
}

async function startManaged() {
  const log = (message) => console.log(`[newsy] ${message}`);
  const home = process.env.NEWSY_HOME || app.getPath('userData');

  service = createService({
    entry: serviceEntry(DIR),
    cwd: path.join(DIR, '..'),
    origin: ORIGIN,
    // HOST pinned to loopback: the installed app is a desktop app, and nothing
    // in a user's environment should be able to widen that by accident.
    env: { NEWSY_HOME: home, PORT, HOST: '127.0.0.1' },
    stderrFile: path.join(home, 'service-errors.log'),
    log,
  });
  await service.start();

  // A test run on a scratch profile must leave no trace on the real desktop: no
  // Run-key entry pointing at a build folder, no second tray icon.
  const testRun = Boolean(process.env.NEWSY_PROFILE);

  const loginItem = createLoginItem();
  // On by default, once. After that the tray checkbox is the user's to change,
  // and turning it off must stay off across upgrades.
  const marker = path.join(home, 'first-run-done');
  if (!testRun && !existsSync(marker)) {
    loginItem.set(true);
    try {
      writeFileSync(marker, new Date().toISOString());
    } catch {
      /* worst case it is set again next launch, which is harmless */
    }
  }

  tray = testRun ? null : createTray({
    iconPath: path.join(DIR, '..', 'public', 'newsy.ico'),
    origin: ORIGIN,
    service,
    openWindow: showWindow,
    quit: quitEverything,
    loginItem,
    log,
  });

  // Wait for the service before alerts and the window ask it anything. Not
  // forever: the window has its own "not answering" card for a slow start.
  await service.waitUntilUp(30_000);
}

// --- Lifecycle --------------------------------------------------------------

app.setName('Newsy');
// Without an explicit AppUserModelID, Windows attributes toasts to the Electron
// executable rather than to Newsy.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

/**
 * `--hidden` brings up the alert notifier with no window. This is how the logon
 * task starts Newsy: alerting from the moment you sign in, without a window
 * arriving uninvited on top of whatever you were doing.
 */
const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Relaunching Newsy is now the ordinary way to get the window back, so a
  // second instance has to be able to *create* one rather than only focus a
  // window that may well not exist.
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    if (MANAGED) await startManaged();
    await startAlerts();
    if (!startHidden) await createWindow();
  });

  ipcMain.handle('app:open-release', (_e, url) => {
    // Only ever the project's own releases page, whatever the renderer passes.
    if (typeof url === 'string' && url.startsWith('https://github.com/rubberdonut67/newsy/releases')) {
      shell.openExternal(url);
    }
  });

  /**
   * Deliberately does nothing — and must stay listening, because the default
   * with no handler is to quit on Windows.
   *
   * Closing the window returns Newsy to watching in the background; it is not a
   * request to stop alerting. Quitting is the tray's Quit, which kills this
   * process directly (`Close-NewsyWindow` in `scripts/newsy-tray.ps1`).
   */
  app.on('window-all-closed', () => {});

  ipcMain.handle('reader:open', (_e, url) => {
    if (typeof url === 'string' && /^https?:/i.test(url)) openReader(url);
  });
  ipcMain.handle('reader:close', closeReader);
  ipcMain.handle('reader:back', () => {
    const history = reader?.webContents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
  });
  ipcMain.handle('reader:reload', () => reader?.webContents.reload());
  ipcMain.handle('reader:external', () => {
    const current = reader?.webContents.getURL();
    // "Open in browser" from the error card must open the article that failed,
    // not the file:// card telling you it failed.
    const url = isStatusPage(current) ? readerTarget : current;
    if (url && /^https?:/i.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('server:retry', loadDashboard);

  ipcMain.handle('dialog:choose-folder', async (_e, startIn) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose where Newsy stores articles',
      // createDirectory lets the user make the folder in the dialog rather than
      // typing a path that does not exist yet.
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof startIn === 'string' && startIn ? startIn : undefined,
    });
    return canceled || !filePaths.length ? '' : filePaths[0];
  });

  /**
   * Opens the pop-up grace period. Called when the user clicks "Sign in", which
   * is the only user action that legitimately needs a pop-up window.
   */
  ipcMain.handle('session:begin-signin', () => {
    // Publisher sign-in is parked for the first release (see PUBLISHER_SIGNIN in
    // public/app.js). Refusing here too means no pop-up or storage-access grace
    // period can be opened, whatever the page asks for.
    if (!PUBLISHER_SIGNIN) return 0;
    signinStartedAt = Date.now();
    return SIGNIN_GRACE_MS;
  });

  // Pulled by the dashboard on boot, so the badge never depends on winning a
  // race against a push sent while the page was still loading.
  // Developer diagnostics only. Blocking is deliberately invisible in normal use.
  ipcMain.handle('security:status', () => ({
    ...blockerStats(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    partition: PARTITION,
    origin: ORIGIN,
  }));

  /** Domains the user has exempted from blocking, from the publishers table. */
  ipcMain.handle('blocking:sync', (_e, domains) => {
    setAllowlist(Array.isArray(domains) ? domains.map(String) : []);
  });

  ipcMain.handle('session:status', (_e, domain) => sessionStatus(String(domain)));
  ipcMain.handle('session:clear', (_e, domain) => clearSession(String(domain)));
}
