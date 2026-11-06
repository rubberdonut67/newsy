import { XMLParser } from 'fast-xml-parser';
import { hostOf, parseDate, splitTitleSource, stripHtml } from '../util.ts';

export type FeedItem = {
  title: string;
  link: string;
  summary: string;
  author: string;
  source: string;
  imageUrl: string;
  publishedAt: number;
};

export type ParsedFeed = {
  title: string;
  items: FeedItem[];
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // Leave values as strings: GUIDs like `1234567890` must not become numbers,
  // and dates are parsed deliberately downstream.
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
});

type Node = Record<string, unknown>;

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Reads an element's text whether it arrived bare or as `{ '#text': … }`. */
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === 'object') return text((value as Node)['#text']);
  return '';
}

function attr(value: unknown, name: string): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return attr(value[0], name);
  const raw = (value as Node)[`@_${name}`];
  return raw === undefined || raw === null ? '' : String(raw);
}

function first(node: Node, ...keys: string[]): unknown {
  for (const key of keys) {
    if (node[key] !== undefined && node[key] !== null && node[key] !== '') return node[key];
  }
  return undefined;
}

/** Atom feeds carry several `<link>` elements; the readable page is `rel=alternate`. */
function atomLink(node: Node): string {
  const links = toArray(node.link);
  const alternate = links.find((l) => {
    const rel = attr(l, 'rel');
    return rel === '' || rel === 'alternate';
  });
  const chosen = alternate ?? links[0];
  return attr(chosen, 'href') || text(chosen);
}

function imageFrom(node: Node): string {
  const candidates = [
    ...toArray(node['media:content']),
    ...toArray(node['media:thumbnail']),
    ...toArray(node.enclosure),
  ];
  for (const candidate of candidates) {
    const type = attr(candidate, 'type');
    const url = attr(candidate, 'url');
    if (url && (!type || type.startsWith('image/'))) return url;
  }
  const html = text(first(node, 'content:encoded', 'description') ?? '');
  const img = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return img ? img[1] : '';
}

/**
 * Compare the parsed hostname, not a substring of the URL — in a full link the
 * host is preceded by `//`, so a pattern anchored on `^` or `.` never matches.
 */
export function isAggregatorLink(link: string): boolean {
  return hostOf(link) === 'news.google.com';
}

const shape = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Aggregators (Google News especially) fill `<description>` with nothing but the
 * headline and the publisher name. Repeating that under the title in the UI is
 * noise, so a summary that merely restates the title is discarded.
 */
function summaryFor(title: string, body: string): string {
  const summary = stripHtml(body).slice(0, 1200);
  if (!summary) return '';
  const flatSummary = shape(summary);
  const flatTitle = shape(title);
  if (!flatTitle) return summary;
  if (flatSummary.startsWith(flatTitle) && flatSummary.length < flatTitle.length * 1.5) return '';
  return summary;
}

function buildItem(node: Node, feedTitle: string, isAtom: boolean): FeedItem | null {
  const rawTitle = stripHtml(text(first(node, 'title') ?? ''));
  const link = (isAtom ? atomLink(node) : text(first(node, 'link', 'guid') ?? '')).trim();
  if (!rawTitle && !link) return null;

  const body = text(
    first(node, 'content:encoded', 'description', 'summary', 'content', 'subtitle') ?? '',
  );
  const publishedAt = parseDate(
    text(first(node, 'pubDate', 'published', 'updated', 'dc:date', 'date') ?? ''),
  );

  const authorNode = first(node, 'dc:creator', 'author', 'creator');
  const author = stripHtml(
    typeof authorNode === 'object' && authorNode !== null && !Array.isArray(authorNode)
      ? text((authorNode as Node).name ?? authorNode)
      : text(authorNode),
  );

  // Only aggregator headlines carry a "— Publisher" suffix. A publisher's own
  // feed states its headline verbatim, so splitting there would truncate it.
  const split = isAggregatorLink(link)
    ? splitTitleSource(rawTitle)
    : { title: rawTitle, source: '' };
  const declaredSource = stripHtml(text(first(node, 'source') ?? ''));
  const title = split.title || rawTitle;

  return {
    title,
    link,
    summary: summaryFor(title, body),
    author: author.slice(0, 120),
    source: (declaredSource || split.source || feedTitle || hostOf(link)).slice(0, 80),
    imageUrl: imageFrom(node),
    publishedAt,
  };
}

/** Parses RSS 2.0, RDF/RSS 1.0 and Atom into one normalized shape. */
export function parseFeed(xml: string): ParsedFeed {
  const doc = parser.parse(xml) as Node;

  const rss = doc.rss as Node | undefined;
  const channel = (rss?.channel ?? doc.channel) as Node | undefined;
  const rdf = (doc['rdf:RDF'] ?? doc.RDF) as Node | undefined;
  const atom = (doc.feed ?? doc['atom:feed']) as Node | undefined;

  if (channel) {
    const title = stripHtml(text(channel.title));
    const items = toArray(channel.item).concat(toArray(rdf?.item));
    return { title, items: collect(items, title, false) };
  }
  if (rdf) {
    const rdfChannel = rdf.channel as Node | undefined;
    const title = stripHtml(text(rdfChannel?.title));
    return { title, items: collect(toArray(rdf.item), title, false) };
  }
  if (atom) {
    const title = stripHtml(text(atom.title));
    return { title, items: collect(toArray(atom.entry), title, true) };
  }
  throw new Error('Unrecognized feed format (no rss/rdf/atom root element)');
}

function collect(nodes: unknown[], feedTitle: string, isAtom: boolean): FeedItem[] {
  const items: FeedItem[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const item = buildItem(node as Node, feedTitle, isAtom);
    if (item) items.push(item);
  }
  return items;
}
