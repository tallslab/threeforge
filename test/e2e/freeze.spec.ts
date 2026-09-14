import { PNG } from 'pngjs';
import { expect, test } from './fixtures.js';

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

test('freezing: the compiled village recomposes far fewer matrices per frame with the same pixels', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('village', { variant: 'naive', freeze: '1' });
  await settle(forge.page);
  const naive = await forge.page.evaluate(async () => {
    const f = window.__forge;
    f.ledger.rescan();
    const frame = await f.frameAsync();
    return { auto: frame.js.autoUpdatedMatrices, objects: frame.js.objects, hints: frame.hints.map((h) => h.code) };
  });
  const before = await forge.page.screenshot({ type: 'png' });
  const compiled = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const report = f.compile();
    await f.world.warmup(f.renderer, f.camera);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    f.ledger.rescan();
    const frame = await f.frameAsync();
    return { frozen: report.after.frozen, auto: frame.js.autoUpdatedMatrices, hidden: frame.js.hiddenOriginals, hints: frame.hints.map((h) => h.code), unattributed: frame.totals.unattributed };
  });
  const after = await forge.page.screenshot({ type: 'png' });
  console.log(`village autoUpdatedMatrices ${naive.auto} -> ${compiled.auto} (frozen ${compiled.frozen}, hidden ${compiled.hidden})`);
  expect(compiled.auto).toBeLessThan(naive.auto / 4);
  expect(compiled.hidden).toBeGreaterThan(200);
  expect(compiled.hints).not.toContain('static-auto-update');
  expect(compiled.unattributed).toBe(0);
  expect(pixelDiff(before, after)).toBeLessThan(0.005);
});

test('markDirty: a batched prop moved after compile renders where the naive scene puts it', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  const move = async (compiled: boolean) => {
    await forge.open('naive', compiled ? { compile: '1' } : {});
    await settle(forge.page);
    await forge.page.evaluate(async (compiledFlag) => {
      const f = window.__forge;
      const prop = f.naive!.props[7]!;
      prop.position.x += 12;
      prop.position.y += 6;
      if (compiledFlag) {
        const updated = f.world.markDirty(prop);
        if (updated !== 1) throw new Error(`markDirty updated ${updated} instances`);
      }
      for (let i = 0; i < 3; i++) await f.frameAsync();
    }, compiled);
    return forge.page.screenshot({ type: 'png' });
  };
  const naiveMoved = await move(false);
  const compiledMoved = await move(true);
  const diff = pixelDiff(naiveMoved, compiledMoved);
  console.log(`markDirty pixel diff ${(diff * 100).toFixed(3)}%`);
  expect(diff).toBeLessThan(0.005);
});
