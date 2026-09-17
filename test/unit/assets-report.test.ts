import { describe, expect, it } from 'vitest';
import {
  commitStamp,
  corpusPlan,
  type GateInput,
  type IndexEntry,
  markdownBlock,
  markdownTarget,
  mergeRows,
  missingFromRun,
  onlyOf,
  type ReportRow,
  renderReport,
  reportFor,
  rowsForReport,
  runIdOf,
  shortCommit,
  stampRow,
} from '../e2e/assets-report.js';

const row = (name: string, extra: Partial<ReportRow> = {}): ReportRow => ({
  name,
  tags: 't',
  meshes: 1,
  naive: 1,
  compiled: 1,
  unattributed: 0,
  diff: 0,
  restored: 1,
  ...extra,
});
const stamp = { commit: 'a'.repeat(40), run: 'run1234' };
/** The UTC date a run started, folded into the run id so a recycled runner pid cannot inherit an older run's rows. */
const DAY = '2026-09-16';

/**
 * `pnpm assets:report` merges its rows into docs/assets-report[-backend].json one test at a time (Playwright
 * restarts its worker after a failure), so a report file routinely holds rows from more than one run. Without a
 * per-row stamp nothing distinguishes a row measured at this commit from one left over from a run months ago,
 * and a run over two assets used to rewrite the whole Markdown table as if it covered all 104.
 */
describe('commitStamp', () => {
  it('is the sha when the tree is clean', () => {
    expect(commitStamp('4f44a6c', false)).toBe('4f44a6c');
  });

  it('marks a dirty tree, so a row measured on uncommitted code never reads as that commit', () => {
    expect(commitStamp('4f44a6c', true)).toBe('4f44a6c-dirty');
  });

  it('falls back to "unknown" when git gave nothing, dirty or not', () => {
    expect(commitStamp('', false)).toBe('unknown');
    expect(commitStamp('', true)).toBe('unknown');
    expect(commitStamp(undefined, false)).toBe('unknown');
  });

  it('trims the trailing newline git rev-parse writes', () => {
    expect(commitStamp('4f44a6c\n', false)).toBe('4f44a6c');
  });
});

describe('shortCommit (what the Markdown header shows)', () => {
  it('abbreviates a full sha to 7 characters', () => {
    expect(shortCommit('4f44a6c1234567890abcdef1234567890abcdef1')).toBe('4f44a6c');
  });

  it('keeps the dirty marker on the abbreviated sha', () => {
    expect(shortCommit('4f44a6c1234567890abcdef1234567890abcdef1-dirty')).toBe('4f44a6c-dirty');
  });

  it('passes "unknown" through', () => {
    expect(shortCommit('unknown')).toBe('unknown');
  });
});

/**
 * The run id has to be the same in every worker of one `playwright test` invocation: Playwright restarts its
 * worker after a failing test, so anything derived from the worker's own clock or pid would give each restart a
 * new id and no run would ever look complete. Measured on this Playwright (1.63.0): a worker's pid changes across
 * a restart, its `ppid` (the runner) does not.
 */
describe('runIdOf', () => {
  it('is stable across a worker restart: the same runner pid, commit and day give the same id', () => {
    expect(runIdOf({}, 4321, stamp.commit, DAY)).toBe(runIdOf({}, 4321, stamp.commit, DAY));
  });

  it('separates two invocations: a different runner pid gives a different id', () => {
    expect(runIdOf({}, 4321, stamp.commit, DAY)).not.toBe(runIdOf({}, 4322, stamp.commit, DAY));
  });

  it('separates two runs at the same pid but different commits', () => {
    expect(runIdOf({}, 4321, 'a'.repeat(40), DAY)).not.toBe(runIdOf({}, 4321, 'b'.repeat(40), DAY));
  });

  /**
   * The pid alone can repeat: an OS that recycles the runner pid at the same commit would let a later partial run
   * inherit an earlier full run's rows and republish the table. The day makes that need a recycled pid at the same
   * commit *on the same date*. A run that crosses midnight UTC splits into two ids, which blocks the Markdown
   * rather than publishing a mixed table — the safe direction.
   */
  it('separates two runs at the same pid and commit on different days', () => {
    expect(runIdOf({}, 4321, stamp.commit, '2026-09-16')).not.toBe(runIdOf({}, 4321, stamp.commit, '2026-09-17'));
  });

  it('is short and file-name safe', () => {
    expect(runIdOf({}, 4321, stamp.commit, DAY)).toMatch(/^[a-z0-9]{8}$/);
  });

  it('takes FORGE_RUN_ID verbatim when a caller pins one (CI can group a run by its own id)', () => {
    expect(runIdOf({ FORGE_RUN_ID: 'ci-9042' }, 4321, stamp.commit, DAY)).toBe('ci-9042');
    expect(runIdOf({ FORGE_RUN_ID: '  ci-9042  ' }, 4321, stamp.commit, DAY)).toBe('ci-9042');
  });

  it('ignores an empty FORGE_RUN_ID rather than stamping every row with nothing', () => {
    expect(runIdOf({ FORGE_RUN_ID: '   ' }, 4321, stamp.commit, DAY)).toBe(runIdOf({}, 4321, stamp.commit, DAY));
  });
});

