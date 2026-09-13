import { expect, test } from './fixtures.js';

test('20k-instance field: one batch, BVH culling draws only what the camera sees, nothing unattributed', async ({ forge }) => {
  await forge.open('field', { count: '20000' });
  const result = await forge.page.evaluate(() => {
    const f = window.__forge;
    const visible = f.visibleMeshes();
    const before = f.frame();
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) f.renderOnce();
    const naiveMs = (performance.now() - t0) / 5;
    const report = f.compile();
    const after = f.frame();
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) f.renderOnce();
    const compiledMs = (performance.now() - t1) / 5;
    return { visible, before: before.totals, after: after.totals, batches: report.after.batches, culling: report.culling, naiveMs, compiledMs };
  });
  console.log(JSON.stringify(result));
  expect(result.before.sceneSubmissions).toBe(result.visible);
  expect(result.batches).toBe(1);
  expect(result.culling.mode).toBe('bvh');
  expect(result.after.sceneSubmissions).toBe(1);
  expect(result.after.instances).toBe(20_000);
  expect(result.after.instancesDrawn).toBeLessThanOrEqual(result.visible);
  expect(result.after.instancesDrawn).toBeGreaterThanOrEqual(result.visible * 0.98);
  expect(result.after.instancesDrawn).toBeLessThan(20_000 * 0.25);
  expect(result.after.unattributed).toBe(0);
});
