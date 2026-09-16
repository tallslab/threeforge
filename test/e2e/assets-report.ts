/**
 * Row bookkeeping for the public asset report (`pnpm assets:report`, test/e2e/assets.spec.ts), split out of the
 * spec so it can be unit-tested without the corpus (test/unit/assets-report.test.ts).
 *
 * It exists to answer two questions the report could not answer before. *When was this row measured?* Rows merge
 * into docs/assets-report[-backend].json one test at a time, because Playwright restarts its worker after a
 * failure, so one file routinely holds rows from several runs; each row therefore carries the commit it was
 * measured at and the id of the run that measured it. And *did this table really cover the corpus?* A run over two
 * assets (FORGE_ASSETS=Fox,Duck), a crashed run, or a run of the other backend used to rewrite the whole Markdown
 * table as if it had measured every asset: `missingFromRun` is the gate that leaves the tracked Markdown alone
 * until one run has measured everything it set out to.
 *
 * Everything here is pure except `currentStamp`, which asks git once per process.
 */
import { execFileSync } from 'node:child_process';
import { hash8 } from '../../scripts/bench-id.mjs';

/** One asset's row of docs/assets-report[-backend].json. */
export interface ReportRow {
  name: string;
  tags: string;
  meshes?: number;
  materials?: number;
  triangles?: number;
  animations?: number;
  naive?: number;
  compiled?: number;
  batches?: number;
  instanced?: number;
  unattributed?: number;
  diff?: number;
  restored?: number;
  loadMs?: number;
  skipped?: string;
  reasons?: string;
  error?: string;
  /** The commit this row was measured at: a sha, `<sha>-dirty`, or `unknown`. */
  commit?: string;
  /** The run that measured it (`runIdOf`), equal for every row of one `playwright test` invocation. */
  run?: string;
}

/** What one run stamps on every row it writes. */
export interface RunStamp {
  commit: string;
  run: string;
}

/** `<sha>` for a clean tree, `<sha>-dirty` when the run measured uncommitted code, `unknown` without git. */
export function commitStamp(sha: string | undefined, dirty: boolean): string {
  const trimmed = (sha ?? '').trim();
  if (!trimmed) return 'unknown';
  return dirty ? `${trimmed}-dirty` : trimmed;
}

/** The commit stamp as the Markdown header shows it: the sha abbreviated to 7, keeping any `-dirty` marker. */
export function shortCommit(commit: string): string {
  const [sha = '', ...rest] = commit.split('-');
  return rest.length > 0 ? `${sha.slice(0, 7)}-${rest.join('-')}` : sha.slice(0, 7);
}

/**
 * The id every row of one `playwright test` invocation carries. It must survive a worker restart, so it is derived
 * from the runner process (the worker's parent) and the commit, never from the worker's own pid or clock: measured
 * on Playwright 1.63.0, a worker's pid changes across a restart and its `ppid` does not. `FORGE_RUN_ID` pins it.
 */
export function runIdOf(env: { FORGE_RUN_ID?: string | undefined }, ppid: number, commit: string): string {
  const pinned = (env.FORGE_RUN_ID ?? '').trim();
  return pinned === '' ? hash8(`${ppid}|${commit}`) : pinned;
}

/** The row with this run's commit and id on it. Returns a copy; the caller's row is untouched. */
export function stampRow(row: ReportRow, stamp: RunStamp): ReportRow {
  return { ...row, commit: stamp.commit, run: stamp.run };
}

/**
 * `existing` with `row` replacing the row of the same asset (or appended), sorted by name. Rows the run did not
 * touch keep their own stamps. A missing or malformed file counts as empty, and malformed rows are dropped. Pure.
 */
export function mergeRows(existing: unknown, row: ReportRow): ReportRow[] {
  const kept = (Array.isArray(existing) ? existing : []).filter((r): r is ReportRow => isRow(r) && r.name !== row.name);
  return [...kept, { ...row }].sort((a, b) => a.name.localeCompare(b.name));
}

