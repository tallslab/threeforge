import { PNG } from 'pngjs';
import { expect, test } from './fixtures.js';

/** Sprite batching must not change a pixel: every case compares the naive render with the compiled one. */
function pixelDiff(a: Buffer, b: Buffer): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  let n = 0;
  for (let i = 0; i < pa.width * pa.height; i++) {
    const o = i * 4;
    if (Math.max(Math.abs(pa.data[o]! - pb.data[o]!), Math.abs(pa.data[o + 1]! - pb.data[o + 1]!), Math.abs(pa.data[o + 2]! - pb.data[o + 2]!)) > 24) n++;
  }
  return n / (pa.width * pa.height);
}
const settle = (page: import('@playwright/test').Page) => page.evaluate(async () => { for (let i = 0; i < 3; i++) await window.__forge.frameAsync(); });

test('the lake: 2000 raindrop sprites become one submission per pass, pixels stay, decompile restores', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('lake', { variant: 'naive', freeze: '1' });
  await settle(forge.page);
  const naive = await forge.page.evaluate(async () => {
    const f = window.__forge;
    f.bench?.setTime?.(0.5);
    const frame = await f.frameAsync();
    return { submissions: frame.totals.sceneSubmissions, sprites: frame.byReason.sprite?.submissions ?? 0, particles: frame.overdraw.particles, hints: frame.hints.map((h) => h.code) };
  });
  const before = await forge.page.screenshot({ type: 'png' });
  const compiled = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const report = f.compile();
    await f.world.warmup(f.renderer, f.camera);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const frame = await f.frameAsync();
    return { spriteBatches: report.after.spriteBatches, submissions: frame.totals.sceneSubmissions, batch: frame.byReason['sprite-batch']?.submissions ?? 0, sprites: frame.byReason.sprite?.submissions ?? 0, particles: frame.overdraw.particles, unattributed: frame.totals.unattributed };
  });
  const after = await forge.page.screenshot({ type: 'png' });
  // Main pass plus the water's reflection pass (which sees fewer drops).
  expect(naive.sprites).toBeGreaterThanOrEqual(2000);
  expect(naive.hints).toContain('sprites-unbatched');
  expect(compiled.spriteBatches).toBe(1);
  expect(compiled.sprites).toBe(0);
  // Main pass plus the water's reflection pass each draw the batch once.
  expect(compiled.batch).toBe(2);
  expect(compiled.submissions).toBeLessThan(120);
  expect(compiled.unattributed).toBe(0);
  // The batch culls per instance like three culls sprites: the same drops are drawn.
  expect(compiled.particles).toBe(naive.particles);
  expect(naive.particles).toBeLessThan(2000);
  const diff = pixelDiff(before, after);
  console.log(`lake sprite batch pixel diff ${(diff * 100).toFixed(3)}% · submissions ${naive.submissions} -> ${compiled.submissions}`);
  expect(diff).toBeLessThan(0.005);
  const restored = await forge.page.evaluate(async () => {
    const f = window.__forge;
    f.decompile();
    const frame = await f.frameAsync();
    return frame.byReason.sprite?.submissions ?? 0;
  });
  expect(restored).toBe(naive.sprites);
});

test('the bossfight: health bars and hit markers become two batches among the effects', async ({ forge }) => {
  await forge.open('bossfight', { variant: 'naive' });
  await settle(forge.page);
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const naive = await f.frameAsync();
    const report = f.compile();
    await f.world.warmup(f.renderer, f.camera);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const frame = await f.frameAsync();
    return { naiveSprites: naive.byReason.sprite?.submissions ?? 0, spriteBatches: report.after.spriteBatches, batches: frame.byReason['sprite-batch']?.submissions ?? 0, sprites: frame.byReason.sprite?.submissions ?? 0, unattributed: frame.totals.unattributed, particles: frame.overdraw.particles };
  });
  expect(r.naiveSprites).toBeGreaterThanOrEqual(16);
  expect(r.spriteBatches).toBe(2);
  expect(r.sprites).toBe(0);
  expect(r.batches).toBeGreaterThanOrEqual(2);
  expect(r.unattributed).toBe(0);
  expect(r.particles).toBeGreaterThan(7000);
});
