/*
 * Newsy service worker.
 *
 * It no longer has anything to do with notifications. Web Push was removed on
 * 22 Aug 2026 — alerts are raised by the desktop shell from the SSE stream, in a
 * process that is actually running when the window is not. What survives here is
 * the offline page below, which is the whole reason the worker is still
 * registered.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/**
 * Chrome will not offer to install the app without a fetch handler, and this one
 * earns its keep: Newsy runs as a background service, so clicking the app icon
 * while it is stopped would otherwise show a bare connection error. Explain what
 * happened instead.
 */
const OFFLINE_PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Newsy isn't running</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0b0d12;
         color:#e7eaf0; font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
  .card { max-width:30rem; padding:2rem; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 .5rem; }
  p { color:#99a2b3; margin:.5rem 0; }
  code { background:#1b202b; padding:.15rem .4rem; border-radius:4px; font-size:.9em; }
  button { margin-top:1.25rem; font:inherit; font-weight:600; color:#fff; background:#2f6bff;
           border:0; border-radius:9px; padding:.6rem 1.1rem; cursor:pointer; }
</style>
<div class="card">
  <h1>Newsy isn't running</h1>
  <p>The background service isn't responding, so there's nothing to show.</p>
  <p>Start it with <code>newsy start</code>, then reload.</p>
  <button onclick="location.reload()">Try again</button>
</div>`;

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(OFFLINE_PAGE, {
          status: 503,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    ),
  );
});

