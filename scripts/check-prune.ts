// Runs the real retention prune against a *copy* of a Newsy database and
// reports what it removed and how long it took. Never touches the source.
//
//   node scripts/check-prune.ts <source.db> <scratch-dir> <matchRetentionDays>
//
// The source is snapshotted with VACUUM INTO, which is safe on a live WAL
// database. DATA_DIR is pointed at the scratch dir before db.ts loads, so the
// prune runs on the copy.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const [source, scratch, days] = process.argv.slice(2);
if (!source || !scratch || !days) {
  console.error('usage: node scripts/check-prune.ts <source.db> <scratch-dir> <matchRetentionDays>');
  process.exit(1);
}
mkdirSync(scratch, { recursive: true });
const copy = path.join(scratch, 'newsy.db');
rmSync(copy, { force: true });
new DatabaseSync(source, { readOnly: true }).exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);

process.env.DATA_DIR = scratch;
process.env.DB_FILE = 'newsy.db';
const { db, pruneArticles } = await import('../src/db.ts');

const count = () =>
  db.prepare(`SELECT (SELECT COUNT(*) FROM articles) a, (SELECT COUNT(*) FROM matches) m`).get();
const before = count();
const started = performance.now();
const removed = pruneArticles(30, Number(days));
const ms = performance.now() - started;
const after = count();
const survivorTooOld = db
  .prepare(
    `SELECT COUNT(*) n FROM (SELECT article_id FROM matches GROUP BY article_id
       HAVING MAX(matched_at) < ?)`,
  )
  .get(Date.now() - Number(days) * 86_400_000);
console.log(JSON.stringify({ days: Number(days), before, after, removed, ms: Math.round(ms), survivorTooOld }));
db.close();
