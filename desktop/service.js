import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';

/**
 * Runs the Newsy service as a child of the installed app.
 *
 * Run from source, the service is its own program started by scripts and a
 * scheduled task, and the shell only connects to it. The installed app cannot
 * lean on any of that — a user who ran an installer has no Node, no scripts and
 * no scheduled task — so Newsy.exe starts the service itself, using its own
 * bundled Node (`ELECTRON_RUN_AS_NODE`), and keeps it alive.
 *
 * Three rules, each from a real failure mode:
 *
 * - **Adopt, don't duplicate.** If a Newsy service already answers on the port
 *   (say one left running by a shell that crashed), use it. A second copy would
 *   only die on EADDRINUSE.
 * - **Restart on crash, with backoff.** Polling is the app's whole job; a crash
 *   must not quietly end it. Backoff keeps a service that dies on startup from
 *   spinning the CPU.
 * - **Stopping is explicit.** Only "Stop background service" or Quit ends it, and
 *   those also stop a service this process adopted rather than spawned.
 */
export function createService({ entry, cwd, origin, env, stderrFile, log }) {
  let child = null;
  let stopping = false;
  let restartTimer = null;
  let failures = 0;
  let startedAt = 0;

  /** The health payload when a *Newsy* service answers, otherwise null. */
  async function health() {
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (!res.ok) return null;
      const body = await res.json();
      return body?.ok && body.app === 'newsy' ? body : null;
    } catch {
      return null;
    }
  }

  function spawnChild() {
    let errFd = 'ignore';
    try {
      // The service writes its own log; this only catches what it could not —
      // a crash on startup, before the logger exists.
      errFd = openSync(stderrFile, 'a');
    } catch {
      /* not fatal: a missing crash log is better than a missing service */
    }

    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
      cwd,
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', errFd],
      windowsHide: true,
    });
    if (typeof errFd === 'number') closeSync(errFd);
    startedAt = Date.now();
    log(`service started (pid ${child.pid})`);

    child.on('exit', (code, signal) => {
      log(`service exited (code ${code ?? '—'}${signal ? `, ${signal}` : ''})`);
      child = null;
      if (stopping) return;
      // A service that ran for a while and then died is a fresh failure, not the
      // next in a crash loop.
      if (Date.now() - startedAt > 60_000) failures = 0;
      failures += 1;
      const delay = Math.min(60_000, 2_000 * 2 ** (failures - 1));
      log(`restarting the service in ${Math.round(delay / 1000)}s`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        start();
      }, delay);
    });
  }

  async function start() {
    stopping = false;
    if (child) return 'running';
    if (await health()) {
      log('a Newsy service is already running — using it');
      return 'adopted';
    }
    spawnChild();
    return 'spawned';
  }

  async function stop() {
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    if (child) {
      const dying = child;
      await new Promise((resolve) => {
        dying.once('exit', resolve);
        dying.kill();
        setTimeout(resolve, 5_000);
      });
      return;
    }
    // Not ours, but still Newsy's: one left behind by an earlier shell.
    const found = await health();
    if (found?.pid) {
      try {
        process.kill(found.pid);
        log(`stopped the service this app had adopted (pid ${found.pid})`);
      } catch (err) {
        log(`could not stop service pid ${found.pid}: ${err.message}`);
      }
    }
  }

  /** Waits for the service to answer, for callers that need it up. */
  async function waitUntilUp(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await health()) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  return { start, stop, health, waitUntilUp, get running() { return Boolean(child); } };
}

/** Where the service's code lives relative to the shell. */
export const serviceEntry = (desktopDir) => path.join(desktopDir, '..', 'src', 'index.ts');
