import { config } from '../config.ts';
import { fetch } from 'undici';
import { feedDispatcher } from './dispatcher.ts';

export type FetchResult =
  | { status: 'ok'; body: string; etag: string | null; lastModified: string | null }
  | { status: 'not-modified' }
  | { status: 'error'; message: string; retryAfterSec?: number };

/**
 * `fetch` reports every transport problem as the same opaque "fetch failed";
 * the actionable detail (ENOTFOUND, ECONNRESET, certificate errors) is hidden on
 * `cause`. Unwrap it so the Sources tab shows why a feed is unhappy.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'AbortError') return `timed out after ${config.httpTimeoutMs}ms`;

  const parts: string[] = [];
  for (let current: unknown = err; current instanceof Error; current = current.cause) {
    const code = (current as { code?: string }).code;
    const text = code ? `${code}: ${current.message}` : current.message;
    if (!parts.includes(text)) parts.push(text);
  }
  return parts.slice(-2).join(' — ') || 'unknown error';
}

/**
 * Connection-level hiccups are worth another attempt; HTTP status errors are not.
 * `UND_ERR_*` are undici's own codes — a burst of concurrent fetches can still
 * trip the connect timeout on hosts that answer fine a second later.
 */
export function isTransient(message: string): boolean {
  return /UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET|RESPONSE_STATUS)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|ERR_SSL|socket|terminated|Timeout Error|timed out|other side closed/i.test(
    message,
  );
}

/**
 * Conditional GET with an explicit timeout. Honouring ETag / Last-Modified keeps
 * us polite enough to poll popular feeds every few minutes without being blocked.
 */
export async function fetchFeed(
  url: string,
  etag?: string | null,
  lastModified?: string | null,
): Promise<FetchResult> {
  const backoffMs = [1_500, 4_000];
  let result = await attempt(url, etag, lastModified);

  for (const delay of backoffMs) {
    if (result.status !== 'error' || !isTransient(result.message)) return result;
    // Jitter keeps a batch of feeds that failed together from retrying in lockstep.
    await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 750));
    result = await attempt(url, etag, lastModified);
  }
  return result;
}

async function attempt(
  url: string,
  etag?: string | null,
  lastModified?: string | null,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);

  try {
    const headers: Record<string, string> = {
      'user-agent': config.userAgent,
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
      'accept-encoding': 'gzip, deflate, br',
    };
    if (etag) headers['if-none-match'] = etag;
    if (lastModified) headers['if-modified-since'] = lastModified;

    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
      dispatcher: feedDispatcher,
    });

    if (res.status === 304) return { status: 'not-modified' };

    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      return {
        status: 'error',
        message: `HTTP ${res.status} ${res.statusText}`.trim(),
        retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      };
    }

    const body = await res.text();
    if (!body.trim()) return { status: 'error', message: 'Empty response body' };

    return {
      status: 'ok',
      body,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    };
  } catch (err) {
    return { status: 'error', message: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}
