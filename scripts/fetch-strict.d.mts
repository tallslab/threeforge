/** `name: error` for every entry of `index` that records a failed download, in index order. Pure. */
export function downloadFailures(index: unknown): string[];

/**
 * The exit code a fetch script should end with: 1 under FORGE_FETCH_STRICT=1 when `index` records any failed
 * download (each is written through `write` first), otherwise 0. Without the flag it never fails and writes nothing.
 */
export function strictExitCode(
  index: unknown,
  env?: { FORGE_FETCH_STRICT?: string | undefined },
  write?: (line: string) => void,
): number;
