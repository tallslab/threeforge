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

/**
 * A camera that moves every animation frame, under each cap: renders per second against the rate the page ticks at,
 * and the gaps, in ticks, between rendered frames.
 */
test('RenderScheduler holds maxFps under a camera that moves every frame', async ({ forge }) => {
  await forge.open('naive', { compile: '1', scheduler: '1' });
  const rates = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const s = f.scheduler!;
    const measure = async (maxFps: number) => {
      s.maxFps = maxFps;
      const start = { ...s.stats, time: performance.now() };
      const gaps: number[] = [];
      let since = 0;
      while (performance.now() - start.time < 1500) {
        f.camera.position.x += 0.01;
        const before = s.stats.renders;
        await f.frameAsync();
        since++;
        if (s.stats.renders > before) {
          gaps.push(since);
          since = 0;
        }
      }
      const seconds = (performance.now() - start.time) / 1000;
      return {
        ticks: (s.stats.ticks - start.ticks) / seconds,
        renders: (s.stats.renders - start.renders) / seconds,
        gaps: gaps.slice(2),
      };
    };
    // Pipelines compile on the first frames (over a second on webgl2): measure after them.
    for (let i = 0; i < 20; i++) {
      f.camera.position.x += 0.01;
      await f.frameAsync();
    }
    return { free: await measure(0), battery: await measure(30), menu: await measure(10), back: await measure(0) };
  });
  /** The gap steady pacing picks for a cap at this tick rate, and the share of gaps that were it. */
  const steady = (r: { ticks: number; gaps: number[] }, cap: number) => {
    const ratio = r.ticks / cap;
    const gap = Math.max(1, Math.round(ratio), Math.ceil(ratio / 1.05));
    return { gap, share: r.gaps.filter((g) => g === gap).length / r.gaps.length };
  };
  const battery = steady(rates.battery, 30);
  const menu = steady(rates.menu, 10);
  console.log(
    `scheduler caps: ${rates.free.ticks.toFixed(1)} ticks/s · 30 → ${rates.battery.renders.toFixed(1)}, gap ${battery.gap} ` +
      `${(battery.share * 100).toFixed(0)}% even · 10 → ${rates.menu.renders.toFixed(1)}, gap ${menu.gap} ` +
      `${(menu.share * 100).toFixed(0)}% even`,
  );
  // Uncapped, every tick renders, since the camera moved; the page ticks at the display rate, which headless Chromium
  // holds near 60 but a busy runner can lower.
  expect(rates.free.ticks).toBeGreaterThan(12);
  expect(rates.free.renders).toBeCloseTo(rates.free.ticks, 0);
  // Capped, a frame every `gap` ticks, never more than 5 % over the cap; a headless page drops the odd tick, so most
  // gaps, not all, are the steady one.
  for (const [r, cap, pace] of [
    [rates.battery, 30, battery],
    [rates.menu, 10, menu],
  ] as const) {
    expect(r.renders).toBeLessThanOrEqual(cap * 1.06);
    expect(r.renders).toBeGreaterThanOrEqual((r.ticks / pace.gap) * 0.85);
    expect(pace.share).toBeGreaterThan(0.85);
  }
  expect(rates.back.renders).toBeCloseTo(rates.back.ticks, 0);
});
