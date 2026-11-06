import { config } from './config.ts';
import { db, transact } from './db.ts';
import type { Article, Feed, Publisher, Topic } from './db.ts';
import { DEFAULT_FEEDS, RETIRED_FEEDS } from './feeds/defaults.ts';
import { SEED_PUBLISHERS } from './feeds/publishers.ts';
import type { FeedItem } from './feeds/parse.ts';
import { compileQuery, googleNewsFeedUrl, snippet } from './matcher.ts';
import type { CompiledQuery } from './matcher.ts';
import { log } from './logger.ts';
import { cookieDomain, hostOf, normalizeUrl, titleKey } from './util.ts';

/** Window in which two identical-ish headlines are treated as the same story. */
const DUPLICATE_WINDOW_MS = 36 * 3_600_000;

export type MatchEvent = {
  matchId: number;
  topic: Topic;
  article: Article;
  terms: string[];
  snippet: string;
};

// --- Settings ---------------------------------------------------------------

const readSetting = (key: string): string | undefined =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;

const writeSetting = (key: string, value: string): void => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
};

/** How far a mute reaches. `toasts` is the Windows notification only. */
export type MuteScope = 'toasts' | 'all';

export type AlertMute = {
  muted: boolean;
  /** Epoch ms at which the mute lapses, or null when it lasts until switched off. */
  mutedUntil: number | null;
  scope: MuteScope;
};

/**
 * The global alert mute. Reading is deliberately pure: an expired mute reports
 * itself unmuted without writing anything, so every process sees the truth the
 * instant the deadline passes rather than whenever someone happens to sweep.
 * `expireAlertMute` below is the one place the expired row is actually cleared,
 * which is what lets the poller announce the change exactly once.
 */
export function alertMute(now = Date.now()): AlertMute {
  const mutedUntil = Number(readSetting('alerts.muted_until') ?? 0) || null;
  const stored = readSetting('alerts.muted') === '1';
  return {
    muted: stored && (mutedUntil === null || now < mutedUntil),
    mutedUntil: stored ? mutedUntil : null,
    scope: readSetting('alerts.mute_scope') === 'all' ? 'all' : 'toasts',
  };
}

/** Clears a lapsed mute. Returns the new state when one was cleared, else null. */
export function expireAlertMute(now = Date.now()): AlertMute | null {
  const until = Number(readSetting('alerts.muted_until') ?? 0) || null;
  if (readSetting('alerts.muted') !== '1' || until === null || now < until) return null;
  writeSetting('alerts.muted', '0');
  writeSetting('alerts.muted_until', '0');
  log.info('alert mute expired — notifications are back on');
  return alertMute(now);
}

export function setAlertMute(
  input: { muted?: boolean; minutes?: number | null; scope?: MuteScope },
  now = Date.now(),
): AlertMute {
  if (input.scope) writeSetting('alerts.mute_scope', input.scope);

  if (input.muted === false) {
    writeSetting('alerts.muted', '0');
    writeSetting('alerts.muted_until', '0');
  } else if (input.muted === true) {
    // A non-positive or absent duration means "until I turn it back on".
    const minutes = input.minutes && input.minutes > 0 ? input.minutes : null;
    writeSetting('alerts.muted', '1');
    writeSetting('alerts.muted_until', minutes === null ? '0' : String(now + minutes * 60_000));
  }

  const state = alertMute(now);
  if (input.muted !== undefined) {
    log.info(
      state.muted
        ? `alerts muted (${state.mutedUntil === null ? 'until switched back on' : `until ${new Date(state.mutedUntil).toISOString()}`}, scope ${state.scope})`
        : 'alerts unmuted',
    );
  }
  return state;
}

// --- Topics -----------------------------------------------------------------

export function listTopics(): Topic[] {
  return db.prepare('SELECT * FROM topics ORDER BY created_at DESC').all() as Topic[];
}

export function getTopic(id: number): Topic | undefined {
  return db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as Topic | undefined;
}

