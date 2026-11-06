/**
 * Chromium patch visibility.
 *
 * Chrome updates itself silently in the background; Electron is pinned in
 * package.json and only moves when someone runs `npm update`. That difference is
 * the single largest security gap between the reader and a real browser, so it
 * is surfaced rather than left to memory.
 *
 * This only ever reports. Updating unattended could land a breaking Electron
 * major on a shell nobody is watching.
 */

/** Compares dotted numeric versions; prerelease suffixes are ignored deliberately. */
export function isOlder(current, latest) {
  const parse = (v) => String(v).split('-')[0].split('.').map(Number);
  const a = parse(current);
  const b = parse(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Resolves to the newer version string, or null when current, unreachable or
 * unparseable. Never throws: an offline launch must not be a broken launch.
 */
export async function checkForUpdate(currentVersion) {
  try {
    const res = await fetch('https://registry.npmjs.org/electron/latest', {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const { version } = await res.json();
    if (typeof version !== 'string') return null;
    return isOlder(currentVersion, version) ? version : null;
  } catch {
    return null;
  }
}
