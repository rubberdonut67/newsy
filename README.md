# Newsy

Newsy continuously harvests news from across the internet, keeps a searchable
repository of everything it sees, and raises a desktop alert the moment an
article matches a topic you care about. You pick the keywords; it does the rest.

- **~60 curated sources** out of the box — wires, national press, business, tech,
  AI, science, sport — plus any RSS/Atom feed you add.
- **Google News per topic.** Every topic also becomes a live Google News query, so
  coverage follows the topic across the whole web rather than only your feed list.
- **Instant alerts, always on.** No switch to arm and nothing to remember: the
  desktop app raises a real Windows toast the moment a story matches, and goes on
  doing it with its window closed — closing the window returns Newsy to watching
  in the background rather than switching alerts off. The open dashboard also
  updates live over server-sent events.
- **A mute for when you need quiet.** The bell in the top bar silences the
  Windows pop-up for 30 minutes, two hours, until tomorrow morning, or until you
  turn it back on — from the dashboard or from the tray menu. Newsy keeps
  collecting and matching the whole time, so nothing is missed, only announced
  late. While it is muted it says so on the button, in the tray tooltip and in
  the log, because silence you cannot see is indistinguishable from a fault.
- **No API keys, no quotas.** Everything runs on public RSS.
- **Its own reader with strict blocking.** Articles open inside Newsy, with ads,
  trackers, cookie banners, newsletter pop-ups and scam sites blocked.

---

## Install on Windows

