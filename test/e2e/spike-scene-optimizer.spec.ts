import { expect, test } from './fixtures.js';

/**
 * Spike: how far does three's experimental SceneOptimizer get on its own? A measurement, not a contract; the numbers
 * are recorded in docs/spike-scene-optimizer.md. The one spec exempt from CONTRIBUTING.md rule 5: the subject is the raw
 * backend count, because SceneOptimizer rewrites the scene behind the ledger's back into batches threeforge never
 * registered, so `sceneSubmissions` cannot measure it. The `drawsAfter` assertion is guarded by the context's
 * multi-draw capability: without it (WebGPU, or a WebGL2 context without `WEBGL_multi_draw`) the backend issues one
 * draw per batched instance.
 */
test('baseline: SceneOptimizer.toBatchedMesh() on the naive scene', async ({ forge }) => {
  await forge.open('naive');
  const result = await forge.page.evaluate(() => window.__forge.spikeSceneOptimizer());
  // The capability the ledger probes and reports (`frame.env.multiDraw`), not the Playwright project's name.
  const multiDraw = await forge.page.evaluate(() => window.__forge.frame().env.multiDraw);
  console.log('SPIKE ' + JSON.stringify({ ...result, multiDraw }));
  if (forge.pixelChecks)
    await forge.page.screenshot({ path: `test-results/spike-scene-optimizer-${forge.backend}.png` });
  expect(result.drawsBefore).toBe(504);
  expect(result.indexed.batchedMeshes).toBe(16);
  if (multiDraw) expect(result.indexed.drawsAfter).toBeLessThan(result.drawsBefore);
});
