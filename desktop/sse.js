/**
 * A minimal server-sent-events client for the Electron main process.
 *
 * Node ships an `EventSource` global, but its availability moves with the Node
 * version Electron happens to bundle, and it cannot send a Cookie header — which
 * Newsy needs whenever NEWSY_PASSWORD is set. Parsing the wire format by hand is
 * about thirty lines and avoids depending on either.
 */

/** Splits an SSE frame into its event name and joined data lines. */
function parseFrame(frame) {
  let event = 'message';
  const data = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // heartbeat comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length === 0 ? null : { event, data: data.join('\n') };
}

/**
 * Streams `url` until `signal` aborts, reconnecting with backoff. `onEvent` is
 * called with already-parsed JSON; frames that fail to parse are skipped rather
 * than tearing down a working stream.
 */
export async function connectSSE(url, { headers = {}, signal, onEvent, onStatus = () => {} }) {
  let backoffMs = 1_000;

  while (!signal.aborted) {
    try {
      const res = await fetch(url, {
        headers: { ...headers, accept: 'text/event-stream' },
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream returned HTTP ${res.status}`);

      onStatus('connected');
      backoffMs = 1_000; // a successful connect resets the penalty

      let buffer = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        // Frames are separated by a blank line; the tail may be incomplete.
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = parseFrame(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
          if (!frame) continue;
          try {
            onEvent(frame.event, JSON.parse(frame.data));
          } catch {
            /* a malformed frame is not worth dropping the connection over */
          }
        }
      }
      throw new Error('stream closed by server');
    } catch (err) {
      if (signal.aborted) return;
      onStatus('disconnected', err);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }
}
