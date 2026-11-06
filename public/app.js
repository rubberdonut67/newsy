const $ = (sel) => document.querySelector(sel);

function topicsFromUrl() {
  const raw = new URLSearchParams(location.search).get('topic') ?? '';
  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
}

const state = {
  topics: [],
  matches: [],
  /** Empty means "Everything". More than one merges several topics into one feed. */
  selectedTopics: topicsFromUrl(),
  unreadOnly: false,
  view: 'feed',
  authEnabled: false,
  alerts: { muted: false, mutedUntil: null, scope: 'toasts' },
};

// --- Helpers ---------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Not authenticated');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pulls the positive terms out of a topic query so hits can be highlighted. */
function queryTerms(query) {
  const terms = [];
  const re = /(-)?"([^"]+)"|(-)?(\S+)/g;
  let m;
  while ((m = re.exec(query ?? ''))) {
    const negated = Boolean(m[1] || m[3]);
    const value = (m[2] ?? m[4] ?? '').replace(/\*$/, '');
    if (negated || !value) continue;
    if (/^(or|and)$/i.test(value) || value === '|') continue;
    terms.push(value);
  }
  return terms;
}

function highlight(text, terms) {
  const safe = escapeHtml(text);
  if (!terms.length) return safe;
  const pattern = terms
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  try {
    return safe.replace(new RegExp(`(?<![\\p{L}\\p{N}])(${pattern})`, 'giu'), '<mark>$1</mark>');
  } catch {
    return safe;
  }
}

function relTime(ts) {
  const mins = Math.round(Math.max(0, Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3600);
}

// --- Selection -------------------------------------------------------------

const isSelected = (id) => state.selectedTopics.includes(id);

function selectionLabel() {
  const names = state.selectedTopics
    .map((id) => state.topics.find((t) => t.id === id)?.name)
    .filter(Boolean);
  if (names.length === 0) return 'Everything';
  if (names.length <= 3) return names.join(' + ');
  return `${names.length} topics`;
}

function syncUrl() {
  const query = state.selectedTopics.length ? `/?topic=${state.selectedTopics.join(',')}` : '/';
  history.replaceState(null, '', query);
}

// --- Rendering -------------------------------------------------------------

function renderTopics() {
  const list = $('#topic-list');
  const total = state.topics.reduce((sum, t) => sum + (t.counts?.unread ?? 0), 0);

  const rows = [
    `<li class="${state.selectedTopics.length === 0 ? 'is-active' : ''}" data-topic="">
       <span class="name">Everything</span>
       <span class="count ${total ? 'is-unread' : ''}">${total}</span>
     </li>`,
  ];

  for (const topic of state.topics) {
    const unread = topic.counts?.unread ?? 0;
    const flags = [
      topic.enabled ? '' : '<span class="muted-dot" title="Paused">paused</span>',
      topic.notify ? '' : '<span class="muted-dot" title="Alerts muted">muted</span>',
    ].join('');
    rows.push(`
      <li class="${isSelected(topic.id) ? 'is-active' : ''} ${topic.enabled ? '' : 'is-paused'}"
          data-topic="${topic.id}" title="${escapeHtml(topic.query)}">
        <span class="name">${escapeHtml(topic.name)}</span>
        ${flags}
        <span class="count ${unread ? 'is-unread' : ''}">${unread || topic.counts?.total || 0}</span>
        <button class="row-btn" data-edit="${topic.id}" title="Edit topic">&#9998;</button>
        <button class="row-btn" data-delete="${topic.id}" title="Delete topic">&times;</button>
      </li>`);
  }

  list.innerHTML = rows.join('');
  document.title = total > 0 ? `(${total}) Newsy` : 'Newsy';
  $('#feed-title').textContent = selectionLabel();

  const hint = $('#combine-hint');
  if (hint) {
    hint.classList.toggle('hidden', state.topics.length < 2 || state.selectedTopics.length > 1);
  }
}

// --- Alert mute ------------------------------------------------------------
//
// A global mute on top of each topic's own `notify` flag. The switch lives here,
// the state lives in the service, and the Windows notification is suppressed in
// desktop/notifier.js — the only place one is raised. Muting does not stop
// Newsy collecting, matching or counting; the articles are all still here when
// you come back, they simply arrived quietly.

const MUTE_CHOICES = [
  { label: 'For 30 minutes', minutes: () => 30 },
  { label: 'For 2 hours', minutes: () => 120 },
  { label: 'Until tomorrow morning', minutes: minutesUntilTomorrowMorning },
  { label: 'Until I turn it back on', minutes: () => 0 },
];

function minutesUntilTomorrowMorning() {
  const wake = new Date();
  wake.setHours(8, 0, 0, 0);
  // Before 8am, "tomorrow morning" still means the next 8am to come, not one
  // more sleep than the user asked for.
  if (wake.getTime() <= Date.now()) wake.setDate(wake.getDate() + 1);
  return Math.max(1, Math.round((wake.getTime() - Date.now()) / 60_000));
}

/**
 * The deadline is evaluated here rather than trusted from the last message. A
 * dashboard left open across a mute's expiry must show it lapsed on its own.
 */
function isMuted() {
  const { muted, mutedUntil } = state.alerts;
  return Boolean(muted) && (mutedUntil === null || Date.now() < mutedUntil);
}

function muteRemaining(until) {
  const minutes = Math.round((until - Date.now()) / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

const clockTime = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function renderMute() {
  const muted = isMuted();
  const { mutedUntil, scope } = state.alerts;

  $('#btn-mute').classList.toggle('is-muted', muted);
  $('.mute-slash').classList.toggle('hidden', !muted);
  // Silence has to be visible, so a muted button carries a word as well as an
  // icon. This is the whole reason the alert path has no hidden states.
  $('#mute-label').textContent = muted
    ? mutedUntil === null
      ? 'Muted'
      : `Muted · ${muteRemaining(mutedUntil)}`
    : '';
  $('#btn-mute').title = muted ? 'Alerts are muted — click to change' : 'Mute alerts';

  $('#mute-status').textContent = muted
    ? mutedUntil === null
      ? 'Muted until you turn it back on.'
      : `Muted until ${clockTime(mutedUntil)}.`
    : 'Alerts are on. Newsy will notify you as articles match.';

  $('#mute-actions').innerHTML = muted
    ? '<button type="button" class="btn btn-small btn-primary" data-mute-off>Turn alerts back on</button>'
    : MUTE_CHOICES.map(
        (choice, i) =>
          `<button type="button" class="btn btn-small" data-mute-choice="${i}">${escapeHtml(choice.label)}</button>`,
      ).join('');

  for (const radio of document.querySelectorAll('input[name="mute-scope"]')) {
    radio.checked = radio.value === scope;
  }
}

async function patchMute(body) {
  state.alerts = await api('/api/alerts', { method: 'PATCH', body });
  renderMute();
}

function openMuteMenu(open) {
  $('#mute-menu').classList.toggle('hidden', !open);
  $('#btn-mute').setAttribute('aria-expanded', String(open));
}

$('#btn-mute').addEventListener('click', (event) => {
  event.stopPropagation();
  openMuteMenu($('#mute-menu').classList.contains('hidden'));
});

$('#mute-menu').addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', () => openMuteMenu(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') openMuteMenu(false);
});

