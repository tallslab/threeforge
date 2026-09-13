import { expect, test } from './fixtures.js';

/**
 * Every benchmark scene builds in both variants with every draw attributed. Bounds are deliberately loose:
 * exact numbers live in bench/baselines and are gated by `pnpm bench`.
 */
const scenes: Array<{ id: string; naiveMin: number; optimizedMax: number; counts: Record<string, number>; timeout?: number }> = [
  { id: 'village', naiveMin: 300, optimizedMax: 40, counts: { props: 300, materials: 40 } },
  { id: 'forest', naiveMin: 5000, optimizedMax: 16, counts: { trees: 5000, grass: 2000 } },
  // Skinned meshes are not batched until SP4 (VAT): the optimized crowd only bounds the count.
  { id: 'crowd', naiveMin: 200, optimizedMax: 420, counts: { characters: 200 } },
  { id: 'bossfight', naiveMin: 2000, optimizedMax: 480, counts: { effects: 30, fighters: 12 }, timeout: 240_000 },
  // Sprites are not batched until SP3 and the water reflection renders them twice: the lake's optimized bound is loose on purpose.
  { id: 'lake', naiveMin: 1900, optimizedMax: 4200, counts: { rain: 2000 } },
  { id: 'daynight', naiveMin: 300, optimizedMax: 70, counts: { props: 300, shadowMap: 2048 } },
];

for (const s of scenes) {
  test(`${s.id}: naive and optimized variants render with every draw attributed`, async ({ forge }) => {
    if (s.timeout) test.setTimeout(s.timeout);
    await forge.open(s.id, { variant: 'naive' });
    // Measured snapshots come from frameAsync(): shadow maps re-render only once per animation-frame tick.
    const naive = await forge.page.evaluate(async () => {
      for (let i = 0; i < 3; i++) await window.__forge.frameAsync();
      const f = await window.__forge.frameAsync();
      return { totals: f.totals, env: f.env, counts: window.__forge.bench!.counts };
    });
    expect(naive.counts).toMatchObject(s.counts);
    expect(naive.totals.unattributed).toBe(0);
    expect(naive.totals.sceneSubmissions).toBeGreaterThanOrEqual(s.naiveMin);
    await forge.open(s.id, { variant: 'optimized' });
    const optimized = await forge.page.evaluate(async () => {
      for (let i = 0; i < 3; i++) await window.__forge.frameAsync();
      return (await window.__forge.frameAsync()).totals;
    });
    expect(optimized.unattributed).toBe(0);
    expect(optimized.sceneSubmissions).toBeLessThanOrEqual(s.optimizedMax);
  });
}
