import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  moveDataFiles,
  readStoredLocation,
  resolveDataDir,
  writeStoredLocation,
} from './datadir.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where Newsy keeps what belongs to the *user* rather than to the program: the
 * default data folder and `data-location.json`.
 *
 * Run from source this is the project folder, as it always was. The installed
 * app sets `NEWSY_HOME` to a folder under %APPDATA%, because its program folder
 * is replaced wholesale on every upgrade and a database kept there would be
 * deleted by the next installer.
 */
export const HOME = process.env.NEWSY_HOME ? path.resolve(process.env.NEWSY_HOME) : ROOT;
mkdirSync(HOME, { recursive: true });

/** Where the data lives, and any move the Developer tab asked for. */
const storedLocation = readStoredLocation(HOME);

/**
 * A move requested from the Developer tab is carried out here — at startup,
 * before anything opens the database. Doing it while the service is live would
 * mean copying a SQLite file out from under an open connection along with its
 * `-wal` and `-shm` companions, which is how a database gets destroyed.
 *
 * **A failed move must never stop Newsy from starting.** Verified the hard way:
 * an `EBUSY` from a still-locked database threw out of module initialisation and
 * took the whole service down. On failure the old folder stays in use and the
 * request stays queued, so the next restart simply tries again.
 */
const desiredDataDir = resolveDataDir(process.env.DATA_DIR, storedLocation, HOME);
let activeDataDir = desiredDataDir;
let moveOutcome: { from: string; moved: string[] } | null = null;
let moveFailure: string | null = null;

if (!process.env.DATA_DIR && storedLocation.moveFrom) {
  const from = path.resolve(storedLocation.moveFrom);
  if (from === desiredDataDir || !existsSync(from)) {
    writeStoredLocation(HOME, { dataDir: storedLocation.dataDir });
  } else {
    try {
      moveOutcome = { from, moved: moveDataFiles(from, desiredDataDir) };
      // Clear the instruction only once the move actually succeeded.
      writeStoredLocation(HOME, { dataDir: storedLocation.dataDir });
    } catch (err) {
      moveFailure = (err as Error).message;
      activeDataDir = from; // keep using the folder the data is still in
    }
  }
}

export const pendingMove = moveOutcome;
export const dataMoveError = moveFailure;

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export const config = {
  port: envInt('PORT', 3000),
  /**
   * Loopback by default: with no password set, binding every interface let
   * anyone on the same Wi-Fi read and change a desktop install. Deployments
   * that need to be reachable (Dockerfile, fly.toml) set `HOST=0.0.0.0`.
   */
  host: env('HOST', '127.0.0.1'),
  /**
   * Where the SQLite file and the generated cookie secret live. On Fly this is
   * the mounted volume; on Windows the Developer tab can point it anywhere. An
   * explicit `DATA_DIR` still wins over a stored choice — see `resolveDataDir`.
   */
  dataDir: activeDataDir,
  /** Public origin, used for absolute links in notifications. */
  publicUrl: env('PUBLIC_URL', ''),
  /** If set, the dashboard and API require this password. Leave empty for local-only use. */
  password: env('NEWSY_PASSWORD', ''),
  /** Secret used to sign session cookies. Auto-generated and persisted when unset. */
  sessionSecret: env('SESSION_SECRET', ''),
  /** How often the scheduler wakes up to look for feeds that are due. */
  tickMs: envInt('TICK_MS', 15_000),
  /** How many feeds may be in flight at once. */
  concurrency: envInt('POLL_CONCURRENCY', 6),
  /** Default seconds between polls of a single conventional RSS feed. */
  feedIntervalSec: envInt('FEED_INTERVAL_SEC', 300),
  /** Default seconds between polls of a per-topic Google News query feed. */
  gnewsIntervalSec: envInt('GNEWS_INTERVAL_SEC', 180),
  /** Articles published longer ago than this never trigger a notification (they still get stored). */
  notifyMaxAgeHours: envInt('NOTIFY_MAX_AGE_HOURS', 48),
  /** A feed is auto-disabled after this many consecutive failures. */
  maxFeedErrors: envInt('MAX_FEED_ERRORS', 12),
  /**
   * Hours before a feed switched off by errors is tried again. Without a retry,
   * an hour offline (12 failed polls at 5 minutes) switched *every* feed off for
   * good and Newsy went silent with nothing on screen saying so.
   */
  feedRetryHours: envInt('FEED_RETRY_HOURS', 6),
  /** Delete articles with no topic match after this many days. */
  retentionDays: envInt('RETENTION_DAYS', 30),
  /**
   * Delete matched articles once their newest match is older than this many
   * days. Kept forever they grew the database ~1.1 GB a year, and
   * `/api/matches` slows with the size of the matches table.
   */
  matchRetentionDays: envInt('MATCH_RETENTION_DAYS', 182),
  httpTimeoutMs: envInt('HTTP_TIMEOUT_MS', 20_000),
  userAgent: env(
    'USER_AGENT',
    'Newsy/0.1 (+https://github.com/newsy; personal news alerting bot)',
  ),
  logLevel: env('LOG_LEVEL', 'info'),
  /** Log file rotates once past this size, keeping a single `.1` generation. */
  logMaxBytes: envInt('LOG_MAX_BYTES', 5 * 1024 * 1024),
};

mkdirSync(config.dataDir, { recursive: true });

export const dbPath = path.join(config.dataDir, env('DB_FILE', 'newsy.db'));
export const logFile = path.resolve(env('LOG_FILE', path.join(config.dataDir, 'newsy.log')));

type Secrets = { sessionSecret: string };

/**
 * The cookie secret must survive restarts, or every session is invalidated on
 * boot. Prefer an env var (so a redeploy keeps working even without a volume);
 * otherwise generate once and persist next to the database.
 *
 * A `secrets.json` written before Web Push was removed also carries `publicKey`
 * and `privateKey`. Those are ignored rather than stripped: rewriting a file
 * that already holds a working session secret gains nothing and risks losing it.
 */
function loadSecrets(): Secrets {
  const file = path.join(config.dataDir, 'secrets.json');
  let stored: Partial<Secrets> = {};
  if (existsSync(file)) {
    try {
      stored = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      stored = {};
    }
  }

  const sessionSecret = config.sessionSecret || stored.sessionSecret || '';
  if (sessionSecret) return { sessionSecret };

  const secrets: Secrets = { sessionSecret: crypto.randomUUID().replaceAll('-', '') };
  writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

export const secrets = loadSecrets();
