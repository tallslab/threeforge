import { expect, test } from './fixtures.js';
import { pixelDiff, settle } from './pixels.js';

/**
 * Compiled batches, instanced meshes, baked meshes and sprite batches are children of the scene, so three draws them
 * with `scene.matrixWorld`: their instance data must be in the scene's space. `sceneOffset=1` translates, turns and
 * scales the whole scene (the camera follows, so the same view stays framed).
 */

for (const offset of ['0', '1'] as const) {
  test(`the village compiles at parity ${offset === '1' ? 'in a translated, turned and scaled scene' : 'in an untransformed scene'}`, async ({
    forge,
  }) => {
    test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
    await forge.open('village', { variant: 'naive', sceneOffset: offset });
    await settle(forge.page);
    const naive = await forge.page.evaluate(() => ({
      visible: window.__forge.visibleMeshes(),
      position: window.__forge.scene.position.toArray(),
    }));
    const before = await forge.page.screenshot({ type: 'png' });
    const r = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const report = f.compile();
      await f.world.warmup(f.renderer, f.camera);
      for (let i = 0; i < 3; i++) await f.frameAsync();
      const frame = await f.frameAsync();
      return {
        batches: report.after.batches,
        submissions: frame.totals.sceneSubmissions,
        unattributed: frame.totals.unattributed,
      };
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

test('the offset village moved after compile, with batch-synced dynamics turning, matches the same scene decompiled', async ({
  forge,
}) => {
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

test('the village in a mirrored scene compiles at parity: children mirrored again stay unbatched, the rest batch', async ({
  forge,
}) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('village', { variant: 'naive' });
  const setup = await forge.page.evaluate(() => {
    const f = window.__forge;
    f.scene.scale.x = -1;
    // Every fifth mesh is mirrored again: mirrored relative to the scene, not in the world.
    let meshes = 0;
    let again = 0;
    f.scene.traverse((o) => {
      const mesh = o as typeof o & { isMesh?: boolean; isSkinnedMesh?: boolean };
      if (!mesh.isMesh || mesh.isSkinnedMesh) return;
      if (meshes++ % 5 === 0) {
        o.scale.x *= -1;
        again++;
      }
    });
    f.scene.updateMatrixWorld(true);
    return { again, visible: f.visibleMeshes() };
  });
  await settle(forge.page);
  const before = await forge.page.screenshot({ type: 'png' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const report = f.compile();
    await f.world.warmup(f.renderer, f.camera);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const frame = await f.frameAsync();
    return {
      batches: report.after.batches,
      mirrored: report.skipped.filter((s) => s.rule === 'mirrored').length,
      unattributed: frame.totals.unattributed,
      submissions: frame.totals.sceneSubmissions,
    };
  });
  const after = await forge.page.screenshot({ type: 'png' });
  const diff = pixelDiff(before, after, { threshold: 4 });
  console.log(
    `mirrored village (${setup.again} meshes mirrored again, ${r.mirrored} skipped as mirrored, ${r.batches} batches) pixel diff ${(diff * 100).toFixed(4)}% · submissions ${r.submissions}`,
  );
  expect(diff).toBeLessThan(0.0005);
  expect(setup.visible, 'the village is in view').toBeGreaterThan(250);
  expect(r.mirrored, 'children mirrored again stay unbatched').toBeGreaterThan(0);
  expect(r.batches).toBeGreaterThan(5);
  expect(r.unattributed).toBe(0);
});

for (const mirrored of [false, true] as const) {
  test(`a sprite grid compiles at parity in ${mirrored ? 'a mirrored' : 'an unmirrored'} scene`, async ({ forge }) => {
    test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
    await forge.open('empty');
    await forge.page.evaluate((mirror) => {
      const f = window.__forge;
      const T = f.three;
      const materials = [
        new T.SpriteMaterial({ color: 0xff6040, transparent: false }),
        new T.SpriteMaterial({ color: 0x40a0ff, transparent: false }),
      ];
      for (let x = 0; x < 8; x++) {
        for (let z = 0; z < 6; z++) {
          const sprite = new T.Sprite(materials[(x + z) % 2]!);
          sprite.name = `sprite-${x}-${z}`;
          sprite.position.set((x - 3.5) * 14, 6, (z - 2.5) * 14);
          sprite.scale.set(8, 5, 1);
          f.scene.add(sprite);
        }
      }
      if (mirror) f.scene.scale.x = -1;
      f.scene.position.x = 7;
      f.scene.updateMatrixWorld(true);
    }, mirrored);
    await settle(forge.page);
    const before = await forge.page.screenshot({ type: 'png' });
    const r = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const report = f.compile();
      await f.world.warmup(f.renderer, f.camera);
      for (let i = 0; i < 3; i++) await f.frameAsync();
      const frame = await f.frameAsync();
      return {
        spriteBatches: report.after.spriteBatches,
        drawn: frame.byReason['sprite-batch']?.submissions ?? 0,
        sprites: frame.byReason.sprite?.submissions ?? 0,
        unattributed: frame.totals.unattributed,
      };
    });
    const after = await forge.page.screenshot({ type: 'png' });
    const diff = pixelDiff(before, after, { threshold: 4 });
    console.log(`sprite grid mirrored=${mirrored} pixel diff ${(diff * 100).toFixed(4)}%`);
    expect(diff).toBeLessThan(0.0005);
    expect(r.spriteBatches).toBe(2);
    expect(r.drawn).toBe(2);
    expect(r.sprites).toBe(0);
    expect(r.unattributed).toBe(0);
  });
}
