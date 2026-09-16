/**
 * Dogfooding on public glTF assets (test/assets/files, fetched by `pnpm assets`). Every asset is loaded, rendered
 * naively, compiled with policy 'auto', rendered again and compared pixel by pixel, then decompiled. Assertions are
 * soft so the whole report gets written to docs/assets-report.{json,md}; the run still fails if any asset misbehaves.
 * FORGE_ASSETS=Fox,Duck limits the run.
 *
 * Every row records the commit it was measured at and the id of the run that measured it, because rows merge on
 * disk across worker restarts and across runs. The Markdown is rewritten only after a run that measured every
 * asset (see the afterAll below); a partial run's rows still land in the JSON, stamped as its own.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { currentStamp, mergeRows, missingFromRun, renderReport, stampRow, type ReportRow } from './assets-report.js';
import { expect, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';

interface AssetEntry {
  name: string;
  entry?: string;
  tags?: string[];
  error?: string;
  kind?: string;
}

const files = 'test/assets/files';
const lists: AssetEntry[] = [];
for (const f of ['index.json', 'kits-index.json']) {
  if (existsSync(`${files}/${f}`)) lists.push(...(JSON.parse(readFileSync(`${files}/${f}`, 'utf8')) as AssetEntry[]));
}
const only = process.env.FORGE_ASSETS?.split(',').map((s) => s.trim());
/** Every asset a full run measures. `assets` is what this run will actually attempt (FORGE_ASSETS narrows it). */
const candidates = lists.filter((a) => a.entry && /\.(gltf|glb)$/i.test(a.entry) && !a.error && a.kind !== 'kit');
const assets = candidates.filter((a) => !only || only.includes(a.name));
const reportFor = (backend: string) => (backend === 'webgl2' ? 'docs/assets-report' : `docs/assets-report-${backend}`);
/** The same commit and run id in every worker of this invocation, including the ones Playwright restarts. */
const stamp = currentStamp();

/** Playwright restarts its worker after a failure, so rows are merged on disk per test rather than kept in memory. */
function saveRow(row: ReportRow, backend: string): void {
  const reportPath = `${reportFor(backend)}.json`;
  mkdirSync('docs', { recursive: true });
  const existing: unknown = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : [];
  writeFileSync(reportPath, JSON.stringify(mergeRows(existing, stampRow(row, stamp)), null, 2));
}

for (const asset of assets) {
  test(`asset ${asset.name}`, { tag: '@corpus' }, async ({ forge }) => {
    test.setTimeout(180_000);
    const row: ReportRow = { name: asset.name, tags: (asset.tags ?? []).join(' ') };
    try {
      await forge.open('gltf', { asset: asset.name, ...(process.env.FORGE_ASSETS_MATERIALS ? { materials: process.env.FORGE_ASSETS_MATERIALS } : {}) });
    } catch (error) {
      row.error = String(error instanceof Error ? error.message : error).split('\n')[0]!.slice(0, 200);
      saveRow(row, forge.backend);
      throw error;
    }
    const naive = await forge.page.evaluate(async () => {
      const f = window.__forge;
      for (let i = 0; i < 3; i++) await f.frameAsync(); // warm-up: reflectors and nested-pass pipelines settle a few frames late
      const frame = f.frame();
      return { totals: frame.totals, byReason: frame.byReason, info: f.gltf! };
    });
    Object.assign(row, { meshes: naive.info.meshes, materials: naive.info.materials, triangles: naive.info.triangles, animations: naive.info.animations, naive: naive.totals.sceneSubmissions, loadMs: naive.info.loadMs });
    const before = await forge.page.screenshot({ type: 'png' });

    const compiled = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const report = f.compile();
      await f.world.warmup(f.renderer, f.camera); // build the new batch pipelines before measuring (one scissored frame)
      for (let i = 0; i < 3; i++) await f.frameAsync();
      const frame = f.frame();
      const skipped = new Map<string, number>();
      for (const s of report.skipped) skipped.set(s.rule, (skipped.get(s.rule) ?? 0) + 1);
      return { report: { batches: report.after.batches, instanced: report.after.instanced, meshes: report.after.meshes, groups: report.groups.length }, totals: frame.totals, byReason: frame.byReason, skipped: [...skipped.entries()] };
    });
    const after = await forge.page.screenshot({ type: 'png' });
    const diff = pixelDiff(before, after, { requireSameSize: true });
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
      skipped: compiled.skipped.sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}:${n}`).join(' '),
      reasons: Object.entries(compiled.byReason).filter(([r]) => r !== 'renderer-internal').sort((a, b) => b[1].submissions - a[1].submissions).map(([r, v]) => `${r}:${v.submissions}`).join(' '),
    });
    saveRow(row, forge.backend);
    console.log(`${asset.name}: ${row.naive} -> ${row.compiled} submissions, diff ${row.diff}%, unattributed ${row.unattributed}`);
    expect.soft(compiled.totals.unattributed, 'unattributed draws').toBe(0);
    expect.soft(diff, 'pixel diff ratio after compile').toBeLessThan(0.005);
    expect.soft(restored, 'submissions after decompile').toBe(naive.totals.sceneSubmissions);
    expect.soft(compiled.totals.sceneSubmissions, 'compile never increases submissions').toBeLessThanOrEqual(naive.totals.sceneSubmissions);
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
  const expected = candidates.map((a) => a.name);
  // Nothing downloaded: "every expected asset was measured" would be vacuously true and would republish the
  // tracked table from rows this run never measured.
  if (expected.length === 0) return;
  for (const backend of ['webgl2', 'webgpu']) {
    const jsonPath = `${reportFor(backend)}.json`;
    if (!existsSync(jsonPath)) continue;
    const rows = JSON.parse(readFileSync(jsonPath, 'utf8')) as ReportRow[];
    // A materials override measures a different configuration; its numbers must not become the published table.
    const variant = process.env.FORGE_ASSETS_MATERIALS ? `FORGE_ASSETS_MATERIALS=${process.env.FORGE_ASSETS_MATERIALS}` : '';
    const missing = variant ? expected : missingFromRun(rows, expected, stamp.run);
    if (missing.length > 0) {
      const why = variant ? `run under ${variant}` : `run ${stamp.run} measured ${expected.length - missing.length}/${expected.length} assets (missing ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? `, +${missing.length - 4} more` : ''})`;
      console.log(`${reportFor(backend)}.md left unchanged: ${why}`);
      continue;
    }
    writeFileSync(`${reportFor(backend)}.md`, renderReport(rows, backend));
  }
});
