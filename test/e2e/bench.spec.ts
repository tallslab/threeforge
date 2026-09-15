import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from './fixtures.js';
import { MEASURED, metricsOf, SCENE_IDS, WARM } from '../app/benchMetrics.js';

/**
 * The benchmark runner: every scene in both variants, 10 warm-up frames, 60 measured frames (medians), one overdraw
 * measurement, then the snapshot's cost metrics go to bench/results/local.<backend>.json. `pnpm bench` wraps this
 * with the gate (scripts/bench-gate.mjs). Results merge on disk per test because Playwright restarts its worker
 * after a failure.
 */
for (const id of SCENE_IDS) {
  for (const variant of ['naive', 'optimized'] as const) {
    test(`bench ${id} ${variant}`, async ({ forge }) => {
      test.setTimeout(900_000);
      if (id === 'rpg') await forge.page.setViewportSize({ width: 450, height: 800 });
      await forge.open(id, { variant }); // no clock freeze: timings must be real; pixel parity is not checked here
      const out = await forge.page.evaluate(
        async ({ warm, measured }) => {
          const f = window.__forge;
          const render: number[] = [];
          const frames: number[] = [];
          const shadowPasses: number[] = [];
          const shadowTexels: number[] = [];
          for (let i = 0; i < warm; i++) {
            f.bench?.setTime?.(i / 60);
            await f.frameAsync();
          }
          let last = performance.now();
          let frame = f.frame();
          for (let i = 0; i < measured; i++) {
            f.bench?.setTime?.((warm + i) / 60);
            frame = await f.frameAsync();
            const now = performance.now();
            render.push(frame.js.renderMs);
            frames.push(now - last);
            shadowPasses.push(frame.lighting.shadowPasses);
            shadowTexels.push(frame.lighting.shadowTexels);
            last = now;
          }
          const median = (a: number[]): number => {
            const s = [...a].sort((x, y) => x - y);
            return s[Math.floor(s.length / 2)]!;
          };
          const overdraw = await f.measureOverdraw();
          f.ledger.rescan();
          frame = await f.frameAsync();
          return { frame, overdraw, renderMs: median(render), frameMs: median(frames), shadowPassesPerFrame: shadowPasses.reduce((a, b) => a + b, 0) / Math.max(1, shadowPasses.length), shadowTexels };
        },
        { warm: WARM, measured: MEASURED },
      );
      expect(out.frame.totals.unattributed, 'unattributed draws').toBe(0);
      const path = `bench/results/local.${forge.backend}.json`;
      mkdirSync('bench/results', { recursive: true });
      // The file's env describes the machine; the viewport is per scene (rpg is portrait) and stays out of it.
      const { viewport: _viewport, ...env } = out.frame.env;
      const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schemaVersion: 1, env, scenes: {} };
      file.env = env;
      file.scenes[id] ??= {};
      file.scenes[id][variant] = metricsOf({ ...out.frame, overdraw: { ...out.frame.overdraw, ...out.overdraw, measured: true } }, out.renderMs, out.frameMs, out.shadowPassesPerFrame, out.shadowTexels);
      writeFileSync(path, JSON.stringify(file, null, 2));
    });
  }
}
