import { expect, test } from './fixtures.js';

/**
 * @corpus for the same reason as particles.spec.ts: the arena's spot and point lights are added unconditionally, so
 * on a kit-less runner this would pass green against an empty arena — a boss-fight shadow budget measured with no
 * fighters to cast the shadows. The second test below uses the procedural naive scene and stays in CI.
 */
test('ShadowBudget on phone-low fits the boss fight shadows into 262k texels and drops the point-light shadow', {
  tag: '@corpus',
}, async ({ forge }) => {
  test.setTimeout(300_000);
  await forge.open('bossfight', { variant: 'naive', tier: 'phone-low', shadowBudget: '1' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    for (let i = 0; i < 2; i++) await f.frameAsync();
    const frame = await f.frameAsync();
    return {
      report: f.shadowReport!,
      texels: frame.lighting.shadowTexels,
      shadowLights: frame.lighting.shadowLights,
      passes: frame.passes.map((p) => p.id),
      unattributed: frame.totals.unattributed,
      hints: frame.hints.map((h) => h.code),
    };
  });
  expect(r.report.before).toBeGreaterThan(262_144);
  expect(r.report.after).toBeLessThanOrEqual(262_144);
  // Both spot maps render on every animation frame, so the texels rendered this frame are the budgeted sum.
  expect(r.texels).toBe(r.report.after);
  expect(r.shadowLights).toBe(2);
  expect(r.passes).toEqual(expect.arrayContaining(['shadow:spot-1', 'shadow:spot-2']));
  expect(r.passes.filter((id) => id.startsWith('shadow:point-'))).toEqual([]);
  expect(r.hints).not.toContain('point-light-shadow');
  expect(r.hints).not.toContain('shadow-texels');
  expect(r.unattributed).toBe(0);
});

test('a frozen sun shadow renders once, then only on refresh, and counts texels only on the frames it renders', async ({
  forge,
}) => {
  await forge.open('naive', { shadows: '1', 'freeze-shadow': '1' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const size = f.naive!.lights.directional.shadow.mapSize;
    const step = async (): Promise<[number, number]> => {
      const lighting = (await f.frameAsync()).lighting;
      return [lighting.shadowPasses, lighting.shadowTexels];
    };
    // A freshly created map renders twice on its first request (three allocates the target, which bumps the depth
    // texture version and clears needsUpdate one render later); settle it before measuring.
    const first = await step();
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const settled = await step();
    f.refreshShadow!();
    const refreshed = await step();
    const after = await step();
    return { sunTexels: size.x * size.y, first, settled, refreshed, after };
  });
  expect(r).toEqual({
    sunTexels: r.sunTexels,
    first: [1, r.sunTexels],
    settled: [0, 0],
    refreshed: [1, r.sunTexels],
    after: [0, 0],
  });
  expect(r.sunTexels).toBeGreaterThan(0);
});
