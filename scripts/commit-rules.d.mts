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
/** One entry of the exemption allow-list: when it was decided, and why. */
export interface CommitExemption {
  date: string;
  reason: string;
}
/** A commit the allow-list excused, reported so an exemption is never silent. */
export interface ExemptedCommit extends CommitExemption {
  sha: string;
  subject: string;
  files: string[];
}
/** The dated allow-list of full SHAs that are past rule 4 by decision. The only way past it. */
export const EXEMPT_COMMITS: Readonly<Record<string, CommitExemption>>;
/** The commits `exempt` excused: would-be violations whose full SHA is a key of it. */
export function exemptedCommits(
  commits: readonly CommitRecord[],
  exempt?: Readonly<Record<string, CommitExemption>>,
): ExemptedCommit[];
/** Every commit that touches rendering without a usable declaration and without an exemption. */
export function checkCommits(
  commits: readonly CommitRecord[],
  exempt?: Readonly<Record<string, CommitExemption>>,
): BudgetViolation[];
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
export function main(
  argv: readonly string[],
  cwd?: string,
  exempt?: Readonly<Record<string, CommitExemption>>,
  git?: PushRangeGit | null,
): number;
