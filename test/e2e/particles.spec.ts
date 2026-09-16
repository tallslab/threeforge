import { expect, test } from './fixtures.js';

/**
 * ParticleBudget on the boss fight, forced to the low phone tier: fewer particles drawn, every draw still attributed.
 *
 * @corpus even though the particles themselves are procedural (`Points` over generated geometry, whose kit textures
 * are optional). The boss fight reaches buildArena, so without the Kenney kits the arena has no fighters, no blocky
 * characters and no props — and this test would very likely still pass, reporting green while measuring a scene it
 * is not named for. False coverage that looks green is worse than coverage deferred to the full-corpus run.
 */
test('ParticleBudget caps the boss fight particles on phone-low and clears the hint', { tag: '@corpus' }, async ({ forge }) => {
  test.setTimeout(300_000);
  const read = async () =>
    forge.page.evaluate(async () => {
      const f = window.__forge;
      for (let i = 0; i < 2; i++) await f.frameAsync();
      const frame = await f.frameAsync();
      return { particles: frame.overdraw.particles, unattributed: frame.totals.unattributed, hints: frame.hints.map((h) => h.code), report: f.particleReport ?? null, points: frame.byReason.points?.submissions ?? 0 };
    });
  await forge.open('bossfight', { variant: 'naive', tier: 'phone-low' });
  const free = await read();
  await forge.open('bossfight', { variant: 'naive', tier: 'phone-low', particles: '1' });
  const capped = await read();
  expect(free.particles).toBeGreaterThan(5000);
  expect(free.hints).toContain('particles-over-budget');
  expect(capped.report).not.toBeNull();
  expect(capped.report!.ratio).toBeLessThan(1);
  expect(capped.report!.after).toBeLessThanOrEqual(5000);
  expect(capped.particles).toBeLessThanOrEqual(5000);
  expect(capped.particles).toBeLessThan(free.particles);
  expect(capped.points).toBe(free.points);
  expect(capped.hints).not.toContain('particles-over-budget');
  expect(capped.unattributed).toBe(0);
});
