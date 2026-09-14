import { expect, test } from './fixtures.js';

/** ResolutionScaler: a smaller drawing buffer, reported as pixels and dpr, with every draw still attributed. */
test('ResolutionScaler at 0.5 renders a quarter of the pixels and reports it', async ({ forge }) => {
  await forge.open('naive', { compile: '1', scale: '0.5' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const half = await f.frameAsync();
    f.scaler!.set(1);
    const full = await f.frameAsync();
    f.scaler!.dispose();
    return { half: { pixels: half.overdraw.pixels, dpr: half.env.dpr, unattributed: half.totals.unattributed, submissions: half.totals.sceneSubmissions }, full: { pixels: full.overdraw.pixels, dpr: full.env.dpr } };
  });
  expect(r.half.pixels).toBe(400 * 300);
  expect(r.half.dpr).toBe(0.5);
  expect(r.half.unattributed).toBe(0);
  expect(r.half.submissions).toBeLessThanOrEqual(30);
  expect(r.full.pixels).toBe(800 * 600);
  expect(r.full.dpr).toBe(1);
});
