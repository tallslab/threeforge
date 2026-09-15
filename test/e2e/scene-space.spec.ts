import { expect, test } from './fixtures.js';
import { pixelDiff, settle } from './pixels.js';

/**
 * Compiled batches, instanced meshes, baked meshes and sprite batches are children of the scene, so three draws them
 * with `scene.matrixWorld`: their instance data must be in the scene's space. `sceneOffset=1` translates, turns and
 * scales the whole scene (the camera follows, so the same view stays framed).
 */

for (const offset of ['0', '1'] as const) {
  test(`the village compiles at parity ${offset === '1' ? 'in a translated, turned and scaled scene' : 'in an untransformed scene'}`, async ({ forge }) => {
    test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
    await forge.open('village', { variant: 'naive', sceneOffset: offset });
    await settle(forge.page);
    const naive = await forge.page.evaluate(() => ({ visible: window.__forge.visibleMeshes(), position: window.__forge.scene.position.toArray() }));
    const before = await forge.page.screenshot({ type: 'png' });
    const r = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const report = f.compile();
      await f.world.warmup(f.renderer, f.camera);
      for (let i = 0; i < 3; i++) await f.frameAsync();
      const frame = await f.frameAsync();
      return { batches: report.after.batches, submissions: frame.totals.sceneSubmissions, unattributed: frame.totals.unattributed };
    });
    const after = await forge.page.screenshot({ type: 'png' });
    expect(naive.position).toEqual(offset === '1' ? [40, -12, -30] : [0, 0, 0]);
    expect(naive.visible, 'the village is in view').toBeGreaterThan(250);
    expect(r.batches).toBeGreaterThan(5);
    expect(r.unattributed).toBe(0);
    const diff = pixelDiff(before, after, { threshold: 4 });
    console.log(`village sceneOffset=${offset} pixel diff ${(diff * 100).toFixed(4)}% · submissions ${r.submissions}`);
    expect(diff).toBeLessThan(0.0005);
  });
}

test('the offset village moved after compile, with batch-synced dynamics turning, matches the same scene decompiled', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('village', { variant: 'naive', sceneOffset: '1', dynamics: 'batch-sync' });
  await settle(forge.page);
  const compiled = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const report = f.compile();
    await f.world.warmup(f.renderer, f.camera);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    // The scene moves after compile; the synced dynamics turn in it.
    f.scene.position.x += 6;
    f.scene.rotation.y -= 0.25;
    f.scene.scale.setScalar(0.9);
    f.setTime(1.7);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const frame = await f.frameAsync();
    return { synced: report.synced, unattributed: frame.totals.unattributed };
  });
  const moved = await forge.page.screenshot({ type: 'png' });
  await forge.page.evaluate(async () => {
    const f = window.__forge;
    f.decompile();
    for (let i = 0; i < 3; i++) await f.frameAsync();
  });
  const naive = await forge.page.screenshot({ type: 'png' });
  expect(compiled.synced).toBeGreaterThan(0);
  expect(compiled.unattributed).toBe(0);
  const diff = pixelDiff(naive, moved, { threshold: 4 });
  console.log(`village moved after compile (synced ${compiled.synced}) pixel diff ${(diff * 100).toFixed(4)}%`);
  expect(diff).toBeLessThan(0.0005);
});
