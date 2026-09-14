/** Bad input: unknown command, bad flag value, missing file (exit code 2). */
export class UsageError extends Error {}

/** Missing Playwright or browser (exit code 3). The message carries the exact install command. */
export class EnvironmentError extends Error {}

/** Page-side error (missing hook, thrown load, timeout): exit code 4. */
export class PageError extends Error {}

/** The exit code of a failed command: 2 usage, 3 environment, 4 page error, timeout or anything unexpected. */
export function exitCodeFor(error: unknown): 2 | 3 | 4 {
  if (error instanceof UsageError) return 2;
  if (error instanceof EnvironmentError) return 3;
  return 4;
}
