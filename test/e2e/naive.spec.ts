import { expect, test } from './fixtures.js';

test('the naive scene costs one submission per visible mesh plus the output quad', async ({ forge }) => {
  await forge.open('naive');
  const { visible, result } = await forge.page.evaluate(() => ({
    visible: window.__forge.visibleMeshes(),
    result: window.__forge.renderOnce(),
  }));
  // 500 props + 1 ground + 2 skinned, all inside the frustum from the harness camera.
  expect(visible).toBe(503);
  // CONTRIBUTING.md rule 5: the ledger's totals, not `renderOnce().drawCalls`. This spec used to assert
  // `drawCalls === visible + 1`, which is the raw backend count — it agrees with the submission count here only
  // because nothing in the naive scene is batched, so every submission happens to cost exactly one backend draw on
  // both backends. Compile the same scene and the two numbers diverge (28 submissions, 28 draws on WebGL2 with
  // multi-draw, ~500 on WebGPU), and the raw number stops describing what the scene cost. `sceneSubmissions` is what
  // the budget gate, the overlay and every other spec are written against, so it is what this one asserts.
  expect(result.sceneSubmissions, 'one submission per visible mesh').toBe(visible);
  expect(result.rendererInternal, "three's output colour-transform quad, on top of the scene's own").toBe(1);
  expect(result.submissions).toBe(visible + 1);
  // And the ledger accounted for every draw the backend reported: without this, the counts above could be a subset
  // of the frame rather than all of it.
  expect(result.unattributed).toBe(0);
});
