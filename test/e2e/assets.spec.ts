/**
 * Dogfooding on public glTF assets (test/assets/files, fetched by `pnpm assets`). Every asset is loaded, rendered
 * naively, compiled with policy 'auto', rendered again and compared pixel by pixel, then decompiled. Assertions are
 * soft so the whole report gets written to docs/assets-report.{json,md}; the run still fails if any asset misbehaves.
 * A model the index lists but whose download failed fails too, instead of being left out. FORGE_ASSETS=Fox,Duck
 * limits the run.
 *
 * Every row records the commit it was measured at and the id of the run that measured it, because rows merge on
 * disk across worker restarts and across runs. The Markdown is rewritten only after a run that measured every
 * asset (see the afterAll below); a partial run's rows still land in the JSON, stamped as its own.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  corpusPlan,
  currentStamp,
  type GateInput,
  markdownBlock,
  markdownTarget,
  mergeRows,
  onlyOf,
  type ReportRow,
  renderReport,
  reportFor,
  rowsForReport,
  stampRow,
} from './assets-report.js';
import { expect, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';

const files = 'test/assets/files';
const lists: unknown[] = [];
for (const f of ['index.json', 'kits-index.json']) {
  if (existsSync(`${files}/${f}`)) lists.push(...(JSON.parse(readFileSync(`${files}/${f}`, 'utf8')) as unknown[]));
}
/**
 * Every model a full run measures (`plan.expected`, downloaded or not) and what this run attempts (`plan.attempt`,
 * narrowed by FORGE_ASSETS). A model whose download failed is attempted and fails; it is not silently left out.
 * The decision is `corpusPlan`'s, unit-tested in test/unit/assets-report.test.ts, because this spec may not be run.
 */
const plan = corpusPlan(lists, onlyOf(process.env));
/** The same commit and run id in every worker of this invocation, including the ones Playwright restarts. */
const stamp = currentStamp();
/** Set when the harness is told to override materials: such a run's numbers are a variant, and every row says so. */
const materialsOverride = (process.env.FORGE_ASSETS_MATERIALS ?? '').trim();

/** Playwright restarts its worker after a failure, so rows are merged on disk per test rather than kept in memory. */
function saveRow(row: ReportRow, backend: string): void {
  const reportPath = `${reportFor(backend)}.json`;
  mkdirSync('docs', { recursive: true });
  const existing: unknown = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : [];
  writeFileSync(reportPath, JSON.stringify(mergeRows(existing, stampRow(row, stamp)), null, 2));
}

for (const name of plan.unknown) {
  test(`asset ${name}`, { tag: '@corpus' }, () => {
    throw new Error(`FORGE_ASSETS names ${name}, which is no glTF model in ${files}/index.json or kits-index.json`);
  });
}

