import { expect, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';

/**
 * three r186's `renderer.compileAsync()` builds render objects after `renderObject()` has restored
 * `material.side`, so transparent double-sided materials (foliage) and transmissive ones (glass) are compiled as
 * if single-pass DoubleSide, and transmission samples a viewport texture that is never written. Those cached
 * render objects then draw wrong for the rest of the session. `world.warmup()` must leave the picture exactly as
 * a cold first frame would, in both of its modes, on both backends.
 */

const cases = [
  { asset: 'polyhaven-fir_sapling_medium', what: 'alpha-blended double-sided foliage batched into one BatchedMesh', repaired: 1 },
  { asset: 'CommercialRefrigerator', what: 'transmissive glass (excluded from batching)', repaired: 1 },
];

for (const mode of ['frame', 'async'] as const) {
  for (const c of cases) {
    test(`warmup(${mode}) keeps ${c.what} pixel-identical to a cold frame`, async ({ forge }) => {
      test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
      await forge.open('gltf', { asset: c.asset });
      await forge.page.evaluate(async () => {
        for (let i = 0; i < 3; i++) await window.__forge.frameAsync();
      });
      const cold = await forge.page.screenshot({ type: 'png' });
      const result = await forge.page.evaluate(async (mode) => {
        const f = window.__forge;
        f.compile();
        const result = await f.world.warmup(f.renderer, f.camera, { mode });
        for (let i = 0; i < 3; i++) await f.frameAsync();
        return { ...result, unattributed: f.frame().totals.unattributed };
      }, mode);
      const warmed = await forge.page.screenshot({ type: 'png' });
      // And back: decompile() restores the originals, so the picture must return to the cold frame it started from.
      await forge.page.evaluate(async () => {
        const f = window.__forge;
        f.decompile();
        for (let i = 0; i < 3; i++) await f.frameAsync();
      });
      const restored = await forge.page.screenshot({ type: 'png' });
      expect(result.mode).toBe(mode);
      expect(result.unattributed).toBe(0);
      if (mode === 'async') expect(result.repaired).toBeGreaterThanOrEqual(c.repaired);
      expect(pixelDiff(cold, warmed, { threshold: 4 }), 'pixels changed by warm-up').toBeLessThan(0.0005);
      expect(pixelDiff(cold, restored, { threshold: 4 }), 'pixels changed by decompile() after warm-up').toBeLessThan(0.0005);
    });
  }
}
