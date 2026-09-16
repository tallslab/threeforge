import { describe, expect, it } from 'vitest';
import { commitStamp, mergeRows, missingFromRun, renderReport, runIdOf, shortCommit, stampRow, type ReportRow } from '../e2e/assets-report.js';

const row = (name: string, extra: Partial<ReportRow> = {}): ReportRow => ({ name, tags: 't', meshes: 1, naive: 1, compiled: 1, unattributed: 0, diff: 0, restored: 1, ...extra });
const stamp = { commit: 'a'.repeat(40), run: 'run1234' };

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
  it('is stable across a worker restart: the same runner pid and commit give the same id', () => {
    expect(runIdOf({}, 4321, stamp.commit)).toBe(runIdOf({}, 4321, stamp.commit));
  });

  it('separates two invocations: a different runner pid gives a different id', () => {
    expect(runIdOf({}, 4321, stamp.commit)).not.toBe(runIdOf({}, 4322, stamp.commit));
  });

  it('separates two runs at the same pid but different commits', () => {
    expect(runIdOf({}, 4321, 'a'.repeat(40))).not.toBe(runIdOf({}, 4321, 'b'.repeat(40)));
  });

  it('is short and file-name safe', () => {
    expect(runIdOf({}, 4321, stamp.commit)).toMatch(/^[a-z0-9]{8}$/);
  });

  it('takes FORGE_RUN_ID verbatim when a caller pins one (CI can group a run by its own id)', () => {
    expect(runIdOf({ FORGE_RUN_ID: 'ci-9042' }, 4321, stamp.commit)).toBe('ci-9042');
    expect(runIdOf({ FORGE_RUN_ID: '  ci-9042  ' }, 4321, stamp.commit)).toBe('ci-9042');
  });

  it('ignores an empty FORGE_RUN_ID rather than stamping every row with nothing', () => {
    expect(runIdOf({ FORGE_RUN_ID: '   ' }, 4321, stamp.commit)).toBe(runIdOf({}, 4321, stamp.commit));
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
    expect(stampRow(row('Fox', { commit: 'old', run: 'older' }), stamp)).toMatchObject({ commit: stamp.commit, run: 'run1234' });
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
