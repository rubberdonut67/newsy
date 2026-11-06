import { appendFileSync, renameSync, statSync } from 'node:fs';
import { config, logFile } from './config.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(config.logLevel as Level)] ?? LEVELS.info;

/**
 * Running as a background task there is no console to read, so everything is
 * mirrored to a file. Size is tracked in memory rather than stat-ing on every
 * line; the initial read picks up where a previous run left off.
 */
let bytesWritten = (() => {
  try {
    return statSync(logFile).size;
  } catch {
    return 0;
  }
})();

function rotateIfNeeded() {
  if (bytesWritten < config.logMaxBytes) return;
  try {
    // One generation of history is enough to diagnose a crash without the log
    // quietly eating the disk.
    renameSync(logFile, `${logFile}.1`);
    bytesWritten = 0;
  } catch {
    bytesWritten = 0;
  }
}

function writeToFile(line: string) {
  try {
    const payload = `${line}\n`;
    appendFileSync(logFile, payload);
    bytesWritten += Buffer.byteLength(payload);
    rotateIfNeeded();
  } catch {
    // Logging must never take the process down.
  }
}

function format(extra: unknown): string {
  if (extra === undefined) return '';
  if (extra instanceof Error) return ` ${extra.stack ?? extra.message}`;
  if (typeof extra === 'string') return ` ${extra}`;
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return ` ${String(extra)}`;
  }
}

function emit(level: Level, msg: string, extra?: unknown) {
  if (LEVELS[level] < threshold) return;
  const now = new Date();
  const tag = level.toUpperCase().padEnd(5);

  // Console keeps the short clock; the file gets a full date, since it spans days.
  const consoleLine = `${now.toISOString().slice(11, 19)} ${tag} ${msg}`;
  if (extra === undefined) console.log(consoleLine);
  else console.log(consoleLine, extra);

  writeToFile(`${now.toISOString().replace('T', ' ').slice(0, 19)} ${tag} ${msg}${format(extra)}`);
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};