$('#mute-menu').addEventListener('click', async (event) => {
  const off = event.target.closest('[data-mute-off]');
  const choice = event.target.closest('[data-mute-choice]');
  if (!off && !choice) return;

  if (off) {
    await patchMute({ muted: false });
    toast('Alerts are back on');
  } else {
    const picked = MUTE_CHOICES[Number(choice.dataset.muteChoice)];
    await patchMute({ muted: true, minutes: picked.minutes() });
    toast(
      state.alerts.mutedUntil === null
        ? 'Alerts muted until you turn them back on'
        : `Alerts muted until ${clockTime(state.alerts.mutedUntil)}`,
    );
  }
  openMuteMenu(false);
});

$('#mute-menu').addEventListener('change', async (event) => {
  if (event.target.name !== 'mute-scope') return;
  await patchMute({ scope: event.target.value });
});

// A countdown that only moves when the page is reloaded is a countdown nobody
// trusts, and this is also what lets an expired mute clear itself on a dashboard
// that has been sitting open.
setInterval(() => {
  if (state.alerts.muted) renderMute();
}, 30_000);

function renderStats(stats, poller) {
  $('#stats').innerHTML = `
    <span>Sources live</span><b>${stats.activeFeeds}/${stats.feeds}</b>
    <span>Articles stored</span><b>${stats.articles.toLocaleString()}</b>
    <span>Seen in 24h</span><b>${stats.articlesToday.toLocaleString()}</b>
    <span>Matches</span><b>${stats.matches.toLocaleString()}</b>
    <span>Last sweep</span><b>${poller.lastCycleAt ? relTime(poller.lastCycleAt) : '—'}</b>`;
}

