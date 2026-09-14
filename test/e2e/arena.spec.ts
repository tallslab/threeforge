import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';

test('the fight arena (skinned fighters, weapons on bones, shadowed lights, VFX) compiles with the same pixels and every draw explained', async ({ forge }) => {
  test.setTimeout(600_000);
  await forge.open('arena', { freeze: '1', dynamics: 'batch-sync', t: '1.1' });
  const naive = await forge.page.evaluate(async () => {
    const f = window.__forge;
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const frame = await f.frameAsync();
    return { totals: frame.totals, byReason: frame.byReason, passes: frame.passes, counts: f.arena!.counts, report: f.ledger.report() };
  });
  console.log(naive.report);
  const before = await forge.page.screenshot({ type: 'png' });
  const compiled = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const report = f.compile();
    await f.world.warmup(f.renderer, f.camera);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const frame = await f.frameAsync();
    const skipped = new Map<string, number>();
    for (const s of report.skipped) skipped.set(s.rule, (skipped.get(s.rule) ?? 0) + 1);
    return { totals: frame.totals, byReason: frame.byReason, passes: frame.passes, after: report.after, synced: report.synced, skipped: [...skipped.entries()].sort((a, b) => b[1] - a[1]), report: f.ledger.report() };
  });
  console.log(compiled.report);
  const after = await forge.page.screenshot({ type: 'png' });
  mkdirSync('test-results/arena', { recursive: true });
  writeFileSync(`test-results/arena/before-${forge.backend}.png`, before);
  writeFileSync(`test-results/arena/after-${forge.backend}.png`, after);
  const diff = pixelDiff(before, after, { diffPath: `test-results/arena/diff-${forge.backend}.png` });
  console.log(JSON.stringify({ counts: naive.counts, naive: naive.totals.sceneSubmissions, compiled: compiled.totals.sceneSubmissions, after: compiled.after, synced: compiled.synced, skipped: compiled.skipped, passes: compiled.passes.map((p) => `${p.id}=${p.submissions}`), diffPct: (diff * 100).toFixed(2) }));

  // Animation must still drive the scene after compile: advance time and expect pixels to change.
  await forge.page.evaluate(async () => {
    window.__forge.setTime(1.6);
    await window.__forge.frameAsync();
  });
  const later = await forge.page.screenshot({ type: 'png' });
  const motion = pixelDiff(after, later);

  expect(naive.totals.unattributed).toBe(0);
  expect(compiled.totals.unattributed).toBe(0);
  expect(compiled.totals.sceneSubmissions).toBeLessThan(naive.totals.sceneSubmissions * 0.5);
  expect(compiled.passes.map((p) => p.id)).toEqual(expect.arrayContaining(['shadow:spot-1', 'shadow:spot-2', 'shadow:point-1', 'main']));
  expect(compiled.byReason.skinned?.submissions).toBeGreaterThan(0);
  expect(compiled.byReason.points?.submissions).toBe(6);
  // Health bars and hit markers share two materials: two sprite batches instead of 16 sprite draws.
  expect(compiled.byReason['sprite-batch']?.submissions).toBe(2);
  expect(compiled.byReason.sprite?.submissions).toBeUndefined();
  // Weapons hang off hand bones: dynamic, and with batch-sync they ride in batches (counted in `synced`).
  expect(compiled.synced).toBeGreaterThanOrEqual(naive.counts.fighters! + naive.counts.blocky! * 6);
  expect(compiled.skipped).toEqual(expect.arrayContaining([expect.arrayContaining(['dynamic-geometry'])]));
  expect(diff).toBeLessThan(0.01);
  expect(motion).toBeGreaterThan(0.005);
});

test('bloom post-processing: the scene is a nested main pass under fullscreen quads, all attributed', async ({ forge }) => {
  test.setTimeout(600_000);
  await forge.open('arena', { freeze: '1', dynamics: 'batch-sync', t: '1.1', bloom: '1', fighters: '4', blocky: '4' });
  const result = await forge.page.evaluate(async () => {
    const f = window.__forge;
    for (let i = 0; i < 2; i++) await f.frameAsync();
    const naive = await f.frameAsync();
    f.compile();
    await f.world.warmup(f.renderer, f.camera);
    for (let i = 0; i < 2; i++) await f.frameAsync();
    const compiled = await f.frameAsync();
    return { naive: naive.totals, naivePasses: naive.passes.map((p) => p.id), compiled: compiled.totals, passes: compiled.passes.map((p) => `${p.id}=${p.submissions}`), byReason: compiled.byReason };
  });
  console.log(JSON.stringify(result));
  expect(result.naive.unattributed).toBe(0);
  expect(result.compiled.unattributed).toBe(0);
  expect(result.passes.some((p) => p.startsWith('main='))).toBe(true);
  expect(result.passes.some((p) => p.startsWith('fullscreen='))).toBe(true);
  expect(result.byReason['fullscreen-pass']?.submissions).toBeGreaterThan(0);
  expect(result.compiled.sceneSubmissions).toBeLessThan(result.naive.sceneSubmissions * 0.6);
});

test('assembleCharacter on the Kenney fighters halves their skinned draws', async ({ forge }) => {
  test.setTimeout(600_000);
  await forge.open('arena', { freeze: '1', t: '1.1', assemble: '1', blocky: '0', vfx: '0', shadows: '0' });
  const result = await forge.page.evaluate(async () => {
    const f = window.__forge;
    for (let i = 0; i < 2; i++) await f.frameAsync();
    const frame = await f.frameAsync();
    return { skinned: frame.byReason.skinned?.submissions, assembled: f.arena!.counts.assembled, fighters: f.arena!.counts.fighters, unattributed: frame.totals.unattributed };
  });
  console.log(JSON.stringify(result));
  expect(result.assembled).toBe(result.fighters);
  expect(result.skinned).toBe(result.fighters);
  expect(result.unattributed).toBe(0);
});
