const { contextBridge, ipcRenderer } = require('electron');

/**
 * The dashboard's only door into the shell. Everything is an explicit,
 * named call — the renderer gets no `ipcRenderer`, no `require`, and no way to
 * reach a channel that is not listed here.
 *
 * `window.newsy` existing is also the signal the dashboard uses to decide
 * whether it is running in the desktop shell or in a plain browser tab, so the
 * same `public/` assets keep working unchanged in both.
 */
/** Wraps an ipcRenderer listener so callers get an unsubscribe, never the event. */
function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

contextBridge.exposeInMainWorld('newsy', {
  desktop: true,

  reader: {
    open: (url) => ipcRenderer.invoke('reader:open', url),
    close: () => ipcRenderer.invoke('reader:close'),
    back: () => ipcRenderer.invoke('reader:back'),
    reload: () => ipcRenderer.invoke('reader:reload'),
    openExternal: () => ipcRenderer.invoke('reader:external'),
    /** Returns an unsubscribe function, so a re-render cannot stack listeners. */
    onState: (handler) => subscribe('reader:state', handler),
  },

  /** Re-probes the Newsy service; resolves true once the dashboard has loaded. */
  retry: () => ipcRenderer.invoke('server:retry'),

  /**
   * Native folder picker for the Developer tab's storage location. Resolves to
   * the chosen path, or '' if the dialog was dismissed. A browser cannot ask for
   * a filesystem path, so this only exists in the shell.
   */
  chooseFolder: (startIn) => ipcRenderer.invoke('dialog:choose-folder', startIn),

  sessions: {
    status: (domain) => ipcRenderer.invoke('session:status', domain),
    clear: (domain) => ipcRenderer.invoke('session:clear', domain),
    /** Opens the pop-up grace period; call only from an explicit "Sign in" click. */
    beginSignin: () => ipcRenderer.invoke('session:begin-signin'),
  },

  security: {
    status: () => ipcRenderer.invoke('security:status'),
    /** Domains exempted from blocking, mirrored from the publishers table. */
    syncAllowlist: (domains) => ipcRenderer.invoke('blocking:sync', domains),
    onPopupBlocked: (handler) => subscribe('reader:popup-blocked', handler),
    onUpdateAvailable: (handler) => subscribe('security:update', handler),
  },

  /** Installed app only: a newer Newsy release exists. */
  updates: {
    onAvailable: (handler) => subscribe('app:update', handler),
    openRelease: (url) => ipcRenderer.invoke('app:open-release', url),
  },
});
