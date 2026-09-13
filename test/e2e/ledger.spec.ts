import { expect, test } from './fixtures.js';

test('attributes every draw of the naive scene and reconciles with renderer.info', async ({ forge }) => {
  await forge.open('naive');
  const { frame, transparentStatic, report } = await forge.page.evaluate(() => {
    const f = window.__forge;
    const frame = f.frame();
    const naive = f.naive!;
    const transparentStatic = naive.props.filter((p) => p.userData.forge === 'static' && !Array.isArray(p.material) && p.material.transparent).length;
    return { frame, transparentStatic, report: f.ledger.report() };
  });
  console.log(report);
  expect(frame.env.backend).toBe(forge.backend);
  expect(frame.totals.submissions).toBe(504);
  expect(frame.totals.sceneSubmissions).toBe(503);
  expect(frame.totals.reportedDrawCalls).toBe(504);
  expect(frame.totals.unattributed).toBe(0);
  expect(frame.passes).toEqual([{ id: 'main', submissions: 504, gpuDraws: 504 }]);
  expect(frame.byReason).toMatchObject({
    'renderer-internal': { submissions: 1 },
    skinned: { submissions: 2 },
    dynamic: { submissions: 10 },
    transparent: { submissions: transparentStatic },
    'unique-material': { submissions: 491 - transparentStatic },
  });
  expect(Object.keys(frame.byReason).sort()).toEqual(['dynamic', 'renderer-internal', 'skinned', 'transparent', 'unique-material']);
  expect(typeof frame.totals.programs).toBe('number');
});

test('renders the same number of programs as distinct registry programs (shader variants are real)', async ({ forge }) => {
  await forge.open('naive');
  const { programs, registryPrograms, memoryPrograms } = await forge.page.evaluate(() => {
    const f = window.__forge;
    for (const p of f.naive!.props) f.registry.register(p.material as never);
    const frame = f.frame();
    return { programs: Object.keys(frame.programs).length, registryPrograms: f.registry.stats().programs, memoryPrograms: f.renderer.info.memory.programs };
  });
  console.log(JSON.stringify({ programs, registryPrograms, memoryPrograms }));
  // Ground and the skinned dummies use plain MeshStandardMaterial, so they share the solid-colour program key,
  // and renderer-internal items are excluded from `programs`. Skinning is an object-level program variant the
  // material key does not see (`kind: skinned` is that signal), which is one reason info.memory.programs is higher.
  expect(programs).toBe(registryPrograms);
  expect(memoryPrograms).toBeGreaterThanOrEqual(programs);
});

test('the snapshot carries schema v2 environment and sections', async ({ forge }) => {
  await forge.open('naive');
  const f = await forge.page.evaluate(() => window.__forge.frame());
  expect(f.schemaVersion).toBe(2);
  expect(f.env.tier).toBe('desktop');
  expect(f.env.viewport).toEqual([800, 600]);
  expect(f.env.gpu.length).toBeGreaterThan(0);
  expect(f.lighting.lights.directional).toBe(1);
  expect(f.js.objects).toBeGreaterThan(500);
  expect(f.memory.geometries.bytes).toBeGreaterThan(0);
});