function enabledTopics(): Topic[] {
  return db.prepare('SELECT * FROM topics WHERE enabled = 1').all() as Topic[];
}

export function createTopic(input: {
  name: string;
  query: string;
  notify?: boolean;
  useGnews?: boolean;
}): Topic {
  compileQuery(input.query); // throws QueryError on bad syntax, before anything is written
  const now = Date.now();

  const id = transact(() => {
    const res = db
      .prepare(
        `INSERT INTO topics (name, query, enabled, notify, use_gnews, created_at)
         VALUES (?, ?, 1, ?, ?, ?)`,
      )
      .run(
        input.name.trim() || input.query.trim(),
        input.query.trim(),
        input.notify === false ? 0 : 1,
        input.useGnews === false ? 0 : 1,
        now,
      );
    return Number(res.lastInsertRowid);
  });

  const topic = getTopic(id)!;
  syncTopicFeed(topic);
  rematchTopic(topic);
  return topic;
}

/**
 * Re-evaluates a topic against everything already collected, in both directions:
 * articles that now match are added, and articles that no longer match are
 * dropped. Adding is what gives a new topic history instead of an empty page;
 * dropping is what makes editing a query meaningful — tightening `claude` to
 * `claude -obituary` should clear the obituaries out, not just filter future ones.
 *
 * New matches are written as already-notified. The point is to fill the feed, not
 * to fire a burst of alerts for stories the user may have read days ago.
 */
export function rematchTopic(topic: Topic): { added: number; removed: number } {
  const compiled = compiledFor(topic);
  if (!compiled) return { added: 0, removed: 0 };

  const now = Date.now();
  const matches = (text: Pick<Article, 'title' | 'summary' | 'source'>) =>
    Boolean(compiled.match(`${text.title}\n${text.summary}\n${text.source}`));

  let added = 0;
  let removed = 0;

  transact(() => {
    // Drop stale matches across the topic's whole history, not just recent items.
    const existing = db
      .prepare(
        `SELECT a.id, a.title, a.summary, a.source
           FROM matches m JOIN articles a ON a.id = m.article_id
          WHERE m.topic_id = ?`,
      )
      .all(topic.id) as Pick<Article, 'id' | 'title' | 'summary' | 'source'>[];

    const seen = new Set<number>();
    const del = db.prepare('DELETE FROM matches WHERE topic_id = ? AND article_id = ?');
    for (const row of existing) {
      seen.add(row.id);
      if (!matches(row)) removed += Number(del.run(topic.id, row.id).changes);
    }

    // Add anything within the retention window that matches but was not linked.
    const candidates = db
      .prepare(
        `SELECT id, title, summary, source FROM articles
          WHERE published_at > ?
          ORDER BY published_at DESC`,
      )
      .all(now - config.retentionDays * 86_400_000) as Pick<
      Article,
      'id' | 'title' | 'summary' | 'source'
    >[];

    for (const row of candidates) {
      if (seen.has(row.id) || !matches(row)) continue;
      added += Number(insertMatch.run(topic.id, row.id, now, now).changes);
    }
  });

  if (added || removed) {
    log.info(`re-matched "${topic.name}": +${added} added, -${removed} removed`);
  }
  return { added, removed };
}

export function updateTopic(
  id: number,
  patch: { name?: string; query?: string; enabled?: boolean; notify?: boolean; useGnews?: boolean },
): { topic: Topic; added: number; removed: number } | undefined {
  const existing = getTopic(id);
  if (!existing) return undefined;
  if (patch.query !== undefined) compileQuery(patch.query);

  db.prepare(
    `UPDATE topics
        SET name = ?, query = ?, enabled = ?, notify = ?, use_gnews = ?
      WHERE id = ?`,
  ).run(
    (patch.name ?? existing.name).trim(),
    (patch.query ?? existing.query).trim(),
    patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
    patch.notify === undefined ? existing.notify : patch.notify ? 1 : 0,
    patch.useGnews === undefined ? existing.use_gnews : patch.useGnews ? 1 : 0,
    id,
  );

  const updated = getTopic(id)!;
  syncTopicFeed(updated);
  // Only a query change alters what matches; renaming or muting does not.
  const counts =
    updated.query !== existing.query ? rematchTopic(updated) : { added: 0, removed: 0 };
  return { topic: updated, ...counts };
}

