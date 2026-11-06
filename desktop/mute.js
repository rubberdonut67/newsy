/**
 * The global alert mute, as the shell sees it.
 *
 * Its own module for the same reason `grace.js` is: the decision is pure, and
 * `notifier.js` cannot be imported outside Electron, so the one rule that
 * decides whether a Windows notification is raised would otherwise be the one
 * rule with no test.
 */

/** @typedef {{ muted: boolean, mutedUntil: number|null, scope: 'toasts'|'all' }} MuteState */

/** @type {MuteState} */
export const UNMUTED = { muted: false, mutedUntil: null, scope: 'toasts' };

/**
 * The deadline is re-checked on every frame rather than trusted from whenever
 * the last `alerts` broadcast happened to arrive. A dropped stream or a service
 * restart must not be able to leave the shell muted past the moment the user
 * chose, because an alerting app that stays quiet longer than it was told to is
 * indistinguishable from a broken one.
 */
export function muteActive(state, now = Date.now()) {
  if (!state?.muted) return false;
  return state.mutedUntil === null || state.mutedUntil === undefined || now < state.mutedUntil;
}

/** Ignores anything that is not a state object, so a malformed frame cannot mute. */
export function coerceMute(data) {
  if (!data || typeof data !== 'object' || typeof data.muted !== 'boolean') return null;
  return {
    muted: data.muted,
    mutedUntil: typeof data.mutedUntil === 'number' ? data.mutedUntil : null,
    scope: data.scope === 'all' ? 'all' : 'toasts',
  };
}
