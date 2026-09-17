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
    test(`bench ${id} ${variant}`, { tag: '@bench' }, async ({ forge }) => {
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
          // Before the count: its materials' shader stages stay counted in renderer.info.memory.programs afterwards.
          const programs = frame.totals.programs;
          const overdraw = await f.measureOverdraw();
          f.ledger.rescan();
          frame = await f.frameAsync();
          return { frame, overdraw, programs, renderMs: median(render), frameMs: median(frames), shadowPassesPerFrame: shadowPasses.reduce((a, b) => a + b, 0) / Math.max(1, shadowPasses.length), shadowTexels };
        },
        { warm: WARM, measured: MEASURED },
      );
      expect(out.frame.totals.unattributed, 'unattributed draws').toBe(0);
      // `programs` is read from the last measured frame, *before* `measureOverdraw()`. The overdraw
      // count materials are real materials whose shader stages stay counted in `renderer.info.memory.programs`
      // afterwards — three frees a stage only once its `usedTimes` reaches 0 — so a capture taken after the
      // measurement reports the diagnostic's own shaders as if the scene had compiled them, and any edit to
      // `src/ledger/overdraw.ts` then moves a gated bench metric that has nothing to do with the scene. That capture
      // point was held only by a comment in each of the two callers, so moving it back below the measurement left
      // every test green. `out.frame` is the post-measurement, post-rescan frame: the recorded value must never be it.
      // This `<=` was sampled on zen and village only. It is expected to hold for the other six because
      // `measureOverdraw()` only ever *adds* count-material stages to `info.memory.programs`, and three frees a stage
      // only once its `usedTimes` reaches 0, so a post-measurement frame can never report fewer programs than the
      // pre-measurement capture, whatever the scene draws.
      expect(out.programs, 'programs must be read before measureOverdraw()').toBeLessThanOrEqual(out.frame.totals.programs);
      // And on a scene where the count materials measurably add stages, strictly below it — which is the assertion
      // that actually fails when the capture moves. Measured on webgl2: zen naive 6 -> 10 programs across the
      // measurement, zen optimized 80 -> 158. The other scenes are not asserted strictly because their gap is not
      // guaranteed to be non-zero, and a guard that can pass vacuously is the kind this branch keeps removing.
      if (id === 'zen') expect(out.programs, 'zen: the count materials add stages, so the captured value must sit below the post-measurement frame').toBeLessThan(out.frame.totals.programs);
      const path = `bench/results/local.${forge.backend}.json`;
      mkdirSync('bench/results', { recursive: true });
      // The file's env describes the machine; the viewport is per scene (rpg is portrait) and stays out of it.
      const { viewport: _viewport, ...env } = out.frame.env;
      const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schemaVersion: 1, env, scenes: {} };
      file.env = env;
      file.scenes[id] ??= {};
      file.scenes[id][variant] = metricsOf({ ...out.frame, overdraw: { ...out.frame.overdraw, ...out.overdraw, measured: true } }, out.renderMs, out.frameMs, out.shadowPassesPerFrame, out.shadowTexels, out.programs);
      writeFileSync(path, JSON.stringify(file, null, 2));
    });
  }
}
