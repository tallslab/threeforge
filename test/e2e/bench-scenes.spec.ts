import { expect, test } from './fixtures.js';

/**
 * Every benchmark scene builds in both variants with every draw attributed. Bounds are deliberately loose:
 * exact numbers live in bench/baselines and are gated by `pnpm bench`.
 */
/** `tag: '@corpus'` marks a scene that cannot build without downloaded content, so a corpus-less CI must skip it. */
const scenes: Array<{ id: string; naiveMin: number; optimizedMax: number; counts: Record<string, number>; timeout?: number; tag?: string }> = [
  { id: 'village', naiveMin: 300, optimizedMax: 40, counts: { props: 300, materials: 40 } },
  { id: 'forest', naiveMin: 5000, optimizedMax: 16, counts: { trees: 5000, grass: 2000 } },
  // Skinned meshes are not batched until SP4 (VAT): the optimized crowd only bounds the count.
  // Loads the eight Kenney mini-character GLBs (test/app/scenes/crowd.ts throws without the kit), so: @corpus.
  { id: 'crowd', naiveMin: 200, optimizedMax: 420, counts: { characters: 200 }, tag: '@corpus' },
  // Delegates to buildArena (test/app/arena.ts), which fetches /kits-index.json and loads the Kenney mini-character,
  // blocky-character, arena and blaster GLBs. A missing kit does not throw: `if (!proto) continue` leaves
  // counts.fighters and counts.blocky at 0 and attaches no sprites, so the counts and naiveMin below would fail
  // rather than skip on a kit-less runner. Found by following the delegation, not by grepping this scene: @corpus.
  { id: 'bossfight', naiveMin: 2000, optimizedMax: 480, counts: { effects: 30, fighters: 12 }, timeout: 240_000, tag: '@corpus' },
  // Sprites are not batched until SP3 and the water reflection renders them twice: the lake's optimized bound is loose on purpose.
  // The water loads waternormals.jpg from the downloaded content (test/app/scenes/lake.ts), so: @corpus.
  { id: 'lake', naiveMin: 1900, optimizedMax: 4200, counts: { rain: 2000 }, tag: '@corpus' },
  { id: 'daynight', naiveMin: 300, optimizedMax: 70, counts: { props: 300, shadowMap: 2048 } },
  // Fog ends the zen view at 600 m, so three's own frustum culling already drops most of the 50 000 objects in the naive variant.
  { id: 'zen', naiveMin: 3000, optimizedMax: 420, counts: { objects: 50000, chunks: 64 }, timeout: 600_000 },
  // One of four gear pieces is always taken off: body + 3 gear naive, one merged skinned mesh optimized.
  { id: 'rpg', naiveMin: 4, optimizedMax: 1, counts: { gear: 4 } },
];

for (const s of scenes) {
  test(`${s.id}: naive and optimized variants render with every draw attributed`, { tag: s.tag ?? [] }, async ({ forge }) => {
    if (s.timeout) test.setTimeout(s.timeout);
    await forge.open(s.id, { variant: 'naive' });
    // Measured snapshots come from frameAsync(): shadow maps re-render only once per animation-frame tick.
    const naive = await forge.page.evaluate(async () => {
      for (let i = 0; i < 3; i++) await window.__forge.frameAsync();
      const f = await window.__forge.frameAsync();
      return { totals: f.totals, env: f.env, counts: window.__forge.bench!.counts };
    });
    expect(naive.counts).toMatchObject(s.counts);
    if (s.id === 'rpg') expect(naive.env.viewport).toEqual([450, 800]);
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