function matchHtml(match) {
  // Highlight against every topic that matched this article.
  const terms = match.terms?.length
    ? match.terms
    : match.topics.flatMap((t) => queryTerms(state.topics.find((x) => x.id === t.id)?.query));

  const chips = match.topics
    .map((t) => `<span class="chip">${escapeHtml(t.name)}</span>`)
    .join('');
  const summary = match.summary ? `<p>${highlight(match.summary, terms)}</p>` : '';
  const image = match.image_url
    ? `<img src="${escapeHtml(match.image_url)}" alt="" loading="lazy" onerror="this.remove()" />`
    : '';

  return `
    <li class="match ${match.read_at ? '' : 'is-unread'}" data-article="${match.id}">
      <div class="body">
        <div class="meta">
          ${chips}
          <span>${escapeHtml(match.source || 'Unknown source')}</span>
          <span>·</span>
          <span>${relTime(match.published_at)}</span>
        </div>
        <h3>
          <a href="${escapeHtml(match.url)}" target="_blank" rel="noopener noreferrer">
            ${highlight(match.title, terms)}
          </a>
        </h3>
        ${summary}
      </div>
      ${image}
    </li>`;
}

function renderMatches() {
  const list = $('#matches');
  const empty = $('#empty');

  if (state.matches.length === 0) {
    list.innerHTML = '';
    empty.textContent = state.topics.length
      ? 'Nothing has matched yet. Newsy is sweeping your sources — new articles land here the moment they appear.'
      : 'Create a topic to start watching the news for it.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = state.matches.map(matchHtml).join('');
}

function renderFeeds(feeds) {
  $('#feed-list').innerHTML = feeds
    .map((feed) => {
      const failing = feed.error_count > 0;
      const status = feed.last_polled_at ? feed.last_status : 'not polled yet';
      return `
      <li class="${feed.enabled ? '' : 'is-off'}">
        <input type="checkbox" data-feed-toggle="${feed.id}" ${feed.enabled ? 'checked' : ''} />
        <div class="fname">
          ${escapeHtml(feed.title || feed.url)}
          <span>${escapeHtml(feed.url)}</span>
        </div>
        <span class="cat">${escapeHtml(feed.category)}</span>
        <span class="status ${failing ? 'bad' : ''}" title="${escapeHtml(status)}">
          ${escapeHtml(status.slice(0, 26))}
        </span>
        ${feed.kind === 'rss' ? `<button class="btn btn-small btn-ghost" data-feed-delete="${feed.id}">Remove</button>` : '<span class="cat">topic</span>'}
      </li>`;
    })
    .join('');
}

// --- Data ------------------------------------------------------------------

async function loadState() {
  const data = await api('/api/state');
  state.topics = data.topics;
  state.authEnabled = data.authEnabled;
  // Drop selections whose topic has since been deleted.
  const live = new Set(state.topics.map((t) => t.id));
  state.selectedTopics = state.selectedTopics.filter((id) => live.has(id));
  $('#btn-logout').classList.toggle('hidden', !data.authEnabled);
  if (data.alerts) state.alerts = data.alerts;
  renderTopics();
  renderStats(data.stats, data.poller);
  renderMute();
}

async function loadMatches() {
  const params = new URLSearchParams({ limit: '150' });
  if (state.selectedTopics.length) params.set('topic', state.selectedTopics.join(','));
  if (state.unreadOnly) params.set('unread', '1');
  state.matches = await api(`/api/matches?${params}`);
  renderMatches();
}

async function refreshAll() {
  await Promise.all([loadState(), loadMatches()]);
}

// --- Live stream -----------------------------------------------------------

function setLive(status, label) {
  const el = $('#live');
  el.className = `live ${status}`;
  el.innerHTML = `<i></i>${label}`;
}

let backoff = 1000;
function connectStream() {
  const source = new EventSource('/api/events');

  source.onopen = () => {
    backoff = 1000;
    setLive('is-live', 'live');
  };

  source.addEventListener('matches', (event) => {
    const incoming = JSON.parse(event.data);
    const visible = incoming.filter(
      (m) => state.selectedTopics.length === 0 || m.topics.some((t) => isSelected(t.id)),
    );

    const fresh = [];
    for (const row of visible) {
      // The same article can arrive under two selected topics; merge rather
      // than showing it twice.
      const existing = state.matches.find((m) => m.id === row.id);
      if (existing) {
        for (const topic of row.topics) {
          if (!existing.topics.some((t) => t.id === topic.id)) existing.topics.push(topic);
        }
        existing.match_ids.push(...row.match_ids);
        existing.read_at = null;
      } else {
        fresh.push(row);
      }
    }

    if (visible.length) {
      state.matches = [...fresh, ...state.matches];
      renderMatches();
      for (const m of visible) $(`[data-article="${m.id}"]`)?.classList.add('is-new');
    }

    toast(
      incoming.length === 1
        ? `New: ${incoming[0].title.slice(0, 60)}`
        : `${incoming.length} new matching articles`,
    );
    loadState();
  });

  // The tray can mute too, and the poller announces a timed mute lapsing. Either
  // way the header must not be the last thing to find out.
  source.addEventListener('alerts', (event) => {
    state.alerts = JSON.parse(event.data);
    renderMute();
  });

  source.addEventListener('cycle', () => setLive('is-live', 'live'));

  source.onerror = () => {
    setLive('is-down', 'reconnecting');
    source.close();
    backoff = Math.min(backoff * 2, 30000);
    setTimeout(connectStream, backoff);
  };
}

// --- Install as an app ------------------------------------------------------
//
// Removed 21 Aug 2026. The "Install app" button existed for one reason: a
// notification raised from a browser tab is attributed to the browser, so alerts
// read "Google Chrome", and installing as a PWA gave Newsy its own identity.
//
// The desktop shell solves that properly — it raises notifications itself and
// never touches Web Push. Worse, offering the install inside the shell was a
// route to a *second* Newsy with its own push subscription, which is exactly the
// duplicate-alert problem that was cleaned up by removing a desktop push device.
//
// The manifest and service worker are still served, so anyone who genuinely
// wants a PWA can install from Chrome's own menu. Newsy just no longer suggests
// it.

// --- Alerts -----------------------------------------------------------------
//
// Web Push was removed on 22 Aug 2026, and with it the whole notion of this page
// arming anything. Alerts belong to the desktop shell, which holds the SSE
// stream in its main process and raises OS notifications directly — no VAPID
// key, no service worker, no subscription to rotate or silently lose.
//
// The consequence worth stating plainly: **this page open in a browser tab does
// not produce notifications.** It never really did on its own; it delegated to a
// push service. Newsy's own window is the alerting surface now.

// --- Events ----------------------------------------------------------------

$('#topic-list').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-edit]');
  if (edit) {
    // Do not let the click fall through and change the feed selection too.
    event.stopPropagation();
    const topic = state.topics.find((t) => t.id === Number(edit.dataset.edit));
    if (topic) openTopicForm(topic);
    return;
  }

  const del = event.target.closest('[data-delete]');
  if (del) {
    event.stopPropagation();
    const id = Number(del.dataset.delete);
    const topic = state.topics.find((t) => t.id === id);
    if (!confirm(`Delete "${topic?.name}"? Its matched articles will be removed too.`)) return;
    await api(`/api/topics/${id}`, { method: 'DELETE' });
    state.selectedTopics = state.selectedTopics.filter((t) => t !== id);
    await refreshAll();
    return;
  }

  const row = event.target.closest('[data-topic]');
  if (!row) return;

  const id = row.dataset.topic ? Number(row.dataset.topic) : null;
  const additive = event.ctrlKey || event.metaKey || event.shiftKey;

  if (id === null) {
    state.selectedTopics = []; // "Everything"
  } else if (additive) {
    state.selectedTopics = isSelected(id)
      ? state.selectedTopics.filter((t) => t !== id)
      : [...state.selectedTopics, id];
  } else {
    state.selectedTopics = [id];
  }

  syncUrl();
  renderTopics();
  await loadMatches();
});