describe('stampRow', () => {
  it('writes the commit and run onto a copy, leaving the caller’s row alone', () => {
    const original = row('Fox');
    const stamped = stampRow(original, stamp);
    expect(stamped).toMatchObject({ name: 'Fox', commit: stamp.commit, run: 'run1234' });
    expect(original.commit).toBeUndefined();
    expect(original.run).toBeUndefined();
  });

  it('replaces an older stamp on a re-measured row', () => {
    expect(stampRow(row('Fox', { commit: 'old', run: 'older' }), stamp)).toMatchObject({
      commit: stamp.commit,
      run: 'run1234',
    });
  });
});

describe('mergeRows (rows merge on disk because the worker restarts)', () => {
  it('replaces the row of the same asset and keeps the rest, sorted by name', () => {
    const existing = [row('Duck'), row('Fox', { naive: 1 })];
    expect(mergeRows(existing, row('Fox', { naive: 9 })).map((r) => [r.name, r.naive])).toEqual([
      ['Duck', 1],
      ['Fox', 9],
    ]);
  });

  it('appends an asset the file did not hold yet, in sorted position', () => {
    expect(mergeRows([row('Fox'), row('Zebra')], row('Duck')).map((r) => r.name)).toEqual(['Duck', 'Fox', 'Zebra']);
  });

  it('treats a missing or malformed file as empty', () => {
    expect(mergeRows(undefined, row('Fox')).map((r) => r.name)).toEqual(['Fox']);
    expect(mergeRows({ not: 'an array' }, row('Fox')).map((r) => r.name)).toEqual(['Fox']);
  });

  it('drops malformed rows instead of carrying them into the report', () => {
    expect(mergeRows([null, 7, { tags: 'x' }, row('Duck')], row('Fox')).map((r) => r.name)).toEqual(['Duck', 'Fox']);
  });

  it('keeps the stamps of rows it did not touch, so a partial run leaves the older rows legible', () => {
    const existing = [stampRow(row('Duck'), { commit: 'older', run: 'run0000' })];
    expect(mergeRows(existing, stampRow(row('Fox'), stamp))).toEqual([
      expect.objectContaining({ name: 'Duck', commit: 'older', run: 'run0000' }),
      expect.objectContaining({ name: 'Fox', commit: stamp.commit, run: 'run1234' }),
    ]);
  });

  it('does not mutate its inputs', () => {
    const existing = [row('Duck')];
    const incoming = row('Fox');
    const snapshot = JSON.stringify({ existing, incoming });
    mergeRows(existing, incoming);
    expect(JSON.stringify({ existing, incoming })).toBe(snapshot);
  });
});

/**
 * The gate on the Markdown: it is rewritten only when every asset the run set out to measure has a row carrying
 * this run's id. A subset run (FORGE_ASSETS=Fox,Duck), a crashed run and a run that only covered the other
 * backend all leave names behind, and all of them must leave the tracked Markdown untouched.
 */
