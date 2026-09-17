import { expect, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';

/** The crowd as animated instances: 200 skinned characters become one draw per prototype part, still moving. */
test('crowd: animated instances replace 200 skinned draws with 16, moving like the mixers', {
  tag: '@corpus',
}, async ({ forge }) => {
  test.setTimeout(300_000);
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  const at = async (variant: 'naive' | 'optimized', t: number) => {
    await forge.open('crowd', { variant });
    const frame = await forge.page.evaluate(async (time) => {
      const f = window.__forge;
      f.bench!.setTime!(time);
      for (let i = 0; i < 3; i++) await f.frameAsync();
      const frame = await f.frameAsync();
      return {
        submissions: frame.totals.sceneSubmissions,
        vat: frame.byReason['vat-instanced']?.submissions ?? 0,
        skinned: frame.byReason.skinned?.submissions ?? 0,
        vertices: frame.skinning.vertices,
        vatInstances: frame.skinning.vatInstances,
        vatVertices: frame.skinning.vatVertices,
        unattributed: frame.totals.unattributed,
        hints: frame.hints.map((h) => h.code),
      };
    }, t);
    return { frame, png: await forge.page.screenshot({ type: 'png' }) };
  };
  const optimized0 = await at('optimized', 0);
  const optimized1 = await at('optimized', 1);
  const naive1 = await at('naive', 1);
  expect(optimized1.frame.submissions).toBeLessThanOrEqual(20);
  expect(optimized1.frame.vat).toBe(16);
  expect(optimized1.frame.skinned).toBe(0);
  expect(optimized1.frame.vertices).toBe(0);
  // 200 characters × 2 parts: the ledger counts instances per mesh.
  expect(optimized1.frame.vatInstances).toBe(400);
  expect(optimized1.frame.vatVertices).toBeGreaterThan(200_000);
  expect(optimized1.frame.unattributed).toBe(0);
  expect(optimized1.frame.hints).not.toContain('skinned-crowd');
  expect(naive1.frame.hints).toContain('skinned-crowd');
  const motion = pixelDiff(optimized0.png, optimized1.png);
  const likeness = pixelDiff(naive1.png, optimized1.png);
  console.log(`crowd vat: motion ${(motion * 100).toFixed(2)}% · naive vs vat at t=1 ${(likeness * 100).toFixed(2)}%`);
  expect(motion).toBeGreaterThan(0.005);
  expect(likeness).toBeLessThan(0.03);
});