$('#matches').addEventListener('click', async (event) => {
  const row = event.target.closest('[data-article]');
  if (!row || !event.target.closest('a')) return;
  const articleId = Number(row.dataset.article);
  const match = state.matches.find((m) => m.id === articleId);
  if (!match) return;

  row.classList.remove('is-unread');
  match.read_at = Date.now();
  // Clear every underlying match, so an article shared by two topics does not
  // stay unread under the other one.
  await api('/api/matches/read', { method: 'POST', body: { ids: match.match_ids } });
  loadState();
});

$('#btn-read-all').addEventListener('click', async () => {
  await api('/api/matches/read', {
    method: 'POST',
    body: { all: true, topicIds: state.selectedTopics },
  });
  await refreshAll();
});

$('#filter-unread').addEventListener('change', (event) => {
  state.unreadOnly = event.target.checked;
  loadMatches();
});

$('#btn-refresh').addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Sweeping…';
  try {
    const res = await api('/api/refresh', { method: 'POST' });
    toast(res.matches ? `${res.matches} new match(es)` : 'No new matches');
    await refreshAll();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
});


$('#btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/login';
});

/**
 * One form serves both creating and editing. `topic` undefined means create.
 */
function openTopicForm(topic) {
  const form = $('#topic-form');
  state.editing = topic?.id ?? null;

  form.reset();
  form.name.value = topic?.name ?? '';
  form.query.value = topic?.query ?? '';
  form.notify.checked = topic ? Boolean(topic.notify) : true;
  form.useGnews.checked = topic ? Boolean(topic.use_gnews) : true;
  form.enabled.checked = topic ? Boolean(topic.enabled) : true;

  $('#form-title').textContent = topic ? `Edit “${topic.name}”` : 'New topic';
  $('#btn-save-topic').textContent = topic ? 'Save' : 'Create';
  // Pausing only makes sense for a topic that already exists.
  $('#row-enabled').classList.toggle('hidden', !topic);

  form.classList.remove('hidden');
  $('#preview').classList.add('hidden');
  $('#topic-error').classList.add('hidden');
  (topic ? form.query : form.query).focus();
}

