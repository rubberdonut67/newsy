/**
 * The pop-up grace period.
 *
 * Publishers run "sign in with…" through pop-up windows, so blocking them
 * outright breaks sign-in; allowing them permanently is what filled the screen
 * with ad windows. Tying the exception to an explicit user action and expiring
 * it keeps both working.
 *
 * Kept in its own module so it can be tested without importing `main.js`, which
 * would pull in the whole Electron binary.
 */
const DEFAULT_GRACE_MS = 3 * 60_000;

/**
 * Overridable so the expiry can be exercised in seconds rather than minutes.
 * Shortening it only ever tightens the policy, so a stray value in the
 * environment cannot widen the window pop-ups are allowed through.
 */
const override = Number(process.env.NEWSY_SIGNIN_GRACE_MS);
export const SIGNIN_GRACE_MS =
  Number.isFinite(override) && override > 0 && override < DEFAULT_GRACE_MS
    ? override
    : DEFAULT_GRACE_MS;

export function signinWindowOpen(now, startedAt) {
  return startedAt > 0 && now - startedAt < SIGNIN_GRACE_MS;
}
