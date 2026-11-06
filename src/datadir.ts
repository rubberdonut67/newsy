import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Where Newsy physically stores its database, log and keys, and how that
 * location can be changed from the Developer tab.
 *
 * The override cannot live in the data directory, because the data directory is
 * the thing being moved. It sits at the project root instead, which is the one
 * path the service always knows without being told.
 */
export const LOCATION_FILE = 'data-location.json';

export type StoredLocation = {
  /** Absolute path the user chose. */
  dataDir?: string;
  /**
   * Set when a move is requested. The move happens at the *next* startup, before
   * the database is opened — moving a live SQLite file out from under an open
   * connection (plus its -wal and -shm) is how you lose a database.
   */
  moveFrom?: string;
};

/** Files Newsy owns in its data directory. Anything else is left alone. */
export const OWNED_FILES = [
  'newsy.db',
  'newsy.db-wal',
  'newsy.db-shm',
  'secrets.json',
  'newsy.log',
  'newsy.log.1',
  'newsy-tray.log',
];

export function readStoredLocation(root: string): StoredLocation {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, LOCATION_FILE), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function writeStoredLocation(root: string, value: StoredLocation): void {
  writeFileSync(path.join(root, LOCATION_FILE), `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Precedence: an explicit `DATA_DIR` env var always wins.
 *
 * That ordering is load-bearing, not a preference. Test instances are run with
 * `DATA_DIR` pointed at a scratch folder, and a stored override that outranked
 * it would silently aim a test run at the live database.
 */
export function resolveDataDir(
  envValue: string | undefined,
  stored: StoredLocation,
  root: string,
): string {
  if (envValue) return path.resolve(envValue);
  if (stored.dataDir) return path.resolve(stored.dataDir);
  return path.join(root, 'data');
}

/**
 * Rejects targets that would fail, or succeed and cause harm. Returns a message
 * for the user, or null when the path is usable.
 */
export function validateTarget(target: string, current: string): string | null {
  if (!target || !target.trim()) return 'Enter a folder path.';
  const resolved = path.resolve(target);

  if (!path.isAbsolute(resolved)) return 'Use a full path, for example D:\\NewsyData.';
  if (resolved === path.resolve(current)) return 'That is already where the data is stored.';

  // Storing a database inside another Newsy install's data folder, or nesting
  // the new location inside the old one, makes the move eat its own source.
  const rel = path.relative(path.resolve(current), resolved);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return 'Choose a folder outside the current data folder.';
  }

  if (existsSync(resolved)) {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(resolved);
    } catch {
      return 'That path cannot be read.';
    }
    if (!stats.isDirectory()) return 'That path is a file, not a folder.';
  }

  return null;
}

/** Creates the folder and proves it is writable, rather than finding out later. */
export function ensureWritable(target: string): string | null {
  try {
    mkdirSync(target, { recursive: true });
    const probe = path.join(target, '.newsy-write-test');
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return null;
  } catch (err) {
    return `Cannot write to that folder (${(err as Error).message}).`;
  }
}

/**
 * Moves Newsy's own files from one directory to another. Called at startup only,
 * with nothing holding the database open.
 *
 * Falls back to copy-then-delete because `rename` fails across drives, which is
 * the most likely reason to move the data in the first place.
 */
export function moveDataFiles(from: string, to: string): string[] {
  const moved: string[] = [];
  mkdirSync(to, { recursive: true });

  // Copy everything first and only delete once every file has arrived. Moving
  // file-by-file leaves the data split across two folders when one of them
  // fails — and one *will* fail if anything still holds the database open,
  // which is exactly what happened in testing (EBUSY on newsy.db).
  for (const name of OWNED_FILES) {
    const source = path.join(from, name);
    if (!existsSync(source)) continue;
    try {
      writeFileSync(path.join(to, name), readFileSync(source));
      moved.push(name);
    } catch (err) {
      // Undo the partial copy so the destination is not a half-database that
      // looks usable on the next start.
      for (const done of moved) {
        try {
          unlinkSync(path.join(to, done));
        } catch {
          /* nothing better to do while unwinding */
        }
      }
      throw new Error(`could not copy ${name}: ${(err as Error).message}`);
    }
  }

  // Only now remove the originals. A failure here is untidy, not dangerous: the
  // new copies are complete, so leaving the old files behind is safe.
  for (const name of moved) {
    try {
      unlinkSync(path.join(from, name));
    } catch {
      /* locked or already gone */
    }
  }

  // Only tidy the old folder away if Newsy left nothing behind; a directory the
  // user also keeps other things in must survive.
  try {
    rmdirSync(from);
  } catch {
    /* not empty, or in use — leaving it is correct */
  }

  return moved;
}
