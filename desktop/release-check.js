import { isOlder } from './update-check.js';

/** The project's public releases. The installer for each version is attached there. */
export const RELEASES_API = 'https://api.github.com/repos/rubberdonut67/newsy/releases/latest';

/**
 * Tells the installed app whether a newer Newsy has been released.
 *
 * Reports only; it never downloads or installs anything. A user who ran an
 * installer has no other way to hear about fixes, and the reader's Chromium is
 * only as current as the Newsy release that shipped it.
 *
 * Resolves to `{ version, url }` or null. Never throws: an offline launch, a
 * rate-limited API or a repository with no releases yet all mean "no news".
 */
export async function checkForNewsyUpdate(currentVersion) {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Newsy' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const release = await res.json();
    if (release.draft || release.prerelease) return null;
    const version = String(release.tag_name ?? '').replace(/^v/, '');
    if (!/^\d+(\.\d+)*$/.test(version)) return null;
    if (!isOlder(currentVersion, version)) return null;
    return { version, url: String(release.html_url ?? 'https://github.com/rubberdonut67/newsy/releases') };
  } catch {
    return null;
  }
}
