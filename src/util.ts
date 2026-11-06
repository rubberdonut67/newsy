/** Query params that identify a campaign rather than a document. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^ga_/i,
  /^mc_/i,
  /^at_(medium|campaign|custom\d?|link_\w+)$/i,
  /^(fbclid|gclid|dclid|msclkid|igshid|twclid|yclid|ttclid)$/i,
  /^(ref|ref_src|referrer|source|src|cmpid|CMP|ito|smid|partner|sh|s_cid|spm)$/i,
  /^(guccounter|guce_referrer|guce_referrer_sig|__twitter_impression|_hsenc|_hsmi)$/i,
  /^(sref|taid|leadSource|ncid|smtyp|guid)$/i,
];

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  ccedil: 'ç',
  '39': "'",
  '160': ' ',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return HTML_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Feed summaries are usually HTML fragments; we only ever show plain text.
 *
 * Every tag becomes a space rather than being deleted. Publishers routinely butt
 * inline elements together — `<span>foo</span><span>bar</span>`, adjacent table
 * cells, link runs — and deleting the tag welds the words into one token. That
 * is not merely ugly: the matcher tests on word boundaries, so `markets` would
 * silently fail to match a summary that had collapsed to `ReutersMarkets`.
 */
export function stripHtml(input: string): string {
  if (!input) return '';
  return decodeEntities(
    input.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    // Re-tighten punctuation that the substitution pushed away from its word,
    // so `<a>link</a>.` reads "link." and not "link .".
    .replace(/ ([,.;:!?%’”)\]}])/g, '$1')
    .replace(/([“‘(\[{¿¡]) /g, '$1')
    .trim();
}

/**
 * Google News wraps every link in a redirector. Older payloads embed the target
 * URL in plain text inside the base64 blob; newer ones are opaque, in which case
 * we keep the redirect URL and lean on title-based de-duplication instead.
 */
export function unwrapGoogleNewsUrl(raw: string): string {
  const match = /^https?:\/\/news\.google\.com\/(?:rss\/)?articles\/([A-Za-z0-9_-]+)/.exec(raw);
  if (!match) return raw;
  try {
    const decoded = Buffer.from(match[1], 'base64url').toString('binary');
    const found = /https?:\/\/[^\s"'<>\\\x00-\x1f]{8,}/.exec(decoded);
    if (!found) return raw;
    const url = found[0].replace(/[^\w\-./:?=&%~+#@]+$/u, '');
    return new URL(url).toString();
  } catch {
    return raw;
  }
}

export function normalizeUrl(raw: string): string {
  const input = unwrapGoogleNewsUrl((raw ?? '').trim());
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return input;

  url.protocol = 'https:';
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

/**
 * Google News renders titles as "Headline - Publisher"; split the two apart.
 *
 * The trailing segment must be capitalized like a masthead. Plenty of real
 * headlines end in a dashed lowercase qualifier — the Guardian's liveblogs all
 * end "– live", others end "– analysis" or "– video" — and those are part of the
 * headline, not a source.
 */
export function splitTitleSource(title: string): { title: string; source: string } {
  const match = /^(.{12,})\s+[-–—]\s+([\p{Lu}\p{N}][^-–—]{1,39})$/u.exec(title.trim());
  if (!match) return { title: title.trim(), source: '' };
  return { title: match[1].trim(), source: match[2].trim() };
}

/**
 * A loose fingerprint of a headline, used to catch the same story arriving from
 * a wire service, an aggregator, and the publisher's own feed.
 */
export function titleKey(title: string): string {
  return splitTitleSource(title)
    .title.normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

/**
 * Reduces a hostname to the registrable domain publishers actually set auth
 * cookies on, so `login.wsj.com` and `www.wsj.com` resolve to one entry.
 *
 * This is a deliberate two-label approximation rather than a Public Suffix List
 * lookup: it is wrong for `co.uk`-style suffixes, which is why the three-label
 * case is kept whenever the second-to-last label is a known compound suffix.
 */
const COMPOUND_SUFFIXES = new Set(['co', 'com', 'net', 'org', 'gov', 'ac']);

export function cookieDomain(input: string): string {
  let host = input.trim().toLowerCase();
  try {
    host = new URL(host.includes('://') ? host : `https://${host}`).hostname;
  } catch {
    return '';
  }
  const labels = host.replace(/^www\./, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const [secondToLast] = labels.slice(-2);
  const keep = COMPOUND_SUFFIXES.has(secondToLast) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function parseDate(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const ts = Date.parse(value.trim());
  if (!Number.isFinite(ts)) return fallback;
  // Feeds occasionally carry timestamps a few minutes in the future; clamp them
  // so a bad clock upstream cannot pin an article to the top of the list forever.
  return Math.min(ts, Date.now() + 60_000);
}

// `relativeTime` lived here and was never called: the server sends timestamps and
// the dashboard formats them itself (`relTime` in public/app.js). Removed 21 Aug
// 2026 rather than keeping two implementations of the same thing, one of them
// dead. If the server ever needs to format a time — a log line, an email — take
// the client's version rather than reinstating a second source of truth.
