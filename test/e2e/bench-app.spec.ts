import { existsSync } from 'node:fs';
import { validateDeviceResult } from '../../scripts/bench-schema.mjs';
import { SCENE_IDS } from '../app/benchMetrics.js';
import { expect, test } from './fixtures.js';

interface BenchState {
  ready: boolean;
  error?: string;
  backend?: string;
  done: boolean;
  result: {
    env: { backend: string };
    scenes: Record<
      string,
      {
        naive: { sceneSubmissions: number; unattributed: number };
        optimized: { sceneSubmissions: number; unattributed: number };
      }
    >;
  } | null;
}

/** The device bench page, auto-running two scenes with few frames; the result must be what the ingest accepts. */
test('bench page runs village and rpg, builds a valid result and offers the issue body', async ({ page, backend }) => {
  test.setTimeout(300_000);
  await page.goto(`http://localhost:5180/?auto=1&scenes=village,rpg&measured=5&probe=0&backend=${backend}`);
  await page.waitForFunction('window.__bench && window.__bench.done === true', undefined, { timeout: 240_000 });
  const state = (await page.evaluate('window.__bench')) as BenchState;
  expect(state.error, state.error).toBeUndefined();
  expect(state.backend).toBe(backend);
  const result = state.result!;
  expect(result.env.backend).toBe(backend);
  // Only two scenes ran; fill the rest from village so the strict schema can judge the shape of what did run.
  const full = {
    ...result,
    scenes: Object.fromEntries(SCENE_IDS.map((id) => [id, result.scenes[id] ?? result.scenes.village])),
  };
  const v = validateDeviceResult(full);
  expect(v.ok ? [] : v.errors).toEqual([]);
  expect(result.scenes.village!.naive.sceneSubmissions).toBeGreaterThan(
    result.scenes.village!.optimized.sceneSubmissions,
  );
  expect(result.scenes.rpg!.naive.unattributed).toBe(0);
  expect(result.scenes.rpg!.optimized.unattributed).toBe(0);
  expect(await page.locator('#json').textContent()).toContain('```json');
  expect(await page.locator('#liveBody tr').count()).toBe(8);
});

test('bench page runs lake after bossfight without a GPU error', async ({ page, backend }) => {
  test.skip(!existsSync('bench-app/public/kenney-mini-arena'), 'the kits are not downloaded (pnpm assets:kits)');
  test.setTimeout(300_000);
  const failed: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) failed.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(`http://localhost:5180/?auto=1&scenes=bossfight,lake&measured=5&probe=0&backend=${backend}`);
  await page.waitForFunction('window.__bench && window.__bench.done === true', undefined, { timeout: 240_000 });
  const state = (await page.evaluate('window.__bench')) as BenchState;
  // Sprites draw one geometry three shares between scenes: disposed with bossfight, lake's sprites fail validation.
  expect(state.error, state.error).toBeUndefined();
  expect(failed).toEqual([]);
  // The whole arena, not what is left of it when a kit file is missing from the page's assets.
  expect(state.result!.scenes.bossfight!.naive.sceneSubmissions).toBeGreaterThan(2000);
  expect(state.result!.scenes.lake!.naive.unattributed).toBe(0);
});
