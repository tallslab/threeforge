import { expect, test } from './fixtures.js';

test('the naive scene costs one draw per visible mesh plus the renderer-internal output quad', async ({ forge }) => {
  await forge.open('naive');
  const { visible, result } = await forge.page.evaluate(() => ({
    visible: window.__forge.visibleMeshes(),
    result: window.__forge.renderOnce(),
  }));
  // 500 props + 1 ground + 2 skinned, all inside the frustum from the harness camera.
  expect(visible).toBe(503);
  expect(result.drawCalls).toBe(visible + 1);
});
