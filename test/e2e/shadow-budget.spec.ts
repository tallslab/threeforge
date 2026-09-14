import { expect, test } from './fixtures.js';

test('ShadowBudget on phone-low fits the boss fight shadows into 262k texels and drops the point-light shadow', async ({ forge }) => {
  test.setTimeout(300_000);
  await forge.open('bossfight', { variant: 'naive', tier: 'phone-low', shadowBudget: '1' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    for (let i = 0; i < 2; i++) await f.frameAsync();
    const frame = await f.frameAsync();
    return { report: f.shadowReport!, texels: frame.lighting.shadowTexels, shadowLights: frame.lighting.shadowLights, passes: frame.passes.map((p) => p.id), unattributed: frame.totals.unattributed, hints: frame.hints.map((h) => h.code) };
  });
  expect(r.report.before).toBeGreaterThan(262_144);
  expect(r.report.after).toBeLessThanOrEqual(262_144);
  expect(r.texels).toBe(r.report.after);
  expect(r.shadowLights).toBe(2);
  expect(r.passes).not.toContain('shadow:point-1');
  expect(r.hints).not.toContain('point-light-shadow');
  expect(r.hints).not.toContain('shadow-texels');
  expect(r.unattributed).toBe(0);
});

test('a frozen sun shadow renders once, then only on refresh', async ({ forge }) => {
  await forge.open('naive', { shadows: '1', 'freeze-shadow': '1' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    // A freshly created map renders twice on its first request (three allocates the target, which bumps the depth
    // texture version and clears needsUpdate one render later); settle it before measuring.
    const first = (await f.frameAsync()).lighting.shadowPasses;
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const settled = (await f.frameAsync()).lighting.shadowPasses;
    f.refreshShadow!();
    const refreshed = (await f.frameAsync()).lighting.shadowPasses;
    const after = (await f.frameAsync()).lighting.shadowPasses;
    return { first, settled, refreshed, after };
  });
  expect(r).toEqual({ first: 1, settled: 0, refreshed: 1, after: 0 });
});
