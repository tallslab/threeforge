/**
 * Strict mode for the asset fetch scripts. `fetch-assets.mjs` and `fetch-kits.mjs` record a failed download as
 * `{ name, error }` in their index and keep going, so a developer on a flaky connection still gets everything that
 * did download. CI sets FORGE_FETCH_STRICT=1, which makes the fetch step exit 1 and name what failed: otherwise a
 * network failure surfaces steps later as something else — a corpus run with fewer assets, or a bench scene saying
 * `kenney-mini-characters kit not found`, which reads as a threeforge defect.
 */

/** `name: error` for every entry of `index` that records a failed download, in index order. Pure. */
export function downloadFailures(index) {
  const lines = [];
  for (const entry of Array.isArray(index) ? index : []) {
    if (typeof entry !== 'object' || entry === null || !('error' in entry)) continue;
    const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : '(unnamed)';
    const message = typeof entry.error === 'string' && entry.error !== '' ? entry.error : '(no message)';
    lines.push(`${name}: ${message}`);
  }
  return lines;
}

/**
 * The exit code a fetch script should end with: 1 under FORGE_FETCH_STRICT=1 when `index` records any failed
 * download (each is written through `write` first), otherwise 0. Without the flag it never fails and writes nothing.
 */
export function strictExitCode(index, env = process.env, write = (line) => console.error(line)) {
  if (env.FORGE_FETCH_STRICT !== '1') return 0;
  const failures = downloadFailures(index);
  if (failures.length === 0) return 0;
  write(
    `\nfetch: ${failures.length} download${failures.length === 1 ? '' : 's'} failed under FORGE_FETCH_STRICT=1 (unset it to keep what did download):`,
  );
  for (const line of failures) write(`  ${line}`);
  return 1;
}