for (const asset of plan.attempt) {
  test(`asset ${asset.name}`, { tag: '@corpus' }, async ({ forge }) => {
    // No row is saved: a download failure is not a measurement, and without a row the gate reports it missing.
    if (asset.error !== undefined)
      throw new Error(`${asset.name} was never downloaded (${asset.error}); rerun pnpm assets`);
    test.setTimeout(180_000);
    const row: ReportRow = {
      name: asset.name,
      tags: (asset.tags ?? []).join(' '),
      ...(materialsOverride ? { materialsOverride } : {}),
    };
    try {
      await forge.open('gltf', { asset: asset.name, ...(materialsOverride ? { materials: materialsOverride } : {}) });
    } catch (error) {
      row.error = String(error instanceof Error ? error.message : error)
        .split('\n')[0]!
        .slice(0, 200);
      saveRow(row, forge.backend);
      throw error;
    }
    const naive = await forge.page.evaluate(async () => {
      const f = window.__forge;
      for (let i = 0; i < 3; i++) await f.frameAsync(); // warm-up: reflectors and nested-pass pipelines settle a few frames late
      const frame = f.frame();
      return { totals: frame.totals, byReason: frame.byReason, info: f.gltf! };
    });
    Object.assign(row, {
      meshes: naive.info.meshes,
      materials: naive.info.materials,
      triangles: naive.info.triangles,
      animations: naive.info.animations,
      naive: naive.totals.sceneSubmissions,
      loadMs: naive.info.loadMs,
    });
    const before = await forge.page.screenshot({ type: 'png' });

    const compiled = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const report = f.compile();
      await f.world.warmup(f.renderer, f.camera); // build the new batch pipelines before measuring (one scissored frame)
      for (let i = 0; i < 3; i++) await f.frameAsync();
      const frame = f.frame();
      const skipped = new Map<string, number>();
      for (const s of report.skipped) skipped.set(s.rule, (skipped.get(s.rule) ?? 0) + 1);
      return {
        report: {
          batches: report.after.batches,
          instanced: report.after.instanced,
          meshes: report.after.meshes,
          groups: report.groups.length,
        },
        totals: frame.totals,
        byReason: frame.byReason,
        skipped: [...skipped.entries()],
      };
    });
    const after = await forge.page.screenshot({ type: 'png' });
    const diff = pixelDiff(before, after);
    const restored = await forge.page.evaluate(() => {
      window.__forge.decompile();
      return window.__forge.frame().totals.sceneSubmissions;
    });
    Object.assign(row, {
      compiled: compiled.totals.sceneSubmissions,
      batches: compiled.report.batches,
      instanced: compiled.report.instanced,
      unattributed: compiled.totals.unattributed,
      diff: Number((diff * 100).toFixed(2)),
      restored,
      skipped: compiled.skipped
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r}:${n}`)
        .join(' '),
      reasons: Object.entries(compiled.byReason)
        .filter(([r]) => r !== 'renderer-internal')
        .sort((a, b) => b[1].submissions - a[1].submissions)
        .map(([r, v]) => `${r}:${v.submissions}`)
        .join(' '),
    });
    saveRow(row, forge.backend);
    console.log(
      `${asset.name}: ${row.naive} -> ${row.compiled} submissions, diff ${row.diff}%, unattributed ${row.unattributed}`,
    );
    expect.soft(compiled.totals.unattributed, 'unattributed draws').toBe(0);
    expect.soft(diff, 'pixel diff ratio after compile').toBeLessThan(0.005);
    expect.soft(restored, 'submissions after decompile').toBe(naive.totals.sceneSubmissions);
    expect
      .soft(compiled.totals.sceneSubmissions, 'compile never increases submissions')
      .toBeLessThanOrEqual(naive.totals.sceneSubmissions);
  });
}

/**
 * The Markdown is the table people read, so it is rewritten only after a run that measured every asset it set out
 * to. A subset run (FORGE_ASSETS), a run that crashed part-way, and a run of the other backend all leave the
 * tracked file exactly as it was, instead of shrinking it to whatever this run happened to cover — the old code
 * rewrote both backends' Markdown from whatever JSON was on disk, so `pnpm assets:report` (webgl2 only) republished
 * the webgpu table too. The JSON still merges either way; that is where a partial run's rows land, each stamped.
 */
test.afterAll(() => {
  const expected = plan.expected;
  for (const backend of ['webgl2', 'webgpu']) {
    const jsonPath = `${reportFor(backend)}.json`;
    if (!existsSync(jsonPath)) continue;
    const rows = JSON.parse(readFileSync(jsonPath, 'utf8')) as ReportRow[];
    // The whole decision lives in markdownTarget/markdownBlock so it is unit-tested (test/unit/assets-report.test.ts):
    // this file is imported by nothing and may not be run here, so a gate written inline here had no test at all.
    const gate: GateInput = { backend, rows, expected, run: stamp.run, env: process.env };
    const target = markdownTarget(gate);
    if (target === null) {
      console.log(`${reportFor(backend)}.md left unchanged: ${markdownBlock(gate)}`);
      continue;
    }
    writeFileSync(target, renderReport(rowsForReport(rows, expected), backend));
  }
});
