import { expect, test } from './fixtures.js';

/** DayNight re-renders the sun's shadow map only when the sun moved: every second stepped frame here, versus every frame naive. */
test('daynight optimized renders the shadow map every second frame and the sky dome once', async ({ forge }) => {
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
      // Texels count only the frames the map renders on: summed over the steps.
      let texels = 0;
      let last = await f.frameAsync();
      for (let i = 0; i < 10; i++) {
        f.bench!.setTime!(10 + (4 + i) / 60);
        last = await f.frameAsync();
        passes.push(last.lighting.shadowPasses);
        texels += last.lighting.shadowTexels;
      }
      return {
        passes,
        submissions: last.totals.sceneSubmissions,
        unattributed: last.totals.unattributed,
        texels,
        directional: last.lighting.lights.directional,
        hemisphere: last.lighting.lights.hemisphere,
        unique: last.byReason['unique-material']?.top ?? [],
      };
    });
  };
  const naive = await stepped('naive');
  const optimized = await stepped('optimized');
  expect(naive.passes).toEqual(Array(10).fill(1));
  expect(optimized.passes.reduce((a, b) => a + b, 0)).toBe(5);
  expect(optimized.directional).toBe(1);
  expect(optimized.hemisphere).toBe(1);
  expect(optimized.unique).toContain('sky-dome');
  // The 2048² sun map: every step naive, every second step optimized.
  expect(naive.texels).toBe(10 * 2048 * 2048);
  expect(optimized.texels).toBe(5 * 2048 * 2048);
  expect(optimized.submissions).toBeLessThan(naive.submissions / 5);
  expect(optimized.unattributed).toBe(0);
  expect(naive.unattributed).toBe(0);
});
