/**
 * Dogfooding on public glTF assets (test/assets/files, fetched by `pnpm assets`). Every asset is loaded, rendered
 * naively, compiled with policy 'auto', rendered again and compared pixel by pixel, then decompiled. Assertions are
 * soft so the whole report gets written to docs/assets-report.{json,md}; the run still fails if any asset misbehaves.
 * FORGE_ASSETS=Fox,Duck limits the run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { expect, test } from './fixtures.js';

interface AssetEntry {
  name: string;
  entry?: string;
  tags?: string[];
  error?: string;
  kind?: string;
}

interface Row {
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
}

const files = 'test/assets/files';
const lists: AssetEntry[] = [];
for (const f of ['index.json', 'kits-index.json']) {
  if (existsSync(`${files}/${f}`)) lists.push(...(JSON.parse(readFileSync(`${files}/${f}`, 'utf8')) as AssetEntry[]));
}
const only = process.env.FORGE_ASSETS?.split(',').map((s) => s.trim());
const assets = lists.filter((a) => a.entry && /\.(gltf|glb)$/i.test(a.entry) && !a.error && a.kind !== 'kit' && (!only || only.includes(a.name)));
const reportFor = (backend: string) => (backend === 'webgl2' ? 'docs/assets-report' : `docs/assets-report-${backend}`);

/** Playwright restarts its worker after a failure, so rows are merged on disk per test rather than kept in memory. */
function saveRow(row: Row, backend: string): Row[] {
  const reportPath = `${reportFor(backend)}.json`;
  mkdirSync('docs', { recursive: true });
  const rows: Row[] = existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as Row[]) : [];
  const i = rows.findIndex((r) => r.name === row.name);
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  rows.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(reportPath, JSON.stringify(rows, null, 2));
  return rows;
}

function pixelDiff(a: Buffer, b: Buffer): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return 1;
  let differing = 0;
  const n = pa.width * pa.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(pa.data[o]! - pb.data[o]!), Math.abs(pa.data[o + 1]! - pb.data[o + 1]!), Math.abs(pa.data[o + 2]! - pb.data[o + 2]!));
    if (d > 24) differing++;
  }
  return differing / n;
}

for (const asset of assets) {
  test(`asset ${asset.name}`, async ({ forge }) => {
    test.setTimeout(180_000);
    const row: Row = { name: asset.name, tags: (asset.tags ?? []).join(' ') };
    try {
      await forge.open('gltf', { asset: asset.name, ...(process.env.FORGE_ASSETS_MATERIALS ? { materials: process.env.FORGE_ASSETS_MATERIALS } : {}) });
    } catch (error) {
      row.error = String(error instanceof Error ? error.message : error).split('\n')[0]!.slice(0, 200);
      saveRow(row, forge.backend);
      throw error;
    }
    const naive = await forge.page.evaluate(() => {
      const f = window.__forge;
      for (let i = 0; i < 3; i++) f.frame(); // warm-up: reflectors and nested-pass pipelines settle a few frames late
      const frame = f.frame();
      return { totals: frame.totals, byReason: frame.byReason, info: f.gltf! };
    });
    Object.assign(row, { meshes: naive.info.meshes, materials: naive.info.materials, triangles: naive.info.triangles, animations: naive.info.animations, naive: naive.totals.sceneSubmissions, loadMs: naive.info.loadMs });
    const before = await forge.page.screenshot({ type: 'png' });

    const compiled = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const report = f.compile();
      await f.world.warmup(f.renderer, f.camera); // new batch pipelines compile asynchronously on WebGPU
      for (let i = 0; i < 3; i++) f.frame();
      const frame = f.frame();
      const skipped = new Map<string, number>();
      for (const s of report.skipped) skipped.set(s.rule, (skipped.get(s.rule) ?? 0) + 1);
      return { report: { batches: report.after.batches, instanced: report.after.instanced, meshes: report.after.meshes, groups: report.groups.length }, totals: frame.totals, byReason: frame.byReason, skipped: [...skipped.entries()] };
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

test.afterAll(() => {
  for (const backend of ['webgl2', 'webgpu']) {
    const jsonPath = `${reportFor(backend)}.json`;
    if (!existsSync(jsonPath)) continue;
    const rows = JSON.parse(readFileSync(jsonPath, 'utf8')) as Row[];
    const header = '| asset | meshes | materials | tris | anim | naive | compiled | batches | inst | unattr | diff % | restored | skipped | notes |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
    const body = rows
      .map((r) => `| ${r.name} | ${r.meshes ?? ''} | ${r.materials ?? ''} | ${r.triangles ?? ''} | ${r.animations ?? ''} | ${r.naive ?? ''} | ${r.compiled ?? ''} | ${r.batches ?? ''} | ${r.instanced ?? ''} | ${r.unattributed ?? ''} | ${r.diff ?? ''} | ${r.restored ?? ''} | ${r.skipped ?? ''} | ${r.error ?? ''} |`)
      .join('\n');
    const total = rows.length;
    const ok = rows.filter((r) => !r.error && r.unattributed === 0 && (r.diff ?? 1) < 0.5 && r.restored === r.naive).length;
    writeFileSync(`${reportFor(backend)}.md`, `# Public asset report (${backend})\n\nGenerated by \`pnpm assets:report\` on the ${backend} backend. ${ok}/${total} assets compile cleanly (0 unattributed, < 0.5% pixels changed, decompile restores).\n\n${header}${body}\n`);
  }
});
