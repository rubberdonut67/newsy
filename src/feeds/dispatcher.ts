import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { config } from '../config.ts';

/**
 * Node's global `fetch` runs on a bundled undici Agent whose connect timeout is
 * hard-coded to 10 s — and that window includes DNS resolution. On a slow
 * resolver (a VPN that fell back to a slower protocol took ~11 s per uncached
 * name) every feed died
 * with UND_ERR_CONNECT_TIMEOUT before `httpTimeoutMs` ever applied. Node does not
 * expose its bundled Agent, so we build our own from the `undici` package and hand
 * it to each fetch as `dispatcher`; the AbortController in fetch.ts stays the
 * overall cap.
 *
 * The Agent must be used with the `fetch` exported by the same `undici` package,
 * never with Node's global one: Node 24 bundles undici 7, whose fetch speaks the
 * old handler protocol, and an undici 8 Agent rejects it with
 * "UND_ERR_INVALID_ARG: invalid onRequestStart method". For the same reason do
 * not call `setGlobalDispatcher` — the global slot is shared with Node's bundled
 * copy, so every other global fetch in the process would break.
 */
export function createFeedDispatcher(options: {
  connectTimeoutMs: number;
  /** Tests inject a slow resolver here; production uses the system one. */
  lookup?: LookupFunction;
}): Agent {
  return new Agent({
    connect: {
      timeout: options.connectTimeoutMs,
      ...(options.lookup ? { lookup: options.lookup } : {}),
    },
  });
}

export const feedDispatcher = createFeedDispatcher({ connectTimeoutMs: config.httpTimeoutMs });
