import { Menu, Tray, app, shell } from 'electron';
import path from 'node:path';

/**
 * The tray icon of the installed app — the Electron counterpart of
 * `scripts/newsy-tray.ps1`, which the run-from-source setup still uses.
 *
 * Same menu, same rules, so the two never teach a user different things:
 * the tooltip says "alerts off" only when alerting is actually broken (no
 * listener), a mute says "muted" instead, and an error the user caused by
 * clicking something is reported even while tray messages are muted.
 *
 * It lives in the main process because the installed app has no PowerShell
 * scripts to run, and because a tray owned by Newsy.exe is attributed to
 * "Newsy" by Windows, where the script's icon belonged to powershell.exe.
 */
export function createTray({
  iconPath,
  origin,
  headers = {},
  service,
  openWindow,
  quit,
  loginItem,
  log,
}) {
  const tray = new Tray(iconPath);
  tray.setToolTip('Newsy');

  let state = null;

  async function api(route, init = {}) {
    const res = await fetch(`${origin}${route}`, {
      ...init,
      headers: { ...headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(init.timeoutMs ?? 5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  const mute = () => state?.alerts ?? { muted: false, mutedUntil: null, scope: 'toasts' };

  /** Re-checked against the clock: a mute must never outlive its deadline. */
  function muted() {
    const m = mute();
    if (!m.muted) return false;
    return m.mutedUntil === null || Date.now() < m.mutedUntil;
  }

  function balloon(content, { force = false, warn = false } = {}) {
    if (!force && muted() && mute().scope === 'all') {
      log(`tray message suppressed while muted: ${content}`);
      return;
    }
    tray.displayBalloon({ title: 'Newsy', content, iconType: warn ? 'warning' : 'info' });
  }

  async function setMute(on, minutes = 0) {
    try {
      const body = { muted: on, ...(on && minutes > 0 ? { minutes } : {}) };
      const alerts = await api('/api/alerts', {
        method: 'PATCH',
        body: JSON.stringify(body),
        timeoutMs: 10_000,
      });
      state = { ...(state ?? {}), alerts };
      render();
    } catch (err) {
      balloon(`Could not change alerts: ${err.message}`, { force: true, warn: true });
    }
  }

  async function refreshNow() {
    try {
      await api('/api/refresh', { method: 'POST', body: '{}', timeoutMs: 120_000 });
      balloon('Finished checking every source.');
    } catch (err) {
      balloon(`Could not refresh: ${err.message}`, { force: true, warn: true });
    }
  }

  async function openLog() {
    try {
      const where = await api('/api/data-location');
      const err = await shell.openPath(path.join(where.current, 'newsy.log'));
      if (err) balloon(`Could not open the log: ${err}`, { force: true, warn: true });
    } catch {
      balloon('The log is only reachable while the service is running.', { force: true });
    }
  }

  function statusLine() {
    if (!state) return 'Not running';
    const listeners = Number(state.poller?.streams ?? 0);
    const alerts = muted() ? 'muted' : listeners > 0 ? 'alerts on' : 'ALERTS OFF';
    return `${state.stats.unread} unread | ${alerts} | ${state.stats.activeFeeds}/${state.stats.feeds} sources`;
  }

  function tooltip() {
    if (!state) return 'Newsy - not running';
    if (muted()) {
      const until = mute().mutedUntil;
      return `Newsy - muted${until ? ` until ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`;
    }
    if (Number(state.poller?.streams ?? 0) <= 0) return 'Newsy - alerts off';
    return state.stats.unread > 0 ? `Newsy - ${state.stats.unread} unread` : 'Newsy - up to date';
  }

  function buildMenu() {
    const up = Boolean(state);
    const isMuted = muted();
    return Menu.buildFromTemplate([
      { label: statusLine(), enabled: false },
      { type: 'separator' },
      { label: 'Open Newsy', click: openWindow },
      { label: 'Check for news now', enabled: up, click: refreshNow },
      {
        label: isMuted ? 'Muted — turn alerts back on' : 'Mute alerts',
        type: 'checkbox',
        checked: isMuted,
        enabled: up,
        click: () => setMute(!isMuted),
      },
      {
        label: 'Mute alerts for',
        enabled: up,
        submenu: [
          { label: '30 minutes', click: () => setMute(true, 30) },
          { label: '2 hours', click: () => setMute(true, 120) },
          { label: '8 hours', click: () => setMute(true, 480) },
        ],
      },
      { type: 'separator' },
      {
        label: 'Start Newsy when I sign in',
        type: 'checkbox',
        checked: loginItem.enabled(),
        click: (item) => loginItem.set(item.checked),
      },
      {
        label: 'Start background service',
        enabled: !up,
        click: async () => {
          await service.start();
          await service.waitUntilUp(15_000);
          await update();
        },
      },
      {
        label: 'Stop background service',
        enabled: up,
        click: async () => {
          await service.stop();
          state = null;
          render();
          balloon('Background service stopped. Alerts are off.');
        },
      },
      { label: 'View log', click: openLog },
      { type: 'separator' },
      { label: 'Quit Newsy (stop everything)', click: quit },
    ]);
  }

  function render() {
    if (tray.isDestroyed()) return;
    tray.setToolTip(tooltip());
  }

  async function update() {
    try {
      state = await api('/api/state');
    } catch {
      state = null;
    }
    render();
  }

  tray.on('click', openWindow);
  // Fetch fresh numbers whenever the menu is about to be used, so it never shows
  // a stale count; the 30-second timer keeps the tooltip honest in between.
  tray.on('mouse-enter', update);
  // Built on demand rather than with setContextMenu: a menu attached up front
  // shows whatever it held at the last 30-second tick.
  tray.on('right-click', async () => {
    await update();
    if (!tray.isDestroyed()) tray.popUpContextMenu(buildMenu());
  });

  render();
  update();
  const timer = setInterval(update, 30_000);

  return {
    update,
    destroy() {
      clearInterval(timer);
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}

/**
 * "Start Newsy when I sign in", via Windows' own Run key rather than a scheduled
 * task: a per-user installer cannot rely on Task Scheduler permissions, and the
 * Run key is what users expect to find in Task Manager's Startup tab.
 */
export function createLoginItem() {
  const opts = { args: ['--hidden'], name: 'Newsy' };
  return {
    enabled: () => app.getLoginItemSettings(opts).openAtLogin,
    set: (on) => app.setLoginItemSettings({ ...opts, openAtLogin: on }),
  };
}