1. Download **`Newsy-Setup-<version>.exe`** from the
   [Releases page](https://github.com/rubberdonut67/newsy/releases/latest).
2. Run it. It installs for your Windows account only (no administrator rights)
   and opens Newsy when it finishes.
3. Click **New** to add your first topic. Alerts are already on.

**"Windows protected your PC"?** The installer is not code-signed, so SmartScreen
warns about it. Click **More info**, then **Run anyway**.

What you get:

- A **Newsy** icon on the desktop and in the Start menu.
- A **tray icon** (bottom-right, possibly behind the **^** arrow). Click it to open
  Newsy; right-click for *Check for news now*, *Mute alerts*, *Start Newsy when I
  sign in*, *View log* and *Quit Newsy*.
- Newsy **starts by itself when you sign in to Windows**, quietly in the tray, so
  alerts keep coming without a window in your way. Untick *Start Newsy when I sign
  in* in the tray menu to stop that.
- Closing the window does **not** stop alerts: Newsy keeps watching from the
  tray. *Quit Newsy* in the tray menu stops everything.
- Your topics and articles live in `%APPDATA%\Newsy\data`. Updating Newsy keeps
  them, and so does uninstalling.

**Updating:** when a newer version is released, Newsy shows a banner at the top of
its window. Click it, download the new installer and run it over the old one.

**Uninstalling:** *Settings > Apps > Installed apps > Newsy > Uninstall.* To also
delete your articles, remove `%APPDATA%\Newsy` afterwards.

The installed app only listens on this computer (`127.0.0.1`, port 47392). Nothing
on your network can reach it.

---

## Run from source

For developers. Everything below this point describes running Newsy from a clone
of this repository, which needs Node 24 or newer. The installed app does all of
this for you.

```bash
npm install
npm start
```

Open <http://localhost:3000> and click **New** to add a topic. Alerts arm
themselves — there is no button to press.
The first sweep takes about a minute and stores a few thousand articles; new
topics are immediately backfilled against everything already collected, so the
feed is never empty while you wait.

Run the tests with:

```bash
npm test
```

### Windows: `npm start` fails with "running scripts is disabled"

```
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running
scripts is disabled on this system.
```

Windows PowerShell defaults to a `Restricted` execution policy, which blocks
npm's `npm.ps1` shim. Nothing is wrong with Node or this project. Either call the
`.cmd` shim, which is not affected:

```bash
npm.cmd start
```

…or skip npm and run the entrypoint directly — this is exactly what `npm start` does:

```bash
node --disable-warning=ExperimentalWarning src/index.ts
```

To fix it properly for your account (Microsoft's recommended developer setting —
it still blocks unsigned scripts downloaded from the internet):

```bash
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Check what you currently have with `Get-ExecutionPolicy -List`; `Undefined`
everywhere means the `Restricted` default is in force. PowerShell 7 (`pwsh`) does
not have this problem.

## Running in the background

Newsy is a service, not a window you keep open. Install it once and it starts
itself at login with no console.

`newsy.cmd` lives in the project root and is **not** on your PATH, so call it
either by full path — which works from any directory — or from inside the project
folder as `.\newsy.cmd`. In PowerShell a quoted path needs the `&` call operator.
The examples assume the project is in `%USERPROFILE%\Apps\Newsy`; adjust the path
if you cloned it elsewhere:

```bash
& "$env:USERPROFILE\Apps\Newsy\newsy.cmd" install
```

| Command | What it does |
| --- | --- |
| `newsy.cmd install` | Start automatically at login, hidden, restarting if it crashes |
| `newsy.cmd uninstall` | Stop doing that, and stop it if running |
| `newsy.cmd start` / `stop` | Start or stop the service only |
| `newsy.cmd quit` | Shut down everything: service, app window and tray |
| `newsy.cmd status` | Whether it's running, and what it has collected |
| `newsy.cmd logs` | Last 40 log lines |
| `newsy.cmd open` | Open Newsy — service, tray and window, starting whichever is down |

To type just `newsy` from anywhere, add the project folder to your user PATH once:

```bash
[Environment]::SetEnvironmentVariable('PATH', $env:PATH + ";$env:USERPROFILE\Apps\Newsy", 'User')
```

Open a new terminal afterwards for it to take effect.

The scheduled task is deliberately configured to **keep running on battery** —
Windows stops tasks on battery by default, which would silently kill your alerts
on a laptop. It also waits 30 seconds after login so the network is up before the
first sweep, and restarts up to five times if the process dies.

With no console, all output goes to `data/newsy.log` (rotating at 5 MB, one
generation kept). `newsy logs` reads it.

These commands work regardless of your PowerShell execution policy — `newsy.cmd`
invokes PowerShell with `-ExecutionPolicy Bypass`, so nothing machine-wide has to
change.

## The tray icon

The tray icon starts alongside the service whenever Newsy does — at login, and
when you click the Newsy icon. To start it on its own:

```bash
newsy.cmd tray
```

It sits in the notification area showing a live unread count in its tooltip
(click the **^** arrow and drag Newsy onto the taskbar to keep it visible).
Double-click opens the app; right-click gives:

- **Open Newsy** — opens the app window, starting the service first if needed
- **Check for news now** — a full sweep of every source
- **Start / Stop background service** — whichever applies right now
- **View log**
- **Quit Newsy (stop everything)** — closes the app window, stops the service and
  removes the tray icon, in that order so the notification area never leaves a
  ghost icon behind. Newsy still returns at your next login; use
  `newsy.cmd uninstall` to stop that too.
- **Hide tray icon only** — hides the icon and leaves the service running. It
  deliberately does **not** stop collection, so dismissing an icon can never
  silently switch off your alerts.

Every one of these is scoped to **this project's directory**. A sibling project
using the same `src/index.ts` layout is never touched — matching on the script
path alone would kill unrelated apps.

The tray is a Windows Forms `NotifyIcon` driven by PowerShell — it ships with
Windows, so there is nothing to install and nothing to compile. It runs as its own
process, separate from the service, so if the tray ever dies news collection
carries on untouched.

## Its own window, not a browser tab

Newsy has its own desktop app, and that is what the desktop icon, the Start-menu
entry and the tray's **Open Newsy** all launch. It is a real standalone window —
no tabs, no address bar, its own taskbar button — and unlike a browser tab it
keeps your paid subscriptions signed in. See the next section.

**The older way still works, but it does not alert.** Newsy also runs as an
ordinary page at <http://localhost:3000>, and Chrome's **app mode** (`--app=`)
still gives it a standalone frame. Both show the feed live over SSE, and neither
raises a notification: Web Push was removed on 22 Aug 2026, so **the desktop app
is the thing that alerts you.** A browser tab is a viewer.

## The desktop app, and your subscriptions

Click the Newsy icon. To start it from a terminal instead:

```bash
npm run desktop
```

This opens Newsy in its own Electron window. It doesn't replace the service —
news collection still runs in the background exactly as before, and this is just
a window onto it. Two things it can do that a browser tab can't:

**Articles open inside Newsy.** Clicking a headline loads the page in Newsy's own
browser view, with a small back / reload / close strip on top, instead of
throwing you into Chrome. "Open in browser" is there when you want it.

**Publisher sign-in is switched off in 1.0.** Newsy has a *Subscriptions* feature
for staying signed in to the news sites you pay for, inside its own reader. It is
parked for the first release and will return in a later one; the code is still
here behind `PUBLISHER_SIGNIN` in `public/app.js` and `desktop/main.js`. When it
returns, the rule stays the same: Newsy never asks for, sees or stores a password,
only the session cookie a publisher hands back after you sign in on its own page.
There is no paywall bypass here and none is coming.

Run from source, the desktop app is wired into the desktop shortcut, the
Start-menu entry, the tray's **Open Newsy** and `newsy.cmd open` (or
`newsy.cmd desktop`). The installer packages the same app as `Newsy.exe`; see
[Building the installer](#building-the-installer).

### What protects you in there

The reader is Chromium, so it has the same sandbox and site isolation as Chrome.
On top of that Newsy adds the things Chrome normally gets from extensions:

- **Ads, trackers and scam domains are blocked** using 11 filter lists — EasyList,
  EasyPrivacy, the Fanboy annoyance/cookie lists, uBlock's own, plus malware and
  phishing. It is deliberately silent: no badge, no counter, nothing to configure.
  It either works or the page looks like the web used to.
- **Pop-up windows are blocked**, and you get a toast saying so.
- **Camera, microphone, location, notification and storage-access requests are
  refused outright.** (With publisher sign-in back on, `storage-access` and
  pop-ups are allowed for three minutes after clicking *Sign in*, because publisher
  logins need them.)
- **Downloads need confirmation**, and the dialog defaults to Cancel.

If a site misbehaves in the reader, a filter list is the likely culprit; use
*Open in browser* for that article.

Two honest gaps. Chrome silently updates itself to pick up Chromium security
fixes and Newsy can't — it checks on launch and shows a banner when a newer
Electron is out. The banner names the command to run. Note that `npm update
electron` is **not** it: the caret range in `package.json` stops `npm update`
crossing a major, and the banner only ever fires on a newer version, so the
obvious command silently changes nothing. Use `npm install --save-dev
electron@<version>`, then check that `node_modules/electron/dist/electron.exe`
actually appeared — npm has repeatedly updated the package metadata without
fetching the binary, which leaves the app unable to start. `node
node_modules/electron/install.js` fetches it.

And if every filter list fails to download on a cold start, the reader runs
unfiltered and says so only in the log, not on screen. In practice a cached
engine covers this, and the reader waits for the engine before opening a page.
That wait is capped at 60 seconds, after which the page loads unfiltered rather
than hanging forever — so the guarantee is "waits, then gives up loudly in the
log", not "never loads a page unprotected". A cold build measured 1.3s on this
machine, so the cap is far from being reached in normal use.

### For maintainers: the Developer tab

There is a diagnostics panel — engine state, filter-list count, Chromium version
— hidden behind **Ctrl+Shift+D** in the desktop app. It stays hidden otherwise,
and the setting sticks once you turn it on.

It is not a user feature and has no button anywhere, on purpose.

It also has **Where articles are stored** — the folder holding the database, log
and keys. Pick a new one (**Browse…** opens a normal folder picker) and choose
whether to bring the existing database with it. The change is applied by the
service the next time it starts, never while it is running: copying a live SQLite
file, with its `-wal` and `-shm`, is how a database gets corrupted. If the move
fails — usually because something still has the database open — Newsy keeps using
the old folder, says so, and retries on the next restart.

Setting `DATA_DIR` in the environment overrides this entirely; the section says so
rather than accepting a change that would be ignored.

## Opening it from an icon

`newsy.cmd install` creates a **Newsy** shortcut on your desktop and in the Start
menu. To create or recreate them without touching the scheduled task:

```bash
newsy.cmd shortcut
```

Clicking the icon starts **all three of Newsy's processes** — the background
service, the tray icon and the app window — starting whichever of them is not
already up and leaving the rest alone. It is the same thing logging in does, so
it works from a cold boot rather than only when Newsy happens to be running. No
console window appears at any point, and clicking twice does not give you two of
anything: the service is checked over HTTP first, the tray holds a named mutex,
and Electron holds a single-instance lock.

The icon art is `public/newsy.ico`, generated by `npm run icons` at six sizes
(16–256px) so it stays sharp on the taskbar and in Explorer.

## Install it as an app

**Reading only — installing does not give you alerts.** Installing used to matter
because it gave Web Push its own identity, so toasts read "Newsy" instead of
"Google Chrome". With Web Push gone there is no browser notification to label:
alerts come from the desktop app, which raises them itself. There is deliberately
no "Install app" button.

If you want the browser version in its own window anyway, install it from
Chrome's own menu: **⋮ → Cast, save and share → Install page as app…** You get a
Start-menu entry and a frame instead of a tab, and the same live feed over SSE.

Clicking the icon while the background service is stopped shows a short "Newsy
isn't running" page rather than a browser connection error — which is what the
service worker is still there for.

## Building the installer

```bash
npm install
npm run dist
```

This writes `dist/Newsy-Setup-<version>.exe` with
[electron-builder](https://www.electron.build/) (settings under `build` in
`package.json`; `build/installer.nsh` removes the sign-in entry on uninstall).
Bump `version` in `package.json` first: the installed app compares it with the
latest GitHub release to decide whether to show the update banner.

How the installed app differs from running from source:

- **One program.** `Newsy.exe` starts the service itself, using Electron's own
  Node to run `src/index.ts` (`ELECTRON_RUN_AS_NODE`), restarts it if it crashes,
  and draws the tray icon (`desktop/service.js`, `desktop/tray.js`). No scripts,
  no scheduled task, no separate Node install.
- **Data in `%APPDATA%\Newsy\data`**, via `NEWSY_HOME`, because the program folder
  is replaced on every update.
- **Port 47392 on 127.0.0.1**, not 3000, so it never collides with a development
  server or a from-source copy.
- **Starts at sign-in** through the per-user Run key (`--hidden`), on by default and
  switchable from the tray.
- **Notifications read "Newsy".** The installer's Start-menu shortcut carries the
  app's ID (`com.newsy.app`); running from source, toasts can still read "Electron".

`NEWSY_MANAGED=1 npm run desktop` runs the installed-app behaviour from source;
add `NEWSY_PROFILE=<folder>` to keep a test run off your real profile (it also
skips the tray icon and the sign-in entry).

**Build error "Cannot create symbolic link" (winCodeSign).** electron-builder's
signing-tools archive contains macOS symlinks that Windows will not create without
administrator rights or Developer Mode. Extract it by hand, ignoring those two
errors, into `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`,
then build again.

`scripts/move-to-installed.ps1 -Installer <path>` moves an existing from-source
setup onto the installed app, copying its data and leaving the original in place.

## Writing a topic query

| Syntax | Meaning | Example |
| --- | --- | --- |
| `a b` | both must appear | `tesla recall` |
| `"…"` | exact phrase | `"supply chain"` |
| `OR` or `\|` | alternatives | `nvidia OR amd` |
| `-term` | exclude | `climate -opinion` |
| `word*` | prefix match | `comput*` |

`OR` binds tighter than the implicit AND, so `ai chips nvidia OR amd` means
`ai AND chips AND (nvidia OR amd)`.

### Editing a topic

Hover a topic in the sidebar and click the **✎** pencil. You can change its name
and query, mute that one topic's alerts, turn off its Google News query, or **pause** it
entirely — a paused topic stops matching new articles and withdraws its Google
News feed, but keeps everything it has already collected.

Editing the query **re-evaluates your whole history in both directions**. Tighten
`claude` to `claude -obituary` and the obituaries already in your feed are
removed; widen it again and they come back. The toast reports what changed
("Saved — −85 no longer match"). Renaming or muting leaves matches untouched.

An invalid query is rejected before anything is written, so a typo cannot
clobber a working topic.

Note that articles re-added by widening a query return as **unread**, even if you
had read them before — the match rows were genuinely removed and recreated.

### Combining topics in the feed

Click a topic to view it. **Ctrl-click** additional topics to merge several into
one feed — the title becomes "Claude + Anthropic" and the URL carries the
selection (`/?topic=3,2`) so it can be bookmarked. Ctrl-click again to drop one.

An article matching more than one selected topic appears **once**, carrying a chip
for each topic that matched, and marking it read clears it under all of them.
"Mark all read" applies to whatever is currently selected.

Matching is case-insensitive and respects word boundaries — `ai` will not fire on
"said" or "Air France" — and terms containing punctuation (`covid-19`, `f-35`)
work as written. Use **Test** in the topic form to dry-run a query against the
articles already stored before you save it.

## How it works

```
 curated RSS feeds ─┐                                     ┌─▶ desktop shell ─▶ OS notification
                    ├─▶ poller ──▶ dedupe ──▶ matcher ──▶ SSE
 per-topic Google ──┘   (ETag/     (URL +     (topic         └─▶ open dashboard ─▶ live feed
 News RSS queries       304-aware)  headline)  queries)
```

- **`src/poller.ts`** wakes every 15s and fetches only the feeds that are due,
  six at a time. Conditional GETs mean an unchanged feed costs one 304.
- **`src/feeds/parse.ts`** normalizes RSS 2.0, RDF and Atom into one shape.
- **De-duplication** is two-layer: a normalized URL (tracking parameters stripped,
  Google News redirects unwrapped where possible) and a headline fingerprint, so
  the same wire story arriving from five outlets is stored once.
- **`src/matcher.ts`** compiles each topic query once and evaluates it against
  every new article's headline, summary and source.
- **Alert suppression.** Articles published before a topic existed, or older than
  `NOTIFY_MAX_AGE_HOURS`, are recorded as matches but never alerted on — adding a
  topic fills your feed without setting off a burst of notifications. Multiple
  matches for one topic in a single sweep collapse into one grouped notification.
- **Self-healing feeds.** A feed that fails is retried once immediately, then
  backed off; after `MAX_FEED_ERRORS` consecutive failures it is auto-disabled and
  flagged in the Sources tab with the underlying network error.

## Deploying

The poller must keep running for alerts to be instant, so run this as a single
always-on machine with a volume — not a scale-to-zero serverless function.

### Fly.io

```bash
fly launch --no-deploy
fly volumes create newsy_data --size 3
fly secrets set NEWSY_PASSWORD='a-strong-password' PUBLIC_URL='https://your-app.fly.dev'
fly deploy
```

`fly.toml` already sets `auto_stop_machines = false` and `min_machines_running = 1`
for exactly this reason.

### Anywhere with Docker

```bash
docker build -t newsy .
docker run -d --name newsy -p 8080:8080 -v newsy-data:/data \
  -e NEWSY_PASSWORD='a-strong-password' -e PUBLIC_URL='https://news.example.com' newsy
```

A remote deployment serves the dashboard, not alerts: notifications are raised by
the desktop shell against whichever origin it points at (`NEWSY_URL`), so a
hosted Newsy is something you read, and the machine you want alerts on is the one
that runs the shell.

### Configuration

Every setting has a working default; see [.env.example](.env.example). The ones
that matter:

| Variable | Purpose |
| --- | --- |
| `HOST` | Which network interfaces to answer on. Defaults to `127.0.0.1` — this machine only, which is what a desktop install needs. The `Dockerfile` and `fly.toml` set `0.0.0.0` (every interface) because a deployment must be reachable. If you set `0.0.0.0` yourself, set `NEWSY_PASSWORD` too; without it anything on your network can read and change Newsy. |
| `NEWSY_PASSWORD` | Password-gates the dashboard and API. **Set this before exposing Newsy to the internet** — without it the deployment is open to anyone. |
| `PUBLIC_URL` | Your public origin; used for links inside notifications. |
| `SESSION_SECRET` | Signs session cookies. Generated and persisted to `DATA_DIR/secrets.json` on first boot. Set it explicitly if your host has no volume, or every redeploy signs everyone out. |
| `NEWSY_URL` | Read by the **desktop shell** only: which Newsy the shell watches and alerts on. Defaults to `http://localhost:$PORT`. |
| `FEED_INTERVAL_SEC` / `GNEWS_INTERVAL_SEC` | How often sources are polled (300s / 180s). Lower means faster alerts and more requests. |
| `RETENTION_DAYS` | Articles that never matched a topic are pruned after this long (30 days). |
| `MATCH_RETENTION_DAYS` | Matched articles are pruned this long after their most recent match (182 days, about six months). |

## Notes and limits

- **Alert latency** is bounded by the polling interval: up to ~3 minutes for a
  topic's Google News query, ~5 for a curated feed. Lower the intervals to trade
  requests for speed.
- **Storage is SQLite on a local volume**, which means one machine. That is
  ample — polling 60 feeds costs a few requests a second and the database stays in
  the tens of megabytes — but it does not scale horizontally. Swapping in Postgres
  means rewriting `src/db.ts` and `src/store.ts`; nothing else touches SQL.
- **Google News redirect links** are opaque for recent articles, so some links
  route through `news.google.com` rather than the publisher. Headline-based
  de-duplication covers the gap where URL matching cannot.
- **Phones no longer get alerts.** Web Push was the only thing that ever reached
  one, and it was removed on 22 Aug 2026. Newsy alerts the machine running the
  desktop shell; a phone can still read the dashboard.
- Publishers occasionally retire RSS endpoints. Reuters, AP and Bloomberg already
  have, and are seeded here as site-scoped Google News queries instead.
