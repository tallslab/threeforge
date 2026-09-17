export interface CommitRecord {
  sha: string;
  subject: string;
  message: string;
  files: string[];
}
export interface BudgetViolation {
  sha: string;
  subject: string;
  files: string[];
  problem: string;
}
export type BudgetDeclaration =
  | { kind: 'count'; value: number; line: string }
  | { kind: 'n/a'; reason: string; line: string };

/** Rendering paths: an entry ending in `/` matches its whole directory, any other entry that one file exactly. */
export const RENDERING_PATHS: readonly string[];
/** The top-level `src/` entries that are deliberately not rendering, each mapped to the reason. */
export const EXCLUDED_PATHS: Readonly<Record<string, string>>;
/** The subset of `files` that lies under a rendering path (or is a listed rendering file), in the order given. */
export function touchesRendering(files: readonly string[]): string[];
/** The budget a commit message declares on a body line, or `null` when absent or malformed. */
export function budgetDeclaration(message: string): BudgetDeclaration | null;
/** Every commit that touches rendering without a usable declaration. */
export function checkCommits(commits: readonly CommitRecord[]): BudgetViolation[];
/** Reads `range` out of the repository in `cwd`, merges excluded. */
export function readCommits(range: string, cwd?: string): CommitRecord[];
/** What a push event sends as `before` when it created the ref. */
export const ZERO_SHA: string;
/** The three git questions `pushRange` asks, injectable so both paths are testable without a remote. */
export interface PushRangeGit {
  has(sha: string): boolean;
  isAncestor(a: string, b: string): boolean;
  mergeBase(a: string, b: string): string;
}
/** The range a push is judged over: `range` is null when there is none, and `reason` is null on the plain path. */
export interface PushRangeResult {
  range: string | null;
  reason: string | null;
}
/** The commits a push adds: before..after when it fast-forwarded, else the merge-base with the default ref. */
export function pushRange(
  event: { before: string; after: string; defaultRef?: string },
  git: PushRangeGit,
): PushRangeResult;
/** `pushRange`'s queries against a real repository; each answers instead of throwing. */
export function gitQueries(cwd?: string): PushRangeGit;
/** Runs the check; returns the process exit code (0 ok, 1 violations, 2 usage). `argv` may be `--push <before> <after>`. */
export function main(argv: readonly string[], cwd?: string, git?: PushRangeGit | null): number;