function closeTopicForm() {
  state.editing = null;
  $('#topic-form').reset();
  $('#topic-form').classList.add('hidden');
  $('#preview').classList.add('hidden');
  $('#topic-error').classList.add('hidden');
}

$('#btn-new-topic').addEventListener('click', () => openTopicForm());
$('#btn-cancel-topic').addEventListener('click', closeTopicForm);

$('#btn-preview').addEventListener('click', async () => {
  const query = $('#topic-form textarea[name="query"]').value.trim();
  const box = $('#preview');
  if (!query) return;
  try {
    const result = await api('/api/topics/preview', { method: 'POST', body: { query } });
    const items = result.hits
      .map((h) => `<li>${escapeHtml(h.title)} <em>— ${escapeHtml(h.source)}</em></li>`)
      .join('');
    box.innerHTML = result.hits.length
      ? `<b>${result.hits.length} hit(s) in the last ${result.sampleSize} stored articles</b><ul>${items}</ul>`
      : `<b>No hits among the last ${result.sampleSize} stored articles</b>
         <p class="hint">That is fine for a rare topic — Google News will still be queried for it.</p>`;
    box.classList.remove('hidden');
    $('#topic-error').classList.add('hidden');
  } catch (err) {
    $('#topic-error').textContent = err.message;
    $('#topic-error').classList.remove('hidden');
  }
});

$('#topic-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const editingId = state.editing;

  const body = {
    name: data.get('name'),
    query: data.get('query'),
    notify: data.get('notify') === 'on',
    useGnews: data.get('useGnews') === 'on',
  };

  try {
    if (editingId) {
      const res = await api(`/api/topics/${editingId}`, {
        method: 'PATCH',
        body: { ...body, enabled: data.get('enabled') === 'on' },
      });
      // Editing a query re-evaluates history in both directions; say what happened.
      const parts = [];
      if (res.added) parts.push(`+${res.added} added`);
      if (res.removed) parts.push(`−${res.removed} no longer match`);
      toast(parts.length ? `Saved — ${parts.join(', ')}` : 'Saved');
    } else {
      await api('/api/topics', { method: 'POST', body });
      toast('Topic created — searching now');
    }
    closeTopicForm();
    await refreshAll();
  } catch (err) {
    $('#topic-error').textContent = err.message;
    $('#topic-error').classList.remove('hidden');
  }
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', async () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    state.view = tab.dataset.view;
    $('#view-feed').classList.toggle('hidden', state.view !== 'feed');
    $('#view-sources').classList.toggle('hidden', state.view !== 'sources');
    $('#view-subs').classList.toggle('hidden', state.view !== 'subs');
    $('#view-dev').classList.toggle('hidden', state.view !== 'dev');
    if (state.view === 'sources') renderFeeds(await api('/api/feeds'));
    if (state.view === 'subs') await renderSubs();
    if (state.view === 'dev') await renderDev();
  });
});

$('#feed-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = event.currentTarget.querySelector('input[name="url"]');
  try {
    await api('/api/feeds', { method: 'POST', body: { url: input.value.trim() } });
    input.value = '';
    $('#feed-error').classList.add('hidden');
    renderFeeds(await api('/api/feeds'));
    toast('Feed added');
  } catch (err) {
    $('#feed-error').textContent = err.message;
    $('#feed-error').classList.remove('hidden');
  }
});

$('#feed-list').addEventListener('click', async (event) => {
  const toggle = event.target.closest('[data-feed-toggle]');
  if (toggle) {
    await api(`/api/feeds/${toggle.dataset.feedToggle}`, {
      method: 'PATCH',
      body: { enabled: toggle.checked },
    });
    renderFeeds(await api('/api/feeds'));
    return;
  }
  const remove = event.target.closest('[data-feed-delete]');
  if (remove) {
    await api(`/api/feeds/${remove.dataset.feedDelete}`, { method: 'DELETE' });
    renderFeeds(await api('/api/feeds'));
  }
});

// Keep relative timestamps honest without re-fetching.
setInterval(() => {
  if (state.view === 'feed' && state.matches.length) renderMatches();
}, 60_000);

// --- Desktop shell ---------------------------------------------------------

/**
 * `window.newsy` is injected by the Electron preload and is simply absent in a
 * browser tab. Everything below is therefore additive: without the shell the
 * dashboard behaves exactly as it always has, opening links in the browser.
 */
const shell = window.newsy?.desktop ? window.newsy : null;