function isRow(value: unknown): value is ReportRow {
  return typeof value === 'object' && value !== null && typeof (value as ReportRow).name === 'string';
}

/**
 * The assets of `expected` that this run did not measure: no row at all, or a row left behind by an earlier run.
 * Empty means the run covered everything it set out to, which is the only state that may rewrite the Markdown. A
 * row that errored counts as measured: the run attempted the asset and the error is its result.
 */
export function missingFromRun(rows: ReportRow[], expected: string[], run: string): string[] {
  const measured = new Set(rows.filter((r) => r.run === run).map((r) => r.name));
  return expected.filter((name) => !measured.has(name));
}

const TABLE_HEAD =
  '| asset | meshes | materials | tris | anim | naive | compiled | batches | inst | unattr | diff % | restored | skipped | notes |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';

/**
 * The Markdown table. Behind `missingFromRun` every row shares one stamp, so the header states that commit and run
 * once for the whole table rather than repeating them down a column; rows that disagree (or predate stamping) say
 * so instead of letting one commit stand for all of them.
 */
export function renderReport(rows: ReportRow[], backend: string): string {
  const body = rows
    .map(
      (r) =>
        `| ${r.name} | ${r.meshes ?? ''} | ${r.materials ?? ''} | ${r.triangles ?? ''} | ${r.animations ?? ''} | ${r.naive ?? ''} | ${r.compiled ?? ''} | ${r.batches ?? ''} | ${r.instanced ?? ''} | ${r.unattributed ?? ''} | ${r.diff ?? ''} | ${r.restored ?? ''} | ${r.skipped ?? ''} | ${r.error ?? ''} |`,
    )
    .join('\n');
  const total = rows.length;
  const ok = rows.filter((r) => !r.error && r.unattributed === 0 && (r.diff ?? 1) < 0.5 && r.restored === r.naive).length;
  const sentence = `Generated by \`pnpm assets:report\` on the ${backend} backend ${stampSentence(rows)}.`;
  return `# Public asset report (${backend})\n\n${sentence} ${ok}/${total} assets compile cleanly (0 unattributed, < 0.5% pixels changed, decompile restores).\n\n${TABLE_HEAD}${body}\n`;
}

function stampSentence(rows: ReportRow[]): string {
  const stamps = new Set(rows.map((r) => `${r.commit ?? 'unknown'}|${r.run ?? ''}`));
  if (stamps.size > 1) return `from ${stamps.size} different runs (each row's commit and run are in the JSON beside this file)`;
  const [only = ''] = [...stamps];
  const [commit = 'unknown', run = ''] = only.split('|');
  return run === '' ? '(unstamped)' : `at commit \`${shortCommit(commit)}\` (run \`${run}\`)`;
}

let cached: RunStamp | undefined;

/** This process's stamp: the commit under test and the run id, resolved once (git is asked at most once). */
export function currentStamp(): RunStamp {
  if (cached === undefined) {
    const commit = commitStamp(headSha(), workingTreeDirty());
    cached = { commit, run: runIdOf(process.env, process.ppid, commit) };
  }
  return cached;
}

function headSha(): string {
  const fromCi = (process.env.GITHUB_SHA ?? '').trim();
  if (fromCi !== '') return fromCi;
  return git(['rev-parse', 'HEAD']);
}

/**
 * The report files themselves are excluded: a run rewrites them as it goes, so counting them would turn the tree
 * dirty part-way through and give the rows of a restarted worker a different stamp from the rows before it.
 */
function workingTreeDirty(): boolean {
  if ((process.env.GITHUB_SHA ?? '').trim() !== '') return false; // a CI checkout is the commit it reports
  return git(['status', '--porcelain', '--', '.', ':!docs/assets-report*']).trim() !== '';
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return ''; // no git, or not a checkout: the rows say `unknown` rather than claiming a commit
  }
}
