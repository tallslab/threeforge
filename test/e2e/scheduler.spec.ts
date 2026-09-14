import { expect, test } from './fixtures.js';

/** Render on change: idle ticks draw nothing; a camera move or invalidate() draws one frame. */
test('RenderScheduler renders once for ten idle ticks, again on camera move and invalidate, and reports skipped ticks', async ({ forge }) => {
  await forge.open('naive', { compile: '1', scheduler: '1' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const s = f.scheduler!;
    for (let i = 0; i < 10; i++) await f.frameAsync();
    const afterIdle = { ...s.stats };
    f.camera.position.x += 5;
    f.camera.updateMatrixWorld();
    await f.frameAsync();
    const afterMove = { ...s.stats };
    await f.frameAsync();
    s.invalidate();
    const frame = await f.frameAsync();
    const afterInvalidate = { ...s.stats };
    return { afterIdle, afterMove, afterInvalidate, skipped: frame.js.skipped, submissions: frame.totals.sceneSubmissions, unattributed: frame.totals.unattributed };
  });
  expect(r.afterIdle).toEqual({ ticks: 10, renders: 1, skipped: 9 });
  expect(r.afterMove).toEqual({ ticks: 11, renders: 2, skipped: 9 });
  expect(r.afterInvalidate).toEqual({ ticks: 13, renders: 3, skipped: 10 });
  expect(r.skipped).toBe(10);
  expect(r.submissions).toBeLessThanOrEqual(30);
  expect(r.unattributed).toBe(0);
});
