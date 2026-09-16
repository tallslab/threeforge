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
  /**
   * The `FORGE_ASSETS_MATERIALS` the harness was given, when the run set one. Such a run measures a different
   * material configuration and never publishes the Markdown, but its numbers still merge into the JSON, so the row
   * has to say so. Absent on a normal run. (Distinct from `materials`, which is the asset's material count.)
   */
  materialsOverride?: string;
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
 * from the runner process (the worker's parent), the commit and the UTC day, never from the worker's own pid or
 * clock: measured on Playwright 1.63.0, a worker's pid changes across a restart and its `ppid` does not.
 *
 * `day` is in the id because a pid alone can repeat: an OS that recycles the runner pid at the same commit would
 * otherwise let a later partial run inherit an earlier full run's rows and republish the table. A run that crosses
 * midnight UTC splits into two ids, which blocks the Markdown instead of publishing a mixed table — the safe
 * direction. `FORGE_RUN_ID` pins the id outright, which is what CI should set (see Task 47).
 */
export function runIdOf(env: { FORGE_RUN_ID?: string | undefined }, ppid: number, commit: string, day: string): string {
  const pinned = (env.FORGE_RUN_ID ?? '').trim();
  return pinned === '' ? hash8(`${ppid}|${commit}|${day}`) : pinned;
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

/** One row of test/assets/files/index.json or kits-index.json, as `scripts/fetch-assets.mjs` and `fetch-kits.mjs` write it. */
export interface IndexEntry {
  name: string;
  /** The file to open, relative to test/assets/files. A failed Poly Haven fetch has none: its entry name comes from the API. */
  entry?: string;
  /** `kit` for a Kenney kit or the three.js texture bundle: never measured as one asset. */
  kind?: string;
  tags?: string[];
  /** Set when the fetch failed; the files are then absent. */
  error?: string;
}

/** What one `assets.spec.ts` invocation measures, decided before any test runs. */
export interface CorpusPlan {
  /** Every glTF model a full run must measure, downloaded or not, in index order. The Markdown gate's `expected`. */
  expected: string[];
  /** The entries this run generates a test for: `expected` narrowed by FORGE_ASSETS. One carrying `error` must fail. */
  attempt: IndexEntry[];
  /** FORGE_ASSETS names that match no model in the index, each of which must fail rather than run nothing. */
  unknown: string[];
}

const MODEL = /\.(gltf|glb)$/i;

/**
 * The assets a run must measure, judged against what the index says *should* be there rather than what happened to
 * download. `fetch-assets.mjs` records a failed download as `{ error }` and exits 0; the spec used to drop such
 * entries from both its tests and the gate's `expected`, so a partial fetch produced a green run and a silently
 * shorter table. Now an errored model stays in `expected` and in `attempt`, where its test fails naming the fetch
 * error and saves no row, so the gate reports it missing too.
 *
 * `only` (FORGE_ASSETS) narrows `attempt` and nothing else: an asset left out on purpose is not missing, even if it
 * errored, while one it names is attempted whatever its state. An errored entry with no `entry` counts as a model,
 * since nothing shows it is not one. Kits, non-glTF entries (textures) and malformed rows are skipped; a repeated
 * name keeps its first entry. Pure.
 */
export function corpusPlan(lists: readonly unknown[], only: readonly string[] | undefined): CorpusPlan {
  const models: IndexEntry[] = [];
  const seen = new Set<string>();
  for (const value of lists) {
    if (typeof value !== 'object' || value === null) continue;
    const e = value as IndexEntry;
    if (typeof e.name !== 'string' || e.name === '' || e.kind === 'kit' || seen.has(e.name)) continue;
    const isModel = typeof e.entry === 'string' ? MODEL.test(e.entry) : typeof e.error === 'string';
    if (!isModel) continue;
    seen.add(e.name);
    models.push(e);
  }
  const wanted = only && only.length > 0 ? new Set(only) : undefined;
  return {
    expected: models.map((m) => m.name),
    attempt: wanted ? models.filter((m) => wanted.has(m.name)) : models,
    unknown: wanted ? [...wanted].filter((name) => !seen.has(name)) : [],
  };
}

/** FORGE_ASSETS as a list of names, or `undefined` (no filter) when it is unset, empty or only commas and spaces. */
export function onlyOf(env: { FORGE_ASSETS?: string | undefined }): string[] | undefined {
  const names = (env.FORGE_ASSETS ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return names.length > 0 ? names : undefined;
}

/** Where a backend's report files live, without the extension. */
export function reportFor(backend: string): string {
  return backend === 'webgl2' ? 'docs/assets-report' : `docs/assets-report-${backend}`;
}

/** Everything the Markdown gate decides on. */
export interface GateInput {
  backend: string;
  /** The rows currently on disk for that backend. */
  rows: ReportRow[];
  /** Every asset a full run measures, whatever this run attempted. */
  expected: string[];
  /** This run's id. */
  run: string;
  env: { FORGE_ASSETS_MATERIALS?: string | undefined };
}

/**
 * Why this run must not rewrite the tracked Markdown, or `null` when it may. This decision used to sit inside
 * `assets.spec.ts`, which nothing imports and nobody may run here, so it had no test: dropping it left every unit
 * test green while a partial run republished the tracked table. It lives here so it is covered.
 */
export function markdownBlock(input: GateInput): string | null {
  // Nothing downloaded: "every expected asset was measured" would be vacuously true and would republish the
  // tracked table from rows this run never measured.
  if (input.expected.length === 0) return 'no assets in the index, so this run measured nothing to publish';
  // A materials override measures a different configuration; its numbers must not become the published table.
  const materials = (input.env.FORGE_ASSETS_MATERIALS ?? '').trim();
  if (materials !== '') return `run under FORGE_ASSETS_MATERIALS=${materials}, which measures a different configuration`;
  const missing = missingFromRun(input.rows, input.expected, input.run);
  if (missing.length === 0) return null;
  const head = missing.slice(0, 4).join(', ');
  const rest = missing.length > 4 ? `, +${missing.length - 4} more` : '';
  return `run ${input.run} measured ${input.expected.length - missing.length}/${input.expected.length} assets (missing ${head}${rest})`;
}

/** The Markdown path this run may write, or `null` when it must leave the tracked file alone. */
export function markdownTarget(input: GateInput): string | null {
  return markdownBlock(input) === null ? `${reportFor(input.backend)}.md` : null;
}

/**
 * The rows a published table shows: the assets the index still lists, in the order given. An asset dropped from the
 * index leaves the table instead of lingering under an old run's stamp and making the header read "different runs".
 */
export function rowsForReport(rows: ReportRow[], expected: string[]): ReportRow[] {
  const keep = new Set(expected);
  return rows.filter((r) => keep.has(r.name));
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
    cached = { commit, run: runIdOf(process.env, process.ppid, commit, new Date().toISOString().slice(0, 10)) };
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
