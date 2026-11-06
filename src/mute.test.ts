import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// DATA_DIR has to be set before store.ts pulls in config.ts and db.ts, which
// open the database at import time. A static import would run first and aim
// this file at the live newsy.db.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'newsy-mute-'));
const { alertMute, expireAlertMute, setAlertMute } = await import('./store.ts');

const MINUTE = 60_000;

test('alerts start unmuted', () => {
  assert.deepEqual(alertMute(), { muted: false, mutedUntil: null, scope: 'toasts' });
});

test('an indefinite mute has no deadline', () => {
  const state = setAlertMute({ muted: true });
  assert.equal(state.muted, true);
  assert.equal(state.mutedUntil, null);
});

test('unmuting clears the mute but keeps the scope choice', () => {
  setAlertMute({ muted: true, scope: 'all' });
  const state = setAlertMute({ muted: false });
  assert.equal(state.muted, false);
  assert.equal(state.scope, 'all', 'the scope is a preference, not part of the mute');
  setAlertMute({ scope: 'toasts' });
});

test('a timed mute reports itself lapsed the moment the deadline passes', () => {
  const now = Date.now();
  setAlertMute({ muted: true, minutes: 30 }, now);

  assert.equal(alertMute(now + 29 * MINUTE).muted, true);
  // Reading is pure, so every process sees the lapse at the same instant rather
  // than whenever someone happens to sweep.
  assert.equal(alertMute(now + 31 * MINUTE).muted, false);
  setAlertMute({ muted: false });
});

test('expiry clears the row once, and only once', () => {
  const now = Date.now();
  setAlertMute({ muted: true, minutes: 30 }, now);

  assert.equal(expireAlertMute(now + 29 * MINUTE), null, 'still inside the window');

  const cleared = expireAlertMute(now + 31 * MINUTE);
  assert.equal(cleared?.muted, false);
  // The second sweep must return null, or the poller would announce the same
  // expiry on every tick for the rest of the day.
  assert.equal(expireAlertMute(now + 32 * MINUTE), null);
});

test('an indefinite mute never expires on its own', () => {
  setAlertMute({ muted: true });
  assert.equal(expireAlertMute(Date.now() + 365 * 24 * 60 * MINUTE), null);
  assert.equal(alertMute(Date.now() + 365 * 24 * 60 * MINUTE).muted, true);
  setAlertMute({ muted: false });
});

test('a zero or missing duration means "until switched back on"', () => {
  assert.equal(setAlertMute({ muted: true, minutes: 0 }).mutedUntil, null);
  assert.equal(setAlertMute({ muted: true, minutes: null }).mutedUntil, null);
  setAlertMute({ muted: false });
});

test('the scope can be changed without touching the mute', () => {
  setAlertMute({ muted: true, minutes: 30 });
  const before = alertMute().mutedUntil;
  const after = setAlertMute({ scope: 'all' });
  assert.equal(after.scope, 'all');
  assert.equal(after.mutedUntil, before, 'changing scope must not restart the clock');
  setAlertMute({ muted: false, scope: 'toasts' });
});