/** Publishers as last loaded, so click handlers can resolve one without a round trip. */
let publishers = [];

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function renderSubs() {
  if (!shell) return;
  publishers = await api('/api/publishers');
  // Sessions live in the shell's cookie jar rather than the database, so status
  // is asked for per-domain here instead of being joined server-side.
  const statuses = await Promise.all(publishers.map((p) => shell.sessions.status(p.domain)));

  // The database owns which sites are exempt; the blocker needs telling each time.
  shell.security.syncAllowlist(
    publishers.filter((p) => !p.blocking_enabled).map((p) => p.domain),
  );

  $('#sub-list').innerHTML = publishers
    .map((publisher, i) => {
      const status = statuses[i];
      const until = status.expiresAt
        ? ` · until ${new Date(status.expiresAt).toLocaleDateString()}`
        : '';
      return `
      <li class="${status.signedIn ? '' : 'is-off'}">
        <div class="fname">
          ${escapeHtml(publisher.name)}
          <span>${escapeHtml(publisher.domain)}</span>
        </div>
        <span class="status ${status.signedIn ? '' : 'bad'}">
          ${status.signedIn ? `Signed in${escapeHtml(until)}` : 'Not signed in'}
        </span>
        <button
          class="btn btn-small ${status.signedIn ? 'btn-ghost' : 'btn-primary'}"
          data-sub-id="${publisher.id}"
          data-sub-action="login"
        >${status.signedIn ? 'Re-sign in' : 'Sign in'}</button>
        ${
          status.signedIn
            ? `<button class="btn btn-small btn-ghost" data-sub-id="${publisher.id}" data-sub-action="signout">Sign out</button>`
            : ''
        }
        <label class="sub-block" title="Ad and tracker blocking for this site. Turn off only if it breaks the login.">
          <input type="checkbox" data-sub-block="${publisher.id}" ${publisher.blocking_enabled ? 'checked' : ''} />
          Block ads
        </label>
        <button class="btn btn-small btn-ghost" data-sub-id="${publisher.id}" data-sub-action="delete">Remove</button>
      </li>`;
    })
    .join('');
}

const ago = (ts) => (ts ? relTime(ts) : 'never');

/**
 * Diagnostics. Deliberately the only place blocking is visible: on a normal page
 * the whole point is that you notice nothing.
 */