describe('missingFromRun', () => {
  const rows = [stampRow(row('Duck'), stamp), stampRow(row('Fox'), stamp)];

  it('reports nothing when every expected asset carries this run’s id', () => {
    expect(missingFromRun(rows, ['Duck', 'Fox'], 'run1234')).toEqual([]);
  });

  it('reports the assets this run never measured (a subset run)', () => {
    expect(missingFromRun(rows, ['Duck', 'Fox', 'Buggy', 'Sponza'], 'run1234')).toEqual(['Buggy', 'Sponza']);
  });

  it('reports rows left over from an earlier run, even though the name is present', () => {
    const stale = [stampRow(row('Duck'), { commit: 'older', run: 'run0000' }), stampRow(row('Fox'), stamp)];
    expect(missingFromRun(stale, ['Duck', 'Fox'], 'run1234')).toEqual(['Duck']);
  });

  it('reports every row of a report written before stamping existed', () => {
    expect(missingFromRun([row('Duck'), row('Fox')], ['Duck', 'Fox'], 'run1234')).toEqual(['Duck', 'Fox']);
  });

  it('counts a row that errored as measured: the run attempted it, and the error is the result', () => {
    const errored = [stampRow(row('Duck', { error: 'load failed' }), stamp), stampRow(row('Fox'), stamp)];
    expect(missingFromRun(errored, ['Duck', 'Fox'], 'run1234')).toEqual([]);
  });

  it('follows the expected order and tolerates a report holding extra assets', () => {
    expect(missingFromRun(rows, ['Sponza', 'Duck', 'Buggy'], 'run1234')).toEqual(['Sponza', 'Buggy']);
  });
});

describe('renderReport', () => {
  const clean = [stampRow(row('Duck'), stamp), stampRow(row('Fox'), stamp)];

  it('names the backend and stamps the whole table with the one commit and run its rows share', () => {
    const md = renderReport(clean, 'webgl2');
    expect(md).toContain('# Public asset report (webgl2)');
    expect(md).toContain('on the webgl2 backend at commit `aaaaaaa` (run `run1234`)');
    expect(md).toContain('2/2 assets compile cleanly');
  });

  it('renders one table row per asset, in the order given', () => {
    const lines = renderReport(clean, 'webgl2').trim().split('\n');
    expect(lines.at(-2)).toBe('| Duck | 1 |  |  |  | 1 | 1 |  |  | 0 | 0 | 1 |  |  |');
    expect(lines.at(-1)).toBe('| Fox | 1 |  |  |  | 1 | 1 |  |  | 0 | 0 | 1 |  |  |');
  });

  it('counts an asset as clean only when it has no error, nothing unattributed, few changed pixels and decompiles back', () => {
    const rows = [
      stampRow(row('Ok'), stamp),
      stampRow(row('Errored', { error: 'boom' }), stamp),
      stampRow(row('Unattributed', { unattributed: 3 }), stamp),
      stampRow(row('Changed', { diff: 2 }), stamp),
      stampRow(row('NotRestored', { naive: 4, restored: 1 }), stamp),
    ];
    expect(renderReport(rows, 'webgl2')).toContain('1/5 assets compile cleanly');
  });

  it('says so instead of claiming one commit when the rows come from different runs', () => {
    const mixed = [stampRow(row('Duck'), { commit: 'b'.repeat(40), run: 'run0000' }), stampRow(row('Fox'), stamp)];
    const md = renderReport(mixed, 'webgl2');
    expect(md).toContain('from 2 different runs');
    expect(md).not.toContain('run1234`)');
  });

  it('says so for rows written before stamping existed, rather than inventing a commit', () => {
    expect(renderReport([row('Duck')], 'webgl2')).toContain('(unstamped)');
  });

  it('carries the backend into the title and the sentence for the webgpu report', () => {
    const md = renderReport(clean, 'webgpu');
    expect(md).toContain('# Public asset report (webgpu)');
    expect(md).toContain('on the webgpu backend at commit');
  });
});

describe('reportFor', () => {
  it('names the webgl2 report without a suffix and any other backend with one', () => {
    expect(reportFor('webgl2')).toBe('docs/assets-report');
    expect(reportFor('webgpu')).toBe('docs/assets-report-webgpu');
  });
});

describe('rowsForReport (an asset dropped from the index leaves the table)', () => {
  it('keeps only the assets the index still lists, in the order given', () => {
    expect(rowsForReport([row('Duck'), row('Retired'), row('Fox')], ['Duck', 'Fox']).map((r) => r.name)).toEqual([
      'Duck',
      'Fox',
    ]);
  });

  it('keeps every row when the index dropped nothing', () => {
    expect(rowsForReport([row('Duck'), row('Fox')], ['Fox', 'Duck']).map((r) => r.name)).toEqual(['Duck', 'Fox']);
  });
});