export function deleteTopic(id: number): boolean {
  // Feeds and matches cascade; articles are left for the retention sweep.
  const res = db.prepare('DELETE FROM topics WHERE id = ?').run(id);
  return Number(res.changes) > 0;
}

/**
 * Keeps each topic's Google News query feed in step with its query, so a topic
 * is followed across the whole web rather than only inside our curated list.
 */
export function syncTopicFeed(topic: Topic): void {
  const existing = db.prepare('SELECT * FROM feeds WHERE topic_id = ?').get(topic.id) as
    | Feed
    | undefined;

  if (!topic.use_gnews || !topic.enabled) {
    if (existing) db.prepare('DELETE FROM feeds WHERE id = ?').run(existing.id);
    return;
  }

  const url = googleNewsFeedUrl(topic.query);
  const title = `Google News — ${topic.name}`;

  if (!existing) {
    db.prepare(
      `INSERT INTO feeds (url, title, category, kind, topic_id, enabled, interval_sec, created_at)
       VALUES (?, ?, 'topic', 'gnews', ?, 1, ?, ?)
       ON CONFLICT(url) DO UPDATE SET topic_id = excluded.topic_id, enabled = 1, error_count = 0`,
    ).run(url, title, topic.id, config.gnewsIntervalSec, Date.now());
    return;
  }

  if (existing.url !== url || existing.title !== title) {
    // The query changed: reset caching headers so the new query fetches immediately.
    db.prepare(
      `UPDATE feeds
          SET url = ?, title = ?, etag = NULL, last_modified = NULL,
              last_polled_at = NULL, error_count = 0, enabled = 1
        WHERE id = ?`,
    ).run(url, title, existing.id);
  }
}

// --- Feeds ------------------------------------------------------------------

export function seedFeeds(): number {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO feeds (url, title, category, kind, enabled, interval_sec, created_at)
     VALUES (?, ?, ?, 'rss', 1, ?, ?)
     ON CONFLICT(url) DO NOTHING`,
  );
  const retire = db.prepare("DELETE FROM feeds WHERE url = ? AND kind = 'rss'");
  let added = 0;
  let retired = 0;
  transact(() => {
    for (const feed of DEFAULT_FEEDS) {
      const res = insert.run(feed.url, feed.title, feed.category, config.feedIntervalSec, now);
      added += Number(res.changes);
    }
    for (const url of RETIRED_FEEDS) retired += Number(retire.run(url).changes);
  });
  if (added) log.info(`seeded ${added} default feeds`);
  if (retired) log.info(`removed ${retired} retired default feed(s)`);
  return added;
}

// --- Publishers -------------------------------------------------------------

export function seedPublishers(): number {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO publishers (name, domain, login_url, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(domain) DO NOTHING`,
  );
  let added = 0;
  transact(() => {
    for (const publisher of SEED_PUBLISHERS) {
      added += Number(insert.run(publisher.name, publisher.domain, publisher.loginUrl, now).changes);
    }
  });
  if (added) log.info(`seeded ${added} subscription publishers`);
  return added;
}

export function listPublishers(): Publisher[] {
  return db.prepare('SELECT * FROM publishers ORDER BY name').all() as Publisher[];
}

export function addPublisher(input: { name?: string; url: string }): Publisher | null {
  const domain = cookieDomain(input.url);
  if (!domain) return null;

  // A pasted article or login URL is the natural thing to have on the clipboard,
  // so keep it as the sign-in target rather than demanding a tidy homepage.
  const loginUrl = /^https?:\/\//i.test(input.url.trim())
    ? input.url.trim()
    : `https://${domain}`;

  db.prepare(
    `INSERT INTO publishers (name, domain, login_url, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       name = excluded.name,
       login_url = excluded.login_url`,
  ).run((input.name ?? '').trim() || domain, domain, loginUrl, Date.now());

  return db.prepare('SELECT * FROM publishers WHERE domain = ?').get(domain) as Publisher;
}

