import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';

test('the biome (terrain, water, thousands of props, cars, hi-poly rocks) compiles to a few dozen submissions with the same pixels', async ({ forge }) => {
  test.setTimeout(600_000);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('FORGE_BIOME_Q_') && v) extra[k.slice('FORGE_BIOME_Q_'.length).toLowerCase()] = v;
  await forge.open('biome', { freeze: '1', density: process.env.FORGE_BIOME_DENSITY ?? '1', dynamics: process.env.FORGE_BIOME_DYNAMICS ?? 'batch-sync', ...extra });
  const naive = await forge.page.evaluate(async () => {
    const f = window.__forge;
    // Warm-up: three's reflector fills its render target one frame late, and WebGPU compiles the reflection
    // pass's pipelines asynchronously, so let a few animation frames settle before measuring.
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const t0 = performance.now();
    const frame = f.frame();
    return { totals: frame.totals, byReason: frame.byReason, counts: f.biome!.counts, programs: f.registry.stats().programs, ms: performance.now() - t0 };
  });
  const before = await forge.page.screenshot({ type: 'png' });
  const compiled = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const t0 = performance.now();
    const report = f.compile();
    const compileMs = performance.now() - t0;
    await f.world.warmup(f.renderer, f.camera); // build the new batch pipelines before measuring
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const frame = f.frame();
    const skipped = new Map<string, number>();
    for (const s of report.skipped) skipped.set(s.rule, (skipped.get(s.rule) ?? 0) + 1);
    return { totals: frame.totals, byReason: frame.byReason, after: report.after, groups: report.groups.length, skipped: [...skipped.entries()].sort((a, b) => b[1] - a[1]), compileMs, text: f.ledger.report() };
  });
  const after = await forge.page.screenshot({ type: 'png' });
  mkdirSync('test-results/biome', { recursive: true });
  writeFileSync(`test-results/biome/before-${forge.backend}.png`, before);
  writeFileSync(`test-results/biome/after-${forge.backend}.png`, after);
  const diff = pixelDiff(before, after, { diffPath: `test-results/biome/diff-${forge.backend}.png` });
  console.log(compiled.text);
  console.log(JSON.stringify({ counts: naive.counts, naive: naive.totals.sceneSubmissions, compiled: compiled.totals.sceneSubmissions, after: compiled.after, skipped: compiled.skipped.slice(0, 8), diffPct: (diff * 100).toFixed(2), compileMs: Math.round(compiled.compileMs), triangles: compiled.totals.triangles, instances: compiled.totals.instances, instancesDrawn: compiled.totals.instancesDrawn }));
  expect(naive.totals.sceneSubmissions).toBeGreaterThan(process.env.FORGE_BIOME_DENSITY ? 100 : 3000);
  expect(compiled.totals.unattributed).toBe(0);
  expect(compiled.totals.sceneSubmissions).toBeLessThan(naive.totals.sceneSubmissions / 10);
  expect(diff).toBeLessThan(0.01);
});