/**
 * The gate that protects the tracked Markdown. It used to live inside `assets.spec.ts` — a file nothing imports and
 * nobody here may run — so deleting its `continue` would have left every unit test green while a partial run
 * republished the tracked table, which is the exact regression this task exists to prevent. These are its tests.
 */
describe('markdownTarget / markdownBlock (the gate on the tracked Markdown)', () => {
  const full = [stampRow(row('Duck'), stamp), stampRow(row('Fox'), stamp)];
  const input = (over: Partial<GateInput> = {}): GateInput => ({
    backend: 'webgl2',
    rows: full,
    expected: ['Duck', 'Fox'],
    run: 'run1234',
    env: {},
    ...over,
  });

  it('opens for a run that measured every expected asset', () => {
    expect(markdownBlock(input())).toBeNull();
    expect(markdownTarget(input())).toBe('docs/assets-report.md');
  });

  it('sends the webgpu table to its own path', () => {
    expect(markdownTarget(input({ backend: 'webgpu' }))).toBe('docs/assets-report-webgpu.md');
  });

  it('blocks a subset run and says how far it got and what is missing', () => {
    const partial = input({ expected: ['Duck', 'Fox', 'Buggy', 'Sponza'] });
    expect(markdownTarget(partial)).toBeNull();
    expect(markdownBlock(partial)).toContain('2/4');
    expect(markdownBlock(partial)).toContain('Buggy');
  });

  it('blocks a run whose rows an earlier run left behind', () => {
    const stale = [stampRow(row('Duck'), { commit: 'older', run: 'run0000' }), stampRow(row('Fox'), stamp)];
    expect(markdownTarget(input({ rows: stale }))).toBeNull();
  });

  it('blocks a report written before stamping existed', () => {
    expect(markdownTarget(input({ rows: [row('Duck'), row('Fox')] }))).toBeNull();
  });

  it('blocks a FORGE_ASSETS_MATERIALS run even when it measured everything', () => {
    const variant = input({ env: { FORGE_ASSETS_MATERIALS: 'basic' } });
    expect(markdownTarget(variant)).toBeNull();
    expect(markdownBlock(variant)).toContain('FORGE_ASSETS_MATERIALS=basic');
  });

  it('blocks an empty corpus instead of vacuously publishing rows this run never measured', () => {
    const empty = input({ expected: [] });
    expect(markdownTarget(empty)).toBeNull();
    expect(markdownBlock(empty)).toContain('no assets');
  });
});

/**
 * Which assets a run must measure. This used to be an inline filter in `assets.spec.ts` that dropped every index
 * entry carrying `error`, and the Markdown gate read the same shrunken list: `fetch-assets.mjs` records a failed
 * download as `{ error }` and exits 0, so a corpus run that fetched 40 of 55 models generated 40 tests, "measured
 * every asset it set out to", republished a shorter table and went green. An asset that failed to download is a
 * failure, not an absence. An asset filtered out on purpose by FORGE_ASSETS is neither.
 */
