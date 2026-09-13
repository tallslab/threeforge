import { expect, test } from './fixtures.js';

/**
 * Every benchmark scene builds in both variants with every draw attributed. Bounds are deliberately loose:
 * exact numbers live in bench/baselines and are gated by `pnpm bench`.
 */
const scenes: Array<{ id: string; naiveMin: number; optimizedMax: number; counts: Record<string, number>; timeout?: number }> = [
  { id: 'village', naiveMin: 300, optimizedMax: 40, counts: { props: 300, materials: 40 } },
  { id: 'forest', naiveMin: 5000, optimizedMax: 16, counts: { trees: 5000, grass: 2000 } },
];

for (const s of scenes) {
  test(`${s.id}: naive and optimized variants render with every draw attributed`, async ({ forge }) => {
    if (s.timeout) test.setTimeout(s.timeout);
    await forge.open(s.id, { variant: 'naive' });
    const naive = await forge.page.evaluate(async () => {
      for (let i = 0; i < 3; i++) await window.__forge.frameAsync();
      const f = window.__forge.frame();
      return { totals: f.totals, env: f.env, counts: window.__forge.bench!.counts };
    });
    expect(naive.counts).toMatchObject(s.counts);
    expect(naive.totals.unattributed).toBe(0);
    expect(naive.totals.sceneSubmissions).toBeGreaterThanOrEqual(s.naiveMin);
    await forge.open(s.id, { variant: 'optimized' });
    const optimized = await forge.page.evaluate(async () => {
      for (let i = 0; i < 3; i++) await window.__forge.frameAsync();
      return window.__forge.frame().totals;
    });
    expect(optimized.unattributed).toBe(0);
    expect(optimized.sceneSubmissions).toBeLessThanOrEqual(s.optimizedMax);
  });
}
