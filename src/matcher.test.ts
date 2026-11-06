import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileQuery, parseQuery, toGoogleNewsQuery, snippet } from './matcher.ts';
import { isTransient } from './feeds/fetch.ts';
import { isAggregatorLink } from './feeds/parse.ts';
import { normalizeUrl, splitTitleSource, titleKey, stripHtml } from './util.ts';

test('bare terms are ANDed', () => {
  const q = compileQuery('tesla recall');
  assert.ok(q.match('Tesla issues a recall of 12,000 vehicles'));
  assert.equal(q.match('Tesla beats delivery estimates'), null);
});

test('quoted text matches as a phrase, not as loose words', () => {
  const q = compileQuery('"supply chain"');
  assert.ok(q.match('New supply chain rules take effect'));
  assert.equal(q.match('The chain of supply was long'), null);
});

test('phrases tolerate hyphenation between words', () => {
  assert.ok(compileQuery('"rate cut"').match('The rate-cut arrives early'));
});

test('OR joins alternatives into one group', () => {
  const q = compileQuery('chips nvidia OR amd');
  assert.ok(q.match('Nvidia chips sell out'));
  assert.ok(q.match('AMD chips sell out'));
  assert.equal(q.match('Intel chips sell out'), null);
});

test('a leading dash excludes', () => {
  const q = compileQuery('climate -opinion');
  assert.ok(q.match('Climate report published'));
  assert.equal(q.match('Opinion: the climate report is wrong'), null);
});

test('terms respect word boundaries', () => {
  const q = compileQuery('ai');
  assert.ok(q.match('AI startup raises funding'));
  assert.equal(q.match('They said it was fine'), null);
  assert.equal(q.match('Air travel resumes'), null);
});

test('a trailing star matches word continuations', () => {
  const q = compileQuery('comput*');
  assert.ok(q.match('Quantum computing milestone'));
  assert.ok(q.match('The computer works'));
  assert.equal(q.match('Nothing relevant here'), null);
});

test('terms containing punctuation still match', () => {
  assert.ok(compileQuery('covid-19').match('New COVID-19 variant found'));
  assert.ok(compileQuery('f-35').match('The F-35 programme is delayed'));
});

test('an empty query is rejected rather than matching everything', () => {
  assert.throws(() => parseQuery('   '));
  assert.throws(() => parseQuery('OR'));
});

test('an unclosed quote is reported', () => {
  assert.throws(() => parseQuery('"unterminated'));
});

test('queries translate into Google News syntax', () => {
  const parsed = parseQuery('chips nvidia OR amd -rumor');
  assert.equal(toGoogleNewsQuery(parsed), 'chips (nvidia OR amd) -rumor when:1d');
});

test('matching reports which terms fired', () => {
  const hits = compileQuery('fed "rate cut"').match('Fed signals a rate cut in March');
  assert.deepEqual(hits, ['fed', 'rate cut']);
});

test('snippets centre on the matched term', () => {
  const text = `${'padding '.repeat(40)}nvidia earnings${' trailing'.repeat(40)}`;
  const out = snippet(text, ['nvidia'], 80);
  assert.ok(out.includes('nvidia'));
  assert.ok(out.length <= 84);
});

test('tracking parameters are stripped but real ones are kept', () => {
  assert.equal(
    normalizeUrl('https://www.example.com/story/?utm_source=x&id=7&fbclid=abc'),
    'https://example.com/story?id=7',
  );
});

test('url normalization is stable across http/https and trailing slashes', () => {
  assert.equal(normalizeUrl('http://example.com/a/b/'), normalizeUrl('https://www.example.com/a/b'));
});

test('Google News style titles split into headline and publisher', () => {
  assert.deepEqual(splitTitleSource('Markets rally on rate hopes - Reuters'), {
    title: 'Markets rally on rate hopes',
    source: 'Reuters',
  });
});

test('aggregator detection reads the hostname, not a URL substring', () => {
  // Regression: a pattern anchored on `^` or `.` never matched, because in a
  // real link the host sits behind `//`.
  assert.equal(isAggregatorLink('https://news.google.com/rss/articles/CBMib0FV'), true);
  assert.equal(isAggregatorLink('https://www.bbc.co.uk/news/articles/abc'), false);
  // Must not be fooled by a lookalike host.
  assert.equal(isAggregatorLink('https://news.google.com.evil.test/x'), false);
});

test('a lowercase dashed qualifier is part of the headline, not a publisher', () => {
  for (const suffix of ['live', 'analysis', 'video', 'as it happened']) {
    assert.deepEqual(splitTitleSource(`Trump speaks on tariffs in Ohio – ${suffix}`), {
      title: `Trump speaks on tariffs in Ohio – ${suffix}`,
      source: '',
    });
  }
});

test('the same story from two outlets shares a title key', () => {
  assert.equal(
    titleKey('Markets Rally on Rate Hopes — Reuters'),
    titleKey('Markets rally on rate hopes'),
  );
});

test('undici transport errors are treated as retryable, HTTP errors are not', () => {
  // The exact strings Node produces — these are what the retry path must catch.
  assert.ok(
    isTransient(
      'fetch failed — UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted address: feeds.npr.org:443, timeout: 10000ms)',
    ),
  );
  assert.ok(isTransient('ECONNRESET: socket hang up'));
  assert.ok(isTransient('terminated'));
  assert.ok(isTransient('timed out after 20000ms'));

  assert.equal(isTransient('HTTP 404 Not Found'), false);
  assert.equal(isTransient('HTTP 403 Forbidden'), false);
  assert.equal(isTransient('parse error: Unrecognized feed format'), false);
});

test('html summaries are reduced to plain text', () => {
  assert.equal(stripHtml('<p>Hello &amp; <b>welcome</b></p>'), 'Hello & welcome');
});

test('adjacent inline tags do not weld words together', () => {
  assert.equal(
    stripHtml('<span>presentar</span><span>y</span><span>entregar</span>'),
    'presentar y entregar',
  );
  assert.equal(stripHtml('<td>Reuters</td><td>Markets rally</td>'), 'Reuters Markets rally');
  assert.equal(stripHtml('<li>one</li><li>two</li>'), 'one two');
});

test('welded text would have broken matching, so the fix is load-bearing', () => {
  const summary = stripHtml('<td>Reuters</td><td>Markets rally on rate hopes</td>');
  assert.ok(compileQuery('markets').match(summary));
});

test('punctuation stays attached to its word after tag removal', () => {
  assert.equal(stripHtml('Read <a href="#">the report</a>.'), 'Read the report.');
  assert.equal(stripHtml('<b>Nvidia</b>, <b>AMD</b> and <b>Intel</b>'), 'Nvidia, AMD and Intel');
});