describe('corpusPlan', () => {
  const model = (name: string, extra: Partial<IndexEntry> = {}): IndexEntry => ({
    name,
    entry: `${name}/${name}.glb`,
    ...extra,
  });
  const lists: IndexEntry[] = [
    model('Duck'),
    model('Fox'),
    model('Buggy', { error: '404 https://example.invalid/Buggy.glb' }),
    { name: 'Sponza', entry: 'Sponza/Sponza.gltf' },
    { name: 'kenney-nature-kit', kind: 'kit', glbs: ['kenney-nature-kit/a.glb'] } as IndexEntry,
    { name: 'kenney-car-kit', kind: 'kit', error: '503 kenney.nl' },
    { name: 'waternormals', entry: 'waternormals/waternormals.jpg' },
    { name: 'three-textures', entry: 'three-textures/spark1.png', error: '404 spark1.png' },
  ];

  it('expects an asset that failed to download, and attempts it so its test fails instead of vanishing', () => {
    const plan = corpusPlan(lists, undefined);
    expect(plan.expected).toEqual(['Duck', 'Fox', 'Buggy', 'Sponza']);
    expect(plan.attempt.map((a) => a.name)).toEqual(['Duck', 'Fox', 'Buggy', 'Sponza']);
    expect(plan.attempt.find((a) => a.name === 'Buggy')?.error).toBe('404 https://example.invalid/Buggy.glb');
    expect(plan.unknown).toEqual([]);
  });

  it('fails the Markdown gate for a run whose only gap is an asset that never downloaded', () => {
    // The spec fails an undownloaded asset's test without saving a row, so the gate sees it as missing.
    const rows = ['Duck', 'Fox', 'Sponza'].map((n) => stampRow(row(n), stamp));
    const plan = corpusPlan(lists, undefined);
    const block = markdownBlock({ backend: 'webgl2', rows, expected: plan.expected, run: stamp.run, env: {} });
    expect(block).toBe('run run1234 measured 3/4 assets (missing Buggy)');
    // The old rule dropped Buggy from `expected` too, and this same run published: the defect, pinned.
    const shrunken = lists
      .filter((a) => a.entry && /\.(gltf|glb)$/i.test(a.entry) && !a.error && a.kind !== 'kit')
      .map((a) => a.name);
    expect(markdownBlock({ backend: 'webgl2', rows, expected: shrunken, run: stamp.run, env: {} })).toBeNull();
  });

  it('does not attempt an errored asset FORGE_ASSETS filtered out on purpose, so a subset run still passes', () => {
    const plan = corpusPlan(lists, ['Fox', 'Duck']);
    expect(plan.attempt.map((a) => a.name)).toEqual(['Duck', 'Fox']);
    expect(plan.attempt.some((a) => a.error)).toBe(false);
    expect(plan.unknown).toEqual([]);
    // Still a subset: the full `expected` is unchanged, so the gate keeps the tracked Markdown as it was.
    expect(plan.expected).toEqual(['Duck', 'Fox', 'Buggy', 'Sponza']);
    const rows = ['Duck', 'Fox'].map((n) => stampRow(row(n), stamp));
    expect(markdownBlock({ backend: 'webgl2', rows, expected: plan.expected, run: stamp.run, env: {} })).not.toBeNull();
  });

  it('attempts an errored asset FORGE_ASSETS names, because asking for it and not getting it is a failure', () => {
    const plan = corpusPlan(lists, ['Buggy']);
    expect(plan.attempt).toEqual([model('Buggy', { error: '404 https://example.invalid/Buggy.glb' })]);
  });

  it('reports a FORGE_ASSETS name that matches no model, so a typo cannot make a run of nothing', () => {
    const plan = corpusPlan(lists, ['Foxx', 'Fox', 'waternormals']);
    expect(plan.attempt.map((a) => a.name)).toEqual(['Fox']);
    expect(plan.unknown).toEqual(['Foxx', 'waternormals']);
  });

  it('counts an errored entry of unknown type as expected: without an entry it cannot be shown not to be a model', () => {
    const plan = corpusPlan([model('Fox'), { name: 'polyhaven-boulder_01', error: 'no gltf variant' }], undefined);
    expect(plan.expected).toEqual(['Fox', 'polyhaven-boulder_01']);
  });

  it('skips kits, non-model entries and malformed rows, and keeps the first of a repeated name', () => {
    const plan = corpusPlan(
      [
        null,
        7,
        { entry: 'x.glb' },
        model('Fox'),
        model('Fox', { error: 'dup' }),
        { name: 'three-textures', kind: 'kit', textures: [] },
      ] as unknown[],
      undefined,
    );
    expect(plan.expected).toEqual(['Fox']);
    expect(plan.attempt).toEqual([model('Fox')]);
  });
});

describe('onlyOf (FORGE_ASSETS)', () => {
  it('splits and trims, and treats an unset, empty or comma-only value as no filter', () => {
    expect(onlyOf({ FORGE_ASSETS: 'Fox, Duck ' })).toEqual(['Fox', 'Duck']);
    for (const value of [undefined, '', '  ', ' , ,']) expect(onlyOf({ FORGE_ASSETS: value })).toBeUndefined();
  });
});
