import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  moveDataFiles,
  readStoredLocation,
  resolveDataDir,
  validateTarget,
  writeStoredLocation,
} from './datadir.ts';

const scratch = () => mkdtempSync(path.join(tmpdir(), 'newsy-datadir-'));

test('DATA_DIR outranks a stored choice', () => {
  // Load-bearing: test instances run with DATA_DIR pointed at a scratch folder,
  // and a stored override that won would aim them at the live database.
  const resolved = resolveDataDir('/tmp/from-env', { dataDir: '/tmp/from-file' }, '/app');
  assert.equal(resolved, path.resolve('/tmp/from-env'));
});

test('a stored choice is used when DATA_DIR is unset', () => {
  assert.equal(
    resolveDataDir(undefined, { dataDir: '/tmp/from-file' }, '/app'),
    path.resolve('/tmp/from-file'),
  );
});

test('with neither set it falls back to <root>/data', () => {
  assert.equal(resolveDataDir(undefined, {}, '/app'), path.join('/app', 'data'));
});

test('an empty DATA_DIR is treated as unset, not as a path', () => {
  assert.equal(resolveDataDir('', { dataDir: '/tmp/from-file' }, '/app'), path.resolve('/tmp/from-file'));
});

test('the current folder is rejected as a target', () => {
  assert.match(validateTarget('/data/newsy', '/data/newsy') ?? '', /already/i);
});

test('a folder inside the current one is rejected', () => {
  // Nesting the destination inside the source makes the move consume itself.
  assert.match(validateTarget('/data/newsy/inner', '/data/newsy') ?? '', /outside/i);
});

test('a sibling folder is accepted', () => {
  assert.equal(validateTarget('/data/newsy-2', '/data/newsy'), null);
});

test('blank input is rejected', () => {
  assert.match(validateTarget('   ', '/data/newsy') ?? '', /enter a folder/i);
  assert.match(validateTarget('', '/data/newsy') ?? '', /enter a folder/i);
});

test('blank input must be caught before it is resolved', () => {
  // path.resolve('') is the current working directory, so validating a
  // pre-resolved path accepts a blank field and silently points the database at
  // whatever folder the service happens to be running from. The route caught a
  // real bug here: validate the raw string, resolve afterwards.
  assert.equal(validateTarget(path.resolve(''), '/data/newsy'), null);
  assert.match(validateTarget('', '/data/newsy') ?? '', /enter a folder/i);
});

test('a path that is a file, not a folder, is rejected', () => {
  const dir = scratch();
  const file = path.join(dir, 'notafolder.txt');
  writeFileSync(file, 'x');
  assert.match(validateTarget(file, path.join(dir, 'data')) ?? '', /file, not a folder/i);
});

test('the stored location round-trips, and unreadable files read as empty', () => {
  const root = scratch();
  assert.deepEqual(readStoredLocation(root), {});
  writeStoredLocation(root, { dataDir: 'D:/NewsyData', moveFrom: 'C:/old' });
  assert.deepEqual(readStoredLocation(root), { dataDir: 'D:/NewsyData', moveFrom: 'C:/old' });

  writeFileSync(path.join(root, 'data-location.json'), '{ not json');
  assert.deepEqual(readStoredLocation(root), {});
});

test('moving carries Newsy files across and leaves everything else alone', () => {
  const root = scratch();
  const from = path.join(root, 'old');
  const to = path.join(root, 'new');
  mkdirSync(from, { recursive: true });
  writeFileSync(path.join(from, 'newsy.db'), 'database');
  writeFileSync(path.join(from, 'newsy.db-wal'), 'wal');
  writeFileSync(path.join(from, 'secrets.json'), '{}');
  writeFileSync(path.join(from, 'unrelated.txt'), 'not ours');

  const moved = moveDataFiles(from, to);

  assert.deepEqual(moved.sort(), ['newsy.db', 'newsy.db-wal', 'secrets.json']);
  assert.equal(readFileSync(path.join(to, 'newsy.db'), 'utf8'), 'database');
  // A folder the user also keeps other things in must survive the move.
  assert.equal(readFileSync(path.join(from, 'unrelated.txt'), 'utf8'), 'not ours');
});

test('moving tolerates a source with nothing in it', () => {
  const root = scratch();
  const from = path.join(root, 'empty');
  mkdirSync(from, { recursive: true });
  assert.deepEqual(moveDataFiles(from, path.join(root, 'dest')), []);
});
