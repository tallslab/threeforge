import { expect, test } from './fixtures.js';

test('shadow passes are attributed per light and batches cast as one submission each', async ({ forge }) => {
  await forge.open('naive', { shadows: '1' });
  const { before, sunTexels } = await forge.page.evaluate(async () => {
    const size = window.__forge.naive!.lights.directional.shadow.mapSize;
    // frameAsync: the sun's map renders once per animation frame (three keys it by frame and camera).
    return { before: await window.__forge.frameAsync(), sunTexels: size.x * size.y };
  });
  // 500 props + 2 skinned cast shadows (ground does not): 502 in the shadow pass, 503 in the main pass.
  expect(before.passes.map((p) => p.id)).toEqual(['shadow:sun', 'main']);
  expect(before.passes[0]?.submissions).toBe(502);
  expect(before.totals.sceneSubmissions).toBe(1005);
  expect(before.totals.unattributed).toBe(0);
  expect(before.lighting).toMatchObject({ shadowLights: 1, shadowPasses: 1, shadowCasters: 502, shadowSubmissions: 502, shadowTexels: sunTexels });

  const after = await forge.page.evaluate(async () => {
    window.__forge.compile();
    return window.__forge.frameAsync();
  });
  // 15 batches + 10 dynamic + 2 skinned cast; ground does not. A batch is one caster object.
  expect(after.passes.map((p) => p.id)).toEqual(['shadow:sun', 'main']);
  expect(after.passes[0]?.submissions).toBe(27);
  expect(after.totals.sceneSubmissions).toBe(27 + 28);
  expect(after.totals.unattributed).toBe(0);
  expect(after.byReason.batched?.submissions).toBe(30);
  expect(after.lighting).toMatchObject({ shadowPasses: 1, shadowCasters: 27, shadowSubmissions: 27, shadowTexels: sunTexels });
});