export function setPublisherBlocking(id: number, enabled: boolean): Publisher | null {
  const changed = db
    .prepare('UPDATE publishers SET blocking_enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, id).changes;
  if (Number(changed) === 0) return null;
  return db.prepare('SELECT * FROM publishers WHERE id = ?').get(id) as Publisher;
}

export function deletePublisher(id: number): boolean {
  return Number(db.prepare('DELETE FROM publishers WHERE id = ?').run(id).changes) > 0;
}

// --- Feeds ------------------------------------------------------------------

export function listFeeds(): Feed[] {
  return db
    .prepare('SELECT * FROM feeds ORDER BY enabled DESC, category, title')
    .all() as Feed[];
}

export function addFeed(url: string, title = '', category = 'custom'): Feed {
  const clean = normalizeUrl(url);
  db.prepare(
    `INSERT INTO feeds (url, title, category, kind, enabled, interval_sec, created_at)
     VALUES (?, ?, ?, 'rss', 1, ?, ?)
     ON CONFLICT(url) DO UPDATE SET enabled = 1, error_count = 0, last_polled_at = NULL`,
  ).run(clean, title || hostOf(clean), category, config.feedIntervalSec, Date.now());
  return db.prepare('SELECT * FROM feeds WHERE url = ?').get(clean) as Feed;
}

export function setFeedEnabled(id: number, enabled: boolean): boolean {
  const res = db
    .prepare('UPDATE feeds SET enabled = ?, error_count = 0 WHERE id = ?')
    .run(enabled ? 1 : 0, id);
  return Number(res.changes) > 0;
}

export function deleteFeed(id: number): boolean {
  const res = db.prepare("DELETE FROM feeds WHERE id = ? AND kind = 'rss'").run(id);
  return Number(res.changes) > 0;
}

/**
 * Feeds due a poll: every enabled feed whose interval has passed, plus each feed
 * that errors switched off once `feedRetryHours` have gone by since its last try.
 *
 * The two kinds of "off" are told apart by `error_count`: switching a feed off
 * by hand resets it to 0 (`setFeedEnabled`), so a feed the user turned off is
 * never retried behind their back.
 */
export function dueFeeds(limit: number): Feed[] {
  const now = Date.now();
  return db
    .prepare(
      `SELECT * FROM feeds
        WHERE (enabled = 1
               AND (last_polled_at IS NULL OR last_polled_at + interval_sec * 1000 <= ?))
           OR (enabled = 0 AND error_count >= ?
               AND (last_polled_at IS NULL OR last_polled_at <= ?))
        ORDER BY last_polled_at IS NOT NULL, last_polled_at
        LIMIT ?`,
    )
    .all(now, config.maxFeedErrors, now - config.feedRetryHours * 3_600_000, limit) as Feed[];
}

/** Every live feed, ignoring the schedule — used by the manual refresh button. */
export function allEnabledFeeds(): Feed[] {
  return db
    .prepare('SELECT * FROM feeds WHERE enabled = 1 ORDER BY last_polled_at IS NOT NULL, last_polled_at')
    .all() as Feed[];
}

export function markFeedResult(
  feedId: number,
  result: { ok: boolean; status: string; etag?: string | null; lastModified?: string | null; items?: number },
): void {
  const now = Date.now();
  if (result.ok) {
    db.prepare(
      `UPDATE feeds
          SET last_polled_at = ?, last_ok_at = ?, last_status = ?, error_count = 0,
              -- A feed that errors had switched off and that works again on its
              -- retry comes back on. SQLite evaluates this against the old row,
              -- so error_count here is the count *before* the reset above.
              enabled = CASE WHEN enabled = 0 AND error_count >= ? THEN 1 ELSE enabled END,
              etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
              item_count = COALESCE(?, item_count)
        WHERE id = ?`,
    ).run(now, now, result.status, config.maxFeedErrors, result.etag ?? null, result.lastModified ?? null, result.items ?? null, feedId);
    return;
  }

  db.prepare(
    `UPDATE feeds
        SET last_polled_at = ?, last_status = ?, error_count = error_count + 1,
            enabled = CASE WHEN error_count + 1 >= ? THEN 0 ELSE enabled END
      WHERE id = ?`,
  ).run(now, result.status, config.maxFeedErrors, feedId);
}

// --- Ingestion --------------------------------------------------------------

const findByUrl = db.prepare('SELECT id FROM articles WHERE url_key = ?');
const findByTitle = db.prepare(
  'SELECT id FROM articles WHERE title_key = ? AND published_at > ? LIMIT 1',
);
const insertArticle = db.prepare(
  `INSERT INTO articles
     (url, url_key, title, title_key, summary, author, source, image_url, published_at, fetched_at, feed_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insertMatch = db.prepare(
  `INSERT INTO matches (topic_id, article_id, matched_at, notified_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(topic_id, article_id) DO NOTHING`,
);

/** Topic queries are recompiled only when a topic's text actually changes. */
const compiledCache = new Map<number, { query: string; compiled: CompiledQuery }>();

function compiledFor(topic: Topic): CompiledQuery | null {
  const cached = compiledCache.get(topic.id);
  if (cached && cached.query === topic.query) return cached.compiled;
  try {
    const compiled = compileQuery(topic.query);
    compiledCache.set(topic.id, { query: topic.query, compiled });
    return compiled;
  } catch (err) {
    log.warn(`topic ${topic.id} has an invalid query, skipping`, err);
    return null;
  }
}

export type IngestResult = { stored: number; duplicates: number; events: MatchEvent[] };

/**
 * Stores anything we have not seen before and evaluates it against every enabled
 * topic. Articles published before a topic existed still get recorded as matches
 * so the topic has history, but they are pre-marked as notified so adding a topic
 * never sets off a burst of alerts.
 */
export function ingestItems(feed: Feed, items: FeedItem[]): IngestResult {
  const topics = enabledTopics();
  const now = Date.now();
  const notifyCutoff = now - config.notifyMaxAgeHours * 3_600_000;
  const events: MatchEvent[] = [];
  let stored = 0;
  let duplicates = 0;

  transact(() => {
    for (const item of items) {
      const url = normalizeUrl(item.link);
      if (!url || !item.title) continue;

      if (findByUrl.get(url)) {
        duplicates++;
        continue;
      }
      const tkey = titleKey(item.title);
      if (tkey.length > 20 && findByTitle.get(tkey, item.publishedAt - DUPLICATE_WINDOW_MS)) {
        duplicates++;
        continue;
      }

      const source = item.source || feed.title || hostOf(url);
      const res = insertArticle.run(
        url,
        url,
        item.title,
        tkey,
        item.summary,
        item.author,
        source,
        item.imageUrl,
        item.publishedAt,
        now,
        feed.id,
      );
      const articleId = Number(res.lastInsertRowid);
      stored++;

      const haystack = `${item.title}\n${item.summary}\n${source}`;
      for (const topic of topics) {
        const compiled = compiledFor(topic);
        if (!compiled) continue;
        const terms = compiled.match(haystack);
        if (!terms) continue;

        const shouldNotify =
          topic.notify === 1 &&
          item.publishedAt >= topic.created_at &&
          item.publishedAt >= notifyCutoff;

        const inserted = insertMatch.run(topic.id, articleId, now, shouldNotify ? null : now);
        if (Number(inserted.changes) === 0) continue;

        if (shouldNotify) {
          events.push({
            matchId: Number(inserted.lastInsertRowid),
            topic,
            article: db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId) as Article,
            terms,
            snippet: snippet(item.summary || item.title, terms),
          });
        }
      }
    }
  });

  return { stored, duplicates, events };
}

export function markNotified(matchIds: number[]): void {
  if (matchIds.length === 0) return;
  const stmt = db.prepare('UPDATE matches SET notified_at = ? WHERE id = ? AND notified_at IS NULL');
  const now = Date.now();
  transact(() => {
    for (const id of matchIds) stmt.run(now, id);
  });
}

// --- Reading ----------------------------------------------------------------

export type MatchRow = {
  match_id: number;
  topic_id: number;
  topic_name: string;
  matched_at: number;
  read_at: number | null;
  notified_at: number | null;
  id: number;
  url: string;
  title: string;
  summary: string;
  source: string;
  author: string;
  image_url: string;
  published_at: number;
};

/**
 * One card in the feed. When several topics are selected at once a single
 * article can match more than one of them, so a card carries every topic it
 * matched and every underlying match row rather than appearing once per topic.
 */
export type FeedRow = {
  match_ids: number[];
  topics: { id: number; name: string }[];
  matched_at: number;
  read_at: number | null;
  id: number;
  url: string;
  title: string;
  summary: string;
  source: string;
  author: string;
  image_url: string;
  published_at: number;
  terms?: string[];
};

export function listMatches(opts: {
  topicIds?: number[];
  unreadOnly?: boolean;
  since?: number;
  limit?: number;
}): FeedRow[] {
  const where: string[] = [];
  const params: (number | string)[] = [];

  const topicIds = (opts.topicIds ?? []).filter((id) => Number.isFinite(id));
  if (topicIds.length > 0) {
    where.push(`m.topic_id IN (${topicIds.map(() => '?').join(',')})`);
    params.push(...topicIds);
  }
  if (opts.unreadOnly) where.push('m.read_at IS NULL');
  if (opts.since) {
    where.push('m.matched_at > ?');
    params.push(opts.since);
  }

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  // Over-fetch: several match rows can collapse into a single card, so asking
  // for exactly `limit` rows could return fewer than `limit` articles.
  params.push(limit * 3);

  const rows = db
    .prepare(
      `SELECT m.id AS match_id, m.topic_id, t.name AS topic_name, m.matched_at, m.read_at,
              a.id, a.url, a.title, a.summary, a.source, a.author,
              a.image_url, a.published_at
         FROM matches m
         JOIN topics   t ON t.id = m.topic_id
         JOIN articles a ON a.id = m.article_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.published_at DESC, m.matched_at DESC
        LIMIT ?`,
    )
    .all(...params) as (Omit<FeedRow, 'match_ids' | 'topics'> & {
    match_id: number;
    topic_id: number;
    topic_name: string;
  })[];

  const byArticle = new Map<number, FeedRow>();
  for (const row of rows) {
    const existing = byArticle.get(row.id);
    if (existing) {
      existing.match_ids.push(row.match_id);
      if (!existing.topics.some((t) => t.id === row.topic_id)) {
        existing.topics.push({ id: row.topic_id, name: row.topic_name });
      }
      // A card stays unread while any of its matches is unread.
      if (row.read_at === null) existing.read_at = null;
      existing.matched_at = Math.max(existing.matched_at, row.matched_at);
      continue;
    }
    // Keep merging into cards we already have, but stop opening new ones.
    if (byArticle.size >= limit) continue;
    byArticle.set(row.id, {
      match_ids: [row.match_id],
      topics: [{ id: row.topic_id, name: row.topic_name }],
      matched_at: row.matched_at,
      read_at: row.read_at,
      id: row.id,
      url: row.url,
      title: row.title,
      summary: row.summary,
      source: row.source,
      author: row.author,
      image_url: row.image_url,
      published_at: row.published_at,
    });
  }

  return [...byArticle.values()];
}

/** Renders a freshly-created match in exactly the shape `listMatches` returns. */
export function relativeMatchView(event: MatchEvent): FeedRow {
  return {
    match_ids: [event.matchId],
    topics: [{ id: event.topic.id, name: event.topic.name }],
    matched_at: Date.now(),
    read_at: null,
    id: event.article.id,
    url: event.article.url,
    title: event.article.title,
    summary: event.snippet || event.article.summary,
    source: event.article.source,
    author: event.article.author,
    image_url: event.article.image_url,
    published_at: event.article.published_at,
    terms: event.terms,
  };
}

export function markRead(matchIds: number[] | 'all', topicIds?: number[]): number {
  const now = Date.now();
  if (matchIds === 'all') {
    const ids = (topicIds ?? []).filter((id) => Number.isFinite(id));
    // "Mark all read" applies to whatever is currently selected, which may be
    // several topics or, with nothing selected, the entire feed.
    const res = ids.length
      ? db
          .prepare(
            `UPDATE matches SET read_at = ?
              WHERE read_at IS NULL AND topic_id IN (${ids.map(() => '?').join(',')})`,
          )
          .run(now, ...ids)
      : db.prepare('UPDATE matches SET read_at = ? WHERE read_at IS NULL').run(now);
    return Number(res.changes);
  }
  const stmt = db.prepare('UPDATE matches SET read_at = ? WHERE id = ?');
  let changed = 0;
  transact(() => {
    for (const id of matchIds) changed += Number(stmt.run(now, id).changes);
  });
  return changed;
}

/**
 * Dry-runs a query against the articles already collected so a topic can be
 * tuned before it is saved — the fastest way to tell "too noisy" from "too narrow".
 */
export function previewQuery(query: string, limit = 12): {
  googleNews: string;
  sampleSize: number;
  hits: { title: string; source: string; url: string; published_at: number; terms: string[] }[];
} {
  const compiled = compileQuery(query);
  const recent = db
    .prepare(
      'SELECT title, summary, source, url, published_at FROM articles ORDER BY published_at DESC LIMIT 3000',
    )
    .all() as Pick<Article, 'title' | 'summary' | 'source' | 'url' | 'published_at'>[];

  const hits: { title: string; source: string; url: string; published_at: number; terms: string[] }[] = [];
  for (const row of recent) {
    const terms = compiled.match(`${row.title}\n${row.summary}\n${row.source}`);
    if (!terms) continue;
    hits.push({ title: row.title, source: row.source, url: row.url, published_at: row.published_at, terms });
    if (hits.length >= limit) break;
  }

  return {
    googleNews: googleNewsFeedUrl(query),
    sampleSize: recent.length,
    hits,
  };
}

export function stats() {
  const one = (sql: string, ...params: unknown[]) =>
    Number((db.prepare(sql).get(...(params as never[])) as { n: number }).n);

  return {
    topics: one('SELECT COUNT(*) AS n FROM topics'),
    feeds: one('SELECT COUNT(*) AS n FROM feeds'),
    activeFeeds: one('SELECT COUNT(*) AS n FROM feeds WHERE enabled = 1'),
    brokenFeeds: one('SELECT COUNT(*) AS n FROM feeds WHERE enabled = 0 AND error_count > 0'),
    articles: one('SELECT COUNT(*) AS n FROM articles'),
    articlesToday: one('SELECT COUNT(*) AS n FROM articles WHERE fetched_at > ?', Date.now() - 86_400_000),
    matches: one('SELECT COUNT(*) AS n FROM matches'),
    unread: one('SELECT COUNT(*) AS n FROM matches WHERE read_at IS NULL'),
  };
}

export function topicCounts(): Record<number, { total: number; unread: number }> {
  const rows = db
    .prepare(
      `SELECT topic_id,
              COUNT(*) AS total,
              SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread
         FROM matches GROUP BY topic_id`,
    )
    .all() as { topic_id: number; total: number; unread: number }[];

  const out: Record<number, { total: number; unread: number }> = {};
  for (const row of rows) out[row.topic_id] = { total: Number(row.total), unread: Number(row.unread) };
  return out;
}
