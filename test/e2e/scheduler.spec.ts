import { expect, test } from './fixtures.js';

/** Render on change: idle ticks draw nothing; a camera move or invalidate() draws one frame. */
test('RenderScheduler renders once for ten idle ticks, again on camera move and invalidate', async ({ forge }) => {
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
    return {
      afterIdle,
      afterMove,
      afterInvalidate,
      skipped: frame.js.skipped,
      submissions: frame.totals.sceneSubmissions,
      unattributed: frame.totals.unattributed,
    };
  });
  expect(r.afterIdle).toEqual({ ticks: 10, renders: 1, skipped: 9 });
  expect(r.afterMove).toEqual({ ticks: 11, renders: 2, skipped: 9 });
  expect(r.afterInvalidate).toEqual({ ticks: 13, renders: 3, skipped: 10 });
  expect(r.skipped).toBe(10);
  expect(r.submissions).toBeLessThanOrEqual(30);
  expect(r.unattributed).toBe(0);
});

/** A camera that moves every animation frame, under each cap: renders per second against the rate the page ticks at. */
test('RenderScheduler holds maxFps under a camera that moves every frame', async ({ forge }) => {
  await forge.open('naive', { compile: '1', scheduler: '1' });
  const rates = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const s = f.scheduler!;
    const measure = async (maxFps: number) => {
      s.maxFps = maxFps;
      const start = { ...s.stats, time: performance.now() };
      while (performance.now() - start.time < 1500) {
        f.camera.position.x += 0.01;
        await f.frameAsync();
      }
      const seconds = (performance.now() - start.time) / 1000;
      return { ticks: (s.stats.ticks - start.ticks) / seconds, renders: (s.stats.renders - start.renders) / seconds };
    };
    // Pipelines compile on the first frames (over a second on webgl2): measure after them.
    for (let i = 0; i < 20; i++) {
      f.camera.position.x += 0.01;
      await f.frameAsync();
    }
    return { free: await measure(0), battery: await measure(30), menu: await measure(10), back: await measure(0) };
  });
  console.log(
    `scheduler caps: ticks ${rates.free.ticks.toFixed(1)}/s · uncapped ${rates.free.renders.toFixed(1)} · 30 → ${rates.battery.renders.toFixed(1)} · 10 → ${rates.menu.renders.toFixed(1)} · uncapped again ${rates.back.renders.toFixed(1)}`,
  );
  // Uncapped, every tick renders, since the camera moved; the page ticks at the display rate, which headless Chromium
  // holds near 60 but a busy runner can lower.
  // Fast enough for the 10 fps cap to bind; the 30 fps bound below allows for a runner that ticks slower than that.
  expect(rates.free.ticks).toBeGreaterThan(12);
  expect(rates.free.renders).toBeCloseTo(rates.free.ticks, 0);
  expect(rates.battery.renders).toBeLessThanOrEqual(31);
  expect(rates.battery.renders).toBeGreaterThanOrEqual(Math.min(30, rates.battery.ticks) * 0.8);
  expect(rates.menu.renders).toBeLessThanOrEqual(10.7);
  expect(rates.menu.renders).toBeGreaterThanOrEqual(8);
  expect(rates.back.renders).toBeCloseTo(rates.back.ticks, 0);
});
