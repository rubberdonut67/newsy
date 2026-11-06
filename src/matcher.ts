/**
 * A deliberately small query language for topics.
 *
 *   tesla model y            → all terms must appear (AND)
 *   "supply chain" tariffs   → quoted text matches as a phrase
 *   openai OR anthropic      → OR (or `|`) joins alternatives into one group
 *   climate -opinion         → a leading `-` excludes
 *   quantum comput*          → trailing `*` matches any word continuation
 *
 * Precedence: OR binds tighter than the implicit AND, so
 * `ai chips nvidia OR amd` means `ai AND chips AND (nvidia OR amd)`.
 */

export type Term = {
  kind: 'word' | 'phrase';
  text: string;
  /** Set when the term ended in `*`, meaning "match this as a prefix". */
  prefix: boolean;
};

export type ParsedQuery = {
  /** Every group must be satisfied; a group is satisfied by any one of its terms. */
  groups: Term[][];
  excludes: Term[];
};

export class QueryError extends Error {}

type RawToken =
  | { type: 'term'; term: Term; negated: boolean }
  | { type: 'or' };

function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '|') {
      tokens.push({ type: 'or' });
      i++;
      continue;
    }

    let negated = false;
    if ((ch === '-' || ch === '!') && i + 1 < input.length && !/\s/.test(input[i + 1])) {
      negated = true;
      i++;
    }

    if (input[i] === '"' || input[i] === '“') {
      const close = findClosingQuote(input, i + 1);
      if (close === -1) throw new QueryError('Unclosed quote in query');
      const text = input.slice(i + 1, close).trim();
      i = close + 1;
      if (text) tokens.push({ type: 'term', term: makeTerm('phrase', text), negated });
      continue;
    }

    let j = i;
    while (j < input.length && !/[\s|"]/.test(input[j])) j++;
    const word = input.slice(i, j);
    i = j;

    if (!negated && (word.toUpperCase() === 'OR' || word.toUpperCase() === 'AND')) {
      if (word.toUpperCase() === 'OR') tokens.push({ type: 'or' });
      continue;
    }
    if (word) tokens.push({ type: 'term', term: makeTerm('word', word), negated });
  }

  return tokens;
}

function findClosingQuote(input: string, from: number): number {
  for (let i = from; i < input.length; i++) {
    if (input[i] === '"' || input[i] === '”') return i;
  }
  return -1;
}

function makeTerm(kind: 'word' | 'phrase', raw: string): Term {
  const prefix = raw.endsWith('*');
  const text = (prefix ? raw.slice(0, -1) : raw).trim();
  return { kind, text, prefix };
}

export function parseQuery(input: string): ParsedQuery {
  const tokens = tokenize(input ?? '');
  const groups: Term[][] = [];
  const excludes: Term[] = [];
  let pendingOr = false;

  for (const token of tokens) {
    if (token.type === 'or') {
      // An `OR` with nothing before it is meaningless; ignore rather than fail.
      pendingOr = groups.length > 0;
      continue;
    }
    if (!token.term.text) continue;

    if (token.negated) {
      excludes.push(token.term);
      pendingOr = false;
      continue;
    }
    if (pendingOr) {
      groups[groups.length - 1].push(token.term);
      pendingOr = false;
    } else {
      groups.push([token.term]);
    }
  }

  if (groups.length === 0) {
    throw new QueryError('A topic needs at least one term to match on');
  }
  return { groups, excludes };
}

// --- Matching ---------------------------------------------------------------

const regexCache = new Map<string, RegExp>();

/**
 * Word-boundary-ish matching that survives terms containing punctuation
 * (`covid-19`, `c++`, `f-35`), which plain `\b` mishandles.
 */
function termRegex(term: Term): RegExp {
  const key = `${term.kind}:${term.prefix ? '1' : '0'}:${term.text}`;
  const cached = regexCache.get(key);
  if (cached) return cached;

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body =
    term.kind === 'phrase'
      ? term.text.trim().split(/\s+/).map(escape).join('[\\s\\-‐-―_/]+')
      : escape(term.text);

  const lead = '(?<![\\p{L}\\p{N}])';
  const tail = term.prefix ? '[\\p{L}\\p{N}]*' : '(?![\\p{L}\\p{N}])';
  const re = new RegExp(`${lead}${body}${tail}`, 'iu');
  regexCache.set(key, re);
  return re;
}

export type CompiledQuery = {
  parsed: ParsedQuery;
  /** Returns the terms that fired, or `null` when the text does not match. */
  match(text: string): string[] | null;
};

export function compileQuery(input: string): CompiledQuery {
  const parsed = parseQuery(input);

  return {
    parsed,
    match(text: string): string[] | null {
      if (!text) return null;
      for (const term of parsed.excludes) {
        if (termRegex(term).test(text)) return null;
      }
      const hits: string[] = [];
      for (const group of parsed.groups) {
        const hit = group.find((term) => termRegex(term).test(text));
        if (!hit) return null;
        hits.push(hit.text);
      }
      return hits;
    },
  };
}

// --- Google News translation ------------------------------------------------

function renderTerm(term: Term): string {
  // Google News has no prefix operator, so a `climat*` term degrades to `climat`.
  return term.kind === 'phrase' ? `"${term.text}"` : term.text;
}

/**
 * Renders a parsed topic query into Google News search syntax so the same topic
 * can be pushed out to the wider web, not just our curated feed list.
 */
export function toGoogleNewsQuery(parsed: ParsedQuery, window = '1d'): string {
  const parts = parsed.groups.map((group) =>
    group.length === 1 ? renderTerm(group[0]) : `(${group.map(renderTerm).join(' OR ')})`,
  );
  for (const term of parsed.excludes) parts.push(`-${renderTerm(term)}`);
  if (window) parts.push(`when:${window}`);
  return parts.join(' ');
}

export function googleNewsFeedUrl(query: string, window = '1d'): string {
  const parsed = typeof query === 'string' ? parseQuery(query) : query;
  const q = toGoogleNewsQuery(parsed, window);
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

/** Builds the highlighted excerpt shown in the feed and the notification body. */
export function snippet(text: string, terms: string[], max = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= max) return clean;

  const first = terms
    .map((t) => clean.toLowerCase().indexOf(t.toLowerCase()))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];

  if (first === undefined) return `${clean.slice(0, max - 1)}…`;
  const start = Math.max(0, first - Math.floor(max / 3));
  const end = Math.min(clean.length, start + max);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end).trim()}${end < clean.length ? '…' : ''}`;
}
