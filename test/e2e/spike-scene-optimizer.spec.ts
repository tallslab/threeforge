import { expect, test } from './fixtures.js';

/**
 * Task 2 spike: how far does three's experimental SceneOptimizer get on its own?
 * This is a measurement, not a contract. Its numbers are recorded in docs/spike-scene-optimizer.md.
 *
 * The one spec exempt from CONTRIBUTING.md rule 5, deliberately. Every other spec asserts
 * `ledger.frame().totals.sceneSubmissions`, because that is threeforge's own cost model and it is portable across
 * backends. Here the subject *is* the raw backend count: SceneOptimizer is three's code, it rewrites the scene behind
 * the ledger's back into batches threeforge never registered, and the question the spike answers is what three's
 * optimizer does to `renderer.info.render.drawCalls` with no threeforge in the picture. A submission count would not
 * measure that, and the ledger has nothing to say about a scene it did not compile. That is also why the one
 * `drawsAfter` assertion below is guarded by backend: on WebGL2 multi-draw makes the number fall, on WebGPU it does
 * not, which is precisely the backend dependence rule 5 exists to keep out of every other spec.
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
