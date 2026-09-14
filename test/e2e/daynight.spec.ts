import { expect, test } from './fixtures.js';

/** DayNight re-renders the sun's shadow map only when the sun moved: every second stepped frame here, versus every frame naive. */
test('daynight: the optimized variant renders the shadow map every second frame and draws the sky dome once', async ({ forge }) => {
  test.setTimeout(300_000);
  const stepped = async (variant: 'naive' | 'optimized') => {
    await forge.open('daynight', { variant, dome: '1' });
    return forge.page.evaluate(async () => {
      const f = window.__forge;
      for (let i = 0; i < 4; i++) {
        f.bench!.setTime!(10 + i / 60);
        await f.frameAsync();
      }
      const passes: number[] = [];
      let last = await f.frameAsync();
      for (let i = 0; i < 10; i++) {
        f.bench!.setTime!(10 + (4 + i) / 60);
        last = await f.frameAsync();
        passes.push(last.lighting.shadowPasses);
      }
      return { passes, submissions: last.totals.sceneSubmissions, unattributed: last.totals.unattributed, texels: last.lighting.shadowTexels, directional: last.lighting.lights.directional, hemisphere: last.lighting.lights.hemisphere, unique: last.byReason['unique-material']?.top ?? [] };
    });
  };
  const naive = await stepped('naive');
  const optimized = await stepped('optimized');
  expect(naive.passes).toEqual(Array(10).fill(1));
  expect(optimized.passes.reduce((a, b) => a + b, 0)).toBe(5);
  expect(optimized.directional).toBe(1);
  expect(optimized.hemisphere).toBe(1);
  expect(optimized.unique).toContain('sky-dome');
  expect(optimized.texels).toBe(naive.texels);
  expect(optimized.submissions).toBeLessThan(naive.submissions / 5);
  expect(optimized.unattributed).toBe(0);
  expect(naive.unattributed).toBe(0);
});
