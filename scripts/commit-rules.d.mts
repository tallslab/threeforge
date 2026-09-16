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
export type BudgetDeclaration = { kind: 'count'; value: number; line: string } | { kind: 'n/a'; reason: string; line: string };

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
/** Runs the check; returns the process exit code (0 ok, 1 violations, 2 usage). */
export function main(argv: readonly string[], cwd?: string): number;
