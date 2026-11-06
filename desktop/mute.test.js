import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNMUTED, coerceMute, muteActive } from './mute.js';

test('nothing is muted by default', () => {
  assert.equal(muteActive(UNMUTED), false);
});

test('an indefinite mute stays muted', () => {
  const state = { muted: true, mutedUntil: null, scope: 'toasts' };
  assert.equal(muteActive(state, 0), true);
  assert.equal(muteActive(state, 8.64e15), true);
});

test('a timed mute lapses on its own, without being told', () => {
  const state = { muted: true, mutedUntil: 1_000_000, scope: 'toasts' };
  assert.equal(muteActive(state, 999_999), true);
  // Load-bearing: the `alerts` broadcast announcing the expiry may never arrive
  // if the stream dropped. Alerts must come back anyway, at the chosen moment.
  assert.equal(muteActive(state, 1_000_000), false);
  assert.equal(muteActive(state, 1_000_001), false);
});

test('a missing or malformed state never mutes', () => {
  assert.equal(muteActive(null), false);
  assert.equal(muteActive(undefined), false);
  assert.equal(muteActive({}), false);
  assert.equal(coerceMute(null), null);
  assert.equal(coerceMute('muted'), null);
  assert.equal(coerceMute({ mutedUntil: 5 }), null, 'no boolean `muted` is not a state');
});

test('coerceMute normalizes what the stream delivers', () => {
  assert.deepEqual(coerceMute({ muted: true, mutedUntil: 5, scope: 'all' }), {
    muted: true,
    mutedUntil: 5,
    scope: 'all',
  });
  // An unknown scope falls back to the narrower one: silencing more than asked
  // is the worse direction to fail in.
  assert.deepEqual(coerceMute({ muted: false, mutedUntil: null, scope: 'everything' }), {
    muted: false,
    mutedUntil: null,
    scope: 'toasts',
  });
});