async function renderDev() {
  if (!shell) return;
  const s = await shell.security.status();
  const live = await api('/api/state');
  const mute = live.alerts ?? { muted: false, mutedUntil: null, scope: 'toasts' };
  const rows = [
    // The two silences, side by side. "Muted" is a choice; zero listeners is the
    // alert path being broken, and for one day nothing on screen told them apart.
    [
      'Alerts',
      mute.muted
        ? `muted ${mute.mutedUntil === null ? 'indefinitely' : `until ${new Date(mute.mutedUntil).toLocaleString()}`} (${mute.scope === 'all' ? 'toasts and tray' : 'toasts only'})`
        : 'on',
    ],
    ['Alert listeners', live.poller.streams],
    // Two different questions, and conflating them is confusing: "Blocking" is
    // whether the engine is attached to the reader session at all, "This page"
    // is whether it is actually filtering the site currently open — a publisher
    // exempted via the Block ads toggle reads active-but-off.
    ['Blocking', s.ready ? 'active' : 'not attached yet'],
    ['This page', s.ready ? (s.blockingThisPage ? 'filtered' : 'exempted by you') : '—'],
    // A zero count means the engine came from a cache that predates the sidecar
    // recording it — not that no lists loaded.
    ['Filter lists', s.lists ? `${s.lists}/${s.listsConfigured} loaded` : 'cached, count unrecorded'],
    ['Engine built', s.builtAt ? ago(s.builtAt) : 'unrecorded'],
    ['Blocked — this page', s.pageBlocked],
    ['Blocked — this session', s.sessionBlocked],
    ['Electron', s.electron],
    ['Chromium', s.chrome],
    ['Node', s.node],
    ['Session partition', s.partition],
    ['Server origin', s.origin],
  ];
  $('#dev-stats').innerHTML = rows
    .map(
      ([key, value]) =>
        `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd></div>`,
    )
    .join('');

  // A service older than this dashboard has no /api/data-location. That is not a
  // reason for the rest of the panel to disappear, so this section degrades on
  // its own instead of taking the whole tab down.
  try {
    await renderDataLocation();
  } catch (err) {
    $('#dev-store').innerHTML =
      `<div><dt>Unavailable</dt><dd>${escapeHtml(err.message)}</dd></div>`;
    for (const id of ['#data-dir-input', '#data-dir-move', '#btn-data-dir-save', '#btn-data-dir-browse']) {
      $(id).disabled = true;
    }
    const note = $('#data-dir-note');
    note.textContent = 'Restart the Newsy service to enable this section.';
    note.classList.remove('hidden');
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/**
 * Where the database physically lives, and the control to move it.
 *
 * The change is applied by the service at its next start, not here: moving a
 * live SQLite file (and its -wal and -shm) out from under an open connection
 * loses data. So this only records the intent.
 */
async function renderDataLocation() {
  const info = await api('/api/data-location');

  const rows = [
    ['Folder', info.current],
    ['Size on disk', formatBytes(info.bytes)],
    ['Default', info.default],
  ];
  if (info.pendingMoveFrom) rows.push(['Pending move from', info.pendingMoveFrom]);
  if (info.locked) rows.push(['Overridden by', 'DATA_DIR environment variable']);

  $('#dev-store').innerHTML = rows
    .map(
      ([key, value]) =>
        `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd></div>`,
    )
    .join('');

  const input = $('#data-dir-input');
  if (document.activeElement !== input) input.value = info.chosen || info.current;

  // With DATA_DIR set, anything saved here would be silently ignored, so the
  // form says why instead of pretending to work.
  const locked = Boolean(info.locked);
  input.disabled = locked;
  $('#data-dir-move').disabled = locked;
  $('#btn-data-dir-save').disabled = locked;
  $('#btn-data-dir-browse').disabled = locked || !shell;

  const note = $('#data-dir-note');
  if (info.moveError) {
    // The service kept running from the old folder — say so, rather than
    // leaving the failure only in the log.
    note.textContent = `The last move failed (${info.moveError}). Newsy is still using the folder above. Quit Newsy completely, then start it again to retry.`;
    note.classList.remove('hidden');
  } else if (locked) {
    note.textContent =
      'DATA_DIR is set in this process’s environment and takes precedence. Unset it to choose a folder here.';
    note.classList.remove('hidden');
  } else if (info.pendingMoveFrom) {
    note.textContent = 'A move is queued. Restart the Newsy service to apply it.';
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }
}


/**
 * The Developer tab is a maintainer's panel — blocking internals, engine and
 * Chromium versions, registered push devices — and means nothing to someone who
 * just wants to read the news. So it is **not** revealed merely by running the
 * desktop shell: it stays hidden until deliberately summoned with Ctrl+Shift+D.
 *
 * Undiscoverable on purpose, not just tucked away. There is no menu entry and no
 * hint in the UI, because the panel's Remove buttons delete push devices — a
 * general user wandering in could switch off their own phone's alerts and have
 * no idea what they had done.
 *
 * The choice persists, so a developer sets it once per machine rather than
 * re-summoning it on every launch.
 */
const DEV_MODE_KEY = 'newsy:dev-mode';

function devModeOn() {
  try {
    return localStorage.getItem(DEV_MODE_KEY) === '1';
  } catch {
    // Storage can throw when it is disabled or full. Failing closed keeps the
    // tab hidden, which is the safe direction.
    return false;
  }
}

function setDevMode(on) {
  try {
    if (on) localStorage.setItem(DEV_MODE_KEY, '1');
    else localStorage.removeItem(DEV_MODE_KEY);
  } catch {
    // Non-fatal: the tab still toggles for this session, it just will not stick.
  }

  $('#tab-dev').classList.toggle('hidden', !on);

  // Hiding the tab while its panel is open would strand the user in a view with
  // no tab left to navigate away from.
  if (!on && state.view === 'dev') document.querySelector('.tab[data-view="feed"]').click();
}

/**
 * Publisher sign-in is switched off for the first public release (Nov 2026) and
 * will come back later, so it is parked behind this flag rather than deleted.
 * The registry, the session code and the tab all still exist; with the flag off
 * nothing reveals the tab, and the shell refuses to open a sign-in window.
 */
const PUBLISHER_SIGNIN = false;

if (shell) {
  if (PUBLISHER_SIGNIN) $('#tab-subs').classList.remove('hidden');
  else {
    // Exemptions a user set before the tab was parked must keep applying — the
    // blocker only learns them from this sync, which used to run on tab render.
    api('/api/publishers')
      .then((list) =>
        shell.security.syncAllowlist(list.filter((p) => !p.blocking_enabled).map((p) => p.domain)),
      )
      .catch(() => {});
  }
  setDevMode(devModeOn());
  $('#btn-dev-refresh').addEventListener('click', renderDev);

  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
    if (typeof event.key !== 'string' || event.key.toLowerCase() !== 'd') return;
    event.preventDefault();
    const on = !devModeOn();
    setDevMode(on);
    toast(on ? 'Developer tab shown' : 'Developer tab hidden');
  });

  $('#btn-data-dir-browse').addEventListener('click', async () => {
    const chosen = await shell.chooseFolder($('#data-dir-input').value);
    if (chosen) $('#data-dir-input').value = chosen;
  });

  $('#data-dir-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#data-dir-error');
    error.classList.add('hidden');
    try {
      const result = await api('/api/data-location', {
        method: 'POST',
        body: { path: $('#data-dir-input').value.trim(), move: $('#data-dir-move').checked },
      });
      toast(
        result.willMove
          ? 'Saved — data moves on the next service restart'
          : 'Saved — takes effect on the next service restart',
      );
      await renderDataLocation();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  });

  /**
   * Outbound links open in Newsy's own browser view, carrying whatever publisher
   * sessions have been signed into. Same-origin navigation is left alone so the
   * dashboard's own links keep working.
   */
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    if (!/^https?:/i.test(link.href)) return;
    if (hostLabel(link.href) === hostLabel(location.href)) return;
    event.preventDefault();
    shell.reader.open(link.href);
  });

  shell.reader.onState((reader) => {
    document.body.classList.toggle('is-reading', reader.open);
    $('#reader-bar').classList.toggle('hidden', !reader.open);
    if (reader.open) {
      $('#reader-title').textContent = reader.loading && !reader.title ? 'Loading…' : reader.title;
      $('#reader-host').textContent = hostLabel(reader.url);
      $('#reader-back').disabled = !reader.canGoBack;
    } else if (state.view === 'subs') {
      // Closing the reader is the moment a just-completed sign-in becomes visible.
      renderSubs();
    }
  });

  /**
   * Blocked pop-ups are announced. A page that silently fails to open a window
   * looks broken, and the user should be able to tell the difference between
   * "Newsy stopped that" and "this site is buggy".
   */
  shell.security.onPopupBlocked(({ url }) => {
    let host = 'a site';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* keep the generic label */
    }
    toast(`Blocked a pop-up from ${host}`);
  });

  /**
   * Name the command that actually works. `npm update electron` respects the
   * caret range in package.json, so it can never cross a major boundary -- and
   * when the newer version is a major, as 44 was to 43, the obvious advice
   * changed nothing and the banner came back every launch.
   */
  shell.security.onUpdateAvailable(({ latest }) => {
    const banner = $('#security-banner');
    banner.textContent = `Electron ${latest} is available — run "npm install --save-dev electron@${latest}" to pick up the latest Chromium security fixes.`;
    banner.classList.remove('hidden');
  });

  // Installed app only. Clicking the banner opens the release page in the
  // user's own browser, where the new installer is.
  shell.updates?.onAvailable(({ version, url }) => {
    const banner = $('#security-banner');
    banner.textContent = `Newsy ${version} is available — click here to download it.`;
    banner.style.cursor = 'pointer';
    banner.onclick = () => shell.updates.openRelease(url);
    banner.classList.remove('hidden');
  });

  $('#reader-back').addEventListener('click', () => shell.reader.back());
  $('#reader-reload').addEventListener('click', () => shell.reader.reload());
  $('#reader-external').addEventListener('click', () => shell.reader.openExternal());
  $('#reader-close').addEventListener('click', () => shell.reader.close());

  $('#sub-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = event.currentTarget.querySelector('input[name="url"]');
    try {
      await api('/api/publishers', { method: 'POST', body: { url: input.value.trim() } });
      input.value = '';
      $('#sub-error').classList.add('hidden');
      await renderSubs();
      toast('Site added');
    } catch (err) {
      $('#sub-error').textContent = err.message;
      $('#sub-error').classList.remove('hidden');
    }
  });

  $('#sub-list').addEventListener('change', async (event) => {
    const toggle = event.target.closest('[data-sub-block]');
    if (!toggle) return;
    await api(`/api/publishers/${toggle.dataset.subBlock}`, {
      method: 'PATCH',
      body: { blockingEnabled: toggle.checked },
    });
    await renderSubs();
    toast(toggle.checked ? 'Blocking on for this site' : 'Blocking off for this site');
  });

  $('#sub-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-sub-action]');
    if (!button) return;
    const publisher = publishers.find((p) => p.id === Number(button.dataset.subId));
    if (!publisher) return;

    if (button.dataset.subAction === 'login') {
      // Opens the only window in which pop-ups are permitted — publisher auth
      // routinely runs through one, and it closes again a few minutes later.
      await shell.sessions.beginSignin();
      shell.reader.open(publisher.login_url || `https://${publisher.domain}`);
      return;
    }
    if (button.dataset.subAction === 'signout') {
      await shell.sessions.clear(publisher.domain);
      toast(`Signed out of ${publisher.name}`);
    } else {
      await api(`/api/publishers/${publisher.id}`, { method: 'DELETE' });
    }
    await renderSubs();
  });
}

// --- Boot ------------------------------------------------------------------

await refreshAll();
connectStream();

// The worker no longer has anything to do with alerts, and still earns its
// place: its fetch handler serves the friendly "Newsy isn't running" page
// instead of a connection error when the service is stopped, and it keeps a
// manual PWA install working from Chrome's own menu.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}
