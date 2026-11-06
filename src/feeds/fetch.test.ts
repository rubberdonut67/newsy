import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { test } from 'node:test';
import { fetch } from 'undici';
import { createFeedDispatcher } from './dispatcher.ts';

/**
 * A resolver that always answers "loopback", but only after `delayMs`. It plays
 * the part of a VPN whose DNS takes longer than undici's stock 10 s connect
 * window, scaled down so the test finishes in a few seconds.
 */
function slowLookup(delayMs: number): { lookup: LookupFunction; cancel: () => void } {
  const timers = new Set<NodeJS.Timeout>();
  const lookup = ((hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    }, delayMs);
    timers.add(timer);
  }) as unknown as LookupFunction;
  return { lookup, cancel: () => timers.forEach(clearTimeout) };
}

function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  for (let current: unknown = err; current instanceof Error; current = current.cause) {
    const code = (current as { code?: string }).code;
    if (code) codes.push(code);
  }
  return codes;
}

test('the connect timeout covers DNS resolution and follows the configured value', async (t) => {
  const server = createServer((_req, res) => res.end('<rss/>'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  // A hostname (not an IP) forces net.connect through our lookup; nothing touches real DNS.
  const url = `http://newsy-connect-test.invalid:${(server.address() as AddressInfo).port}/feed`;

  // undici's connect timer has ~1 s resolution, so keep a wide gap between the
  // configured timeout and the resolver delay rather than asserting exact timing.
  const stalled = slowLookup(6_000);
  t.after(stalled.cancel);
  const tight = createFeedDispatcher({ connectTimeoutMs: 100, lookup: stalled.lookup });
  t.after(() => tight.close());
  const started = Date.now();
  await assert.rejects(fetch(url, { dispatcher: tight }), (err: unknown) => {
    assert.ok(
      errorCodes(err).includes('UND_ERR_CONNECT_TIMEOUT'),
      `expected UND_ERR_CONNECT_TIMEOUT, got ${errorCodes(err).join(',') || String(err)}`,
    );
    return true;
  });
  assert.ok(Date.now() - started < 4_000, 'should give up long before the slow resolver answers');

  const slow = slowLookup(300);
  t.after(slow.cancel);
  const roomy = createFeedDispatcher({ connectTimeoutMs: 5_000, lookup: slow.lookup });
  t.after(() => roomy.close());
  const res = await fetch(url, { dispatcher: roomy });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<rss/>');
});
