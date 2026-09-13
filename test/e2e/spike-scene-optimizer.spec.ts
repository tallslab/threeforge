import { expect, test } from './fixtures.js';

/**
 * Task 2 spike: how far does three's experimental SceneOptimizer get on its own?
 * This is a measurement, not a contract. Its numbers are recorded in docs/spike-scene-optimizer.md.
 */
test('baseline: SceneOptimizer.toBatchedMesh() on the naive scene', async ({ forge }) => {
  await forge.open('naive');
  const result = await forge.page.evaluate(() => window.__forge.spikeSceneOptimizer());
  console.log('SPIKE ' + JSON.stringify(result));
  if (forge.pixelChecks) await forge.page.screenshot({ path: `test-results/spike-scene-optimizer-${forge.backend}.png` });
  expect(result.drawsBefore).toBe(504);
  expect(result.indexed.batchedMeshes).toBe(16);
  // Raw drawCalls only shrink on WebGL with multi-draw; WebGPU issues one draw per batched instance.
  if (forge.backend === 'webgl2') expect(result.indexed.drawsAfter).toBeLessThan(result.drawsBefore);
});
