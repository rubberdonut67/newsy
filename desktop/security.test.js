import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIGNIN_GRACE_MS, signinWindowOpen } from './grace.js';
import { isOlder } from './update-check.js';

test('pop-ups are blocked until a sign-in is started', () => {
  assert.equal(signinWindowOpen(1_000_000, 0), false);
});

test('pop-ups are permitted inside the grace period', () => {
  const started = 1_000_000;
  assert.equal(signinWindowOpen(started, started), true);
  assert.equal(signinWindowOpen(started + 179_000, started), true);
});

test('the grace period expires, it does not stay open', () => {
  const started = 1_000_000;
  assert.equal(signinWindowOpen(started + SIGNIN_GRACE_MS, started), false);
  assert.equal(signinWindowOpen(started + 600_000, started), false);
});

test('isOlder compares dotted versions numerically, not lexically', () => {
  assert.equal(isOlder('43.4.1', '43.4.2'), true);
  assert.equal(isOlder('43.4.1', '44.0.0'), true);
  // Lexical comparison would wrongly call 9 newer than 10.
  assert.equal(isOlder('9.0.0', '10.0.0'), true);
  assert.equal(isOlder('43.10.0', '43.9.0'), false);
});

test('isOlder treats equal and newer versions as up to date', () => {
  assert.equal(isOlder('43.4.1', '43.4.1'), false);
  assert.equal(isOlder('44.0.0', '43.4.1'), false);
});

test('isOlder ignores prerelease suffixes', () => {
  assert.equal(isOlder('44.0.0-beta.1', '44.0.0'), false);
  assert.equal(isOlder('43.0.0-beta.1', '44.0.0'), true);
});

test('the grace override can only shorten the window, never widen it', async () => {
  const load = async (value) => {
    process.env.NEWSY_SIGNIN_GRACE_MS = value;
    // A fresh query string defeats the ESM module cache between cases.
    return import(`./grace.js?case=${encodeURIComponent(value)}`);
  };

  assert.equal((await load('5000')).SIGNIN_GRACE_MS, 5_000);
  // Anything longer than the default, negative or junk falls back to 3 minutes.
  assert.equal((await load('999999999')).SIGNIN_GRACE_MS, 180_000);
  assert.equal((await load('-1')).SIGNIN_GRACE_MS, 180_000);
  assert.equal((await load('nonsense')).SIGNIN_GRACE_MS, 180_000);
  delete process.env.NEWSY_SIGNIN_GRACE_MS;
});
