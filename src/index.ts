import { config, dataMoveError, pendingMove } from './config.ts';
import { db } from './db.ts';
import { log } from './logger.ts';
import { startPoller, stopPoller } from './poller.ts';
import { buildServer } from './server.ts';
import { seedFeeds, seedPublishers, stats } from './store.ts';

const app = await buildServer();

seedFeeds();
seedPublishers();

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  // Running as a background task, the usual cause is a second copy already up.
  if ((err as { code?: string }).code === 'EADDRINUSE') {
    log.error(
      `Port ${config.port} is already in use — Newsy is probably running already. ` +
        `Check with "newsy status", or set PORT to use a different port.`,
    );
    process.exit(1);
  }
  throw err;
}

const summary = stats();
if (pendingMove) {
  log.info(
    `moved ${pendingMove.moved.length} data file(s) from ${pendingMove.from} to ${config.dataDir}`,
  );
}
if (dataMoveError) {
  log.warn(
    `could not move the data folder (${dataMoveError}) — still using ${config.dataDir}. ` +
      `Stop Newsy fully, then start it again to retry.`,
  );
}
log.info(`Newsy listening on ${config.publicUrl || `http://localhost:${config.port}`}`);
log.info(`data directory: ${config.dataDir}`);
log.info(
  `${summary.activeFeeds}/${summary.feeds} feeds active · ${summary.topics} topics · ${summary.articles} articles stored`,
);
// Only worth saying when someone else *can* reach the port. On the loopback
// default nothing outside this computer can connect, and warning anyway taught
// readers of the log to ignore the line that matters on a 0.0.0.0 deployment.
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
if (!config.password && !LOOPBACK.has(config.host)) {
  log.warn(
    `NEWSY_PASSWORD is unset and Newsy is listening on ${config.host} — the dashboard is open to anyone who can reach this port`,
  );
}

startPoller();

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    stopPoller();
    app.close().then(
      () => {
        db.close();
        process.exit(0);
      },
      () => process.exit(1),
    );
    // Do not let a stuck connection hold the process open forever.
    setTimeout(() => process.exit(1), 8_000).unref();
  });
}
