import { DatabaseSync } from 'node:sqlite';
import { dbPath } from './config.ts';
import { log } from './logger.ts';

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  -- A checkpointed WAL is reset but never shrunk, so the file keeps the
  -- high-water mark of the largest transaction ever run. One retention prune
  -- had left a 33 MB -wal file sitting next to the database permanently. This
  -- truncates it back after each checkpoint; the autocheckpoint threshold
  -- (1000 pages, 4 MB) is what actually paces the writes.
  PRAGMA journal_size_limit = 8388608;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS topics (
    id           INTEGER PRIMARY KEY,
    name         TEXT    NOT NULL,
    query        TEXT    NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    notify       INTEGER NOT NULL DEFAULT 1,
    use_gnews    INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS feeds (
    id             INTEGER PRIMARY KEY,
    url            TEXT    NOT NULL UNIQUE,
    title          TEXT    NOT NULL DEFAULT '',
    category       TEXT    NOT NULL DEFAULT 'general',
    kind           TEXT    NOT NULL DEFAULT 'rss',   -- 'rss' | 'gnews'
    topic_id       INTEGER REFERENCES topics(id) ON DELETE CASCADE,
    enabled        INTEGER NOT NULL DEFAULT 1,
    interval_sec   INTEGER NOT NULL DEFAULT 300,
    etag           TEXT,
    last_modified  TEXT,
    last_polled_at INTEGER,
    last_ok_at     INTEGER,
    last_status    TEXT    NOT NULL DEFAULT '',
    error_count    INTEGER NOT NULL DEFAULT 0,
    item_count     INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feeds_due ON feeds(enabled, last_polled_at);

  CREATE TABLE IF NOT EXISTS articles (
    id           INTEGER PRIMARY KEY,
    url          TEXT    NOT NULL,
    url_key      TEXT    NOT NULL UNIQUE,
    title        TEXT    NOT NULL,
    title_key    TEXT    NOT NULL,
    summary      TEXT    NOT NULL DEFAULT '',
    author       TEXT    NOT NULL DEFAULT '',
    source       TEXT    NOT NULL DEFAULT '',
    image_url    TEXT    NOT NULL DEFAULT '',
    published_at INTEGER NOT NULL,
    fetched_at   INTEGER NOT NULL,
    feed_id      INTEGER REFERENCES feeds(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS articles_published ON articles(published_at DESC);
  CREATE INDEX IF NOT EXISTS articles_title_key ON articles(title_key);
  -- stats() counts the last 24 hours on every /api/state, and the tray calls
  -- that every 30 seconds for its tooltip. Unindexed it was a full scan of the
  -- articles table — 1.6 s against a 160 MB table, ~2900 times a day.
  CREATE INDEX IF NOT EXISTS articles_fetched ON articles(fetched_at);
  -- Parent key for feed_id REFERENCES feeds(id) ON DELETE SET NULL. SQLite
  -- does not index the child side for you, so deleting one feed scanned all
  -- 138k articles to find the rows to null out.
  CREATE INDEX IF NOT EXISTS articles_feed ON articles(feed_id);

  CREATE TABLE IF NOT EXISTS matches (
    id          INTEGER PRIMARY KEY,
    topic_id    INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    matched_at  INTEGER NOT NULL,
    notified_at INTEGER,
    read_at     INTEGER,
    UNIQUE(topic_id, article_id)
  );
  CREATE INDEX IF NOT EXISTS matches_recent ON matches(matched_at DESC);
  CREATE INDEX IF NOT EXISTS matches_unsent ON matches(notified_at) WHERE notified_at IS NULL;
  -- The UNIQUE(topic_id, article_id) constraint indexes those two columns in
  -- that order, which cannot answer a lookup by article_id alone. That lookup
  -- is exactly what ON DELETE CASCADE performs for every article the
  -- retention prune removes, so each deleted row scanned the whole matches
  -- table: deleting 2000 articles took 7.5 s, and 17 ms with this index.
  CREATE INDEX IF NOT EXISTS matches_article ON matches(article_id);
  -- The unread badge, counted on every /api/state.
  CREATE INDEX IF NOT EXISTS matches_unread ON matches(read_at) WHERE read_at IS NULL;

  CREATE TABLE IF NOT EXISTS publishers (
    id               INTEGER PRIMARY KEY,
    name             TEXT    NOT NULL,
    domain           TEXT    NOT NULL UNIQUE,   -- cookie domain, e.g. 'wsj.com'
    login_url        TEXT    NOT NULL DEFAULT '',
    blocking_enabled INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL
  );

  -- Application-wide preferences, as opposed to the per-topic and per-feed flags
  -- above. Deliberately key/value rather than a one-row table: everything here
  -- is read and written one setting at a time, and a new preference must never
  -- require a column migration against a database with no backups.
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// A `subscriptions` table lives in databases created before Web Push was removed
// on 22 Aug 2026. It is no longer created or read. Existing ones are left in
// place rather than dropped — an unused empty table costs nothing, and a
// destructive migration against a file with no backup is not worth the tidiness.

/**
 * Additive column migrations. `CREATE TABLE IF NOT EXISTS` above never alters an
 * existing table, so a database seeded before a column was introduced needs the
 * column added explicitly. Adding a duplicate throws, which is the signal that
 * the migration has already run.
 */
for (const [table, column, spec] of [
  ['publishers', 'blocking_enabled', 'INTEGER NOT NULL DEFAULT 1'],
] as const) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (existing.length > 0 && !existing.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
    log.info(`migrated: added ${table}.${column}`);
  }
}

/**
 * Hands the query planner table and index statistics. Without them it falls
 * back to fixed guesses about selectivity, and it was choosing a 160 MB table
 * scan over an index that answered the same count in a fraction of a
 * millisecond. `optimize` is the cheap form of `ANALYZE`: it only re-measures
 * the tables whose row counts have moved far enough to matter, so it costs
 * ~40 ms on a first run against a database this size and next to nothing after.
 */
db.exec('PRAGMA optimize');

// --- Row shapes -------------------------------------------------------------

export type Topic = {
  id: number;
  name: string;
  query: string;
  enabled: number;
  notify: number;
  use_gnews: number;
  created_at: number;
};

export type Feed = {
  id: number;
  url: string;
  title: string;
  category: string;
  kind: string;
  topic_id: number | null;
  enabled: number;
  interval_sec: number;
  etag: string | null;
  last_modified: string | null;
  last_polled_at: number | null;
  last_ok_at: number | null;
  last_status: string;
  error_count: number;
  item_count: number;
  created_at: number;
};

export type Article = {
  id: number;
  url: string;
  url_key: string;
  title: string;
  title_key: string;
  summary: string;
  author: string;
  source: string;
  image_url: string;
  published_at: number;
  fetched_at: number;
  feed_id: number | null;
};

/**
 * A site the user holds a paid subscription to. Newsy stores only which sites
 * these are and where their login page is — never credentials. The signed-in
 * session itself lives in the desktop shell's own cookie jar, exactly as it
 * would in a browser.
 */
export type Publisher = {
  id: number;
  name: string;
  domain: string;
  login_url: string;
  /** 0 exempts the site from ad/tracker blocking, for when a filter breaks its login. */
  blocking_enabled: number;
  created_at: number;
};

/** Runs `fn` inside a transaction, rolling back if it throws. */
export function transact<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/**
 * Drops unmatched articles older than `retentionDays`, and matched ones whose
 * newest match is older than `matchRetentionDays`. Their match rows go with
 * them via ON DELETE CASCADE.
 */
export function pruneArticles(retentionDays: number, matchRetentionDays: number): number {
  const now = Date.now();
  const unmatched = Number(
    db
      .prepare(
        `DELETE FROM articles
          WHERE published_at < ?
            AND id NOT IN (SELECT article_id FROM matches)`,
      )
      .run(now - retentionDays * 86_400_000).changes,
  );
  // Keyed on matched_at rather than published_at: an old article that matched
  // last week is news the user just saw. Grouping walks matches_article.
  const matched = Number(
    db
      .prepare(
        `DELETE FROM articles
          WHERE id IN (SELECT article_id FROM matches
                        GROUP BY article_id HAVING MAX(matched_at) < ?)`,
      )
      .run(now - matchRetentionDays * 86_400_000).changes,
  );
  // Visible at the default log level: this deletes rows, and silently discarding
  // thousands of articles should never be something you can only see in debug.
  if (unmatched > 0) log.info(`pruned ${unmatched} unmatched articles older than ${retentionDays}d`);
  if (matched > 0) log.info(`pruned ${matched} matched articles not matched in ${matchRetentionDays}d`);
  return unmatched + matched;
}
