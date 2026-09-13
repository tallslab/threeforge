import { expect, test } from './fixtures.js';

test('20k-instance field: three instanced meshes, culling draws only what the camera sees, nothing unattributed', async ({ forge }) => {
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
    return { visible, before: before.totals, after: after.totals, batches: report.after.batches, instanced: report.after.instanced, culling: report.culling, naiveMs, compiledMs };
  });
  console.log(JSON.stringify(result));
  expect(result.before.sceneSubmissions).toBe(result.visible);
  expect(result.batches).toBe(0);
  expect(result.instanced).toBe(3);
  expect(result.culling.mode).toBe('bvh');
  expect(result.after.sceneSubmissions).toBe(3);
  expect(result.after.drawCommands).toBe(4); // 3 instanced draws + output quad
  expect(result.after.instances).toBe(20_000);
  // Instanced culling tests boxes; visibleMeshes() tests spheres. Both are conservative, so allow a small band.
  expect(result.after.instancesDrawn).toBeGreaterThanOrEqual(result.visible * 0.97);
  expect(result.after.instancesDrawn).toBeLessThanOrEqual(result.visible * 1.03);
  expect(result.after.instancesDrawn).toBeLessThan(20_000 * 0.25);
  expect(result.after.unattributed).toBe(0);
});

test('LODs on the field cut rendered triangles by more than half while drawing the same instances', async ({ forge }) => {
  await forge.open('field', { count: '20000', compile: '1' });
  const plain = await forge.page.evaluate(() => window.__forge.frame().totals);
  await forge.open('field', { count: '20000', compile: '1', lod: '1' });
  const lod = await forge.page.evaluate(() => {
    const f = window.__forge;
    const totals = f.frame().totals;
    const levels = f.world.instancedMeshes.map((m) => ({ name: m.name, count: m.count, level: (m.userData.forge as { lodLevel: number }).lodLevel }));
    return { totals, levels };
  });
  console.log(JSON.stringify({ plainTriangles: plain.triangles, lodTriangles: lod.totals.triangles, levels: lod.levels }));
  expect(lod.levels.filter((l) => l.level > 0).length).toBe(6); // 3 geometries x 2 extra levels
  expect(lod.totals.triangles).toBeLessThan(plain.triangles * 0.5);
  expect(lod.totals.instancesDrawn).toBeGreaterThanOrEqual(plain.instancesDrawn * 0.97);
  expect(lod.totals.instancesDrawn).toBeLessThanOrEqual(plain.instancesDrawn * 1.03);
  expect(lod.totals.unattributed).toBe(0);
  expect(lod.totals.sceneSubmissions).toBeLessThanOrEqual(9);
});
