import { expect, test } from './fixtures.js';
import { pixelDiff, settle } from './pixels.js';

test('freezing the compiled village recomposes far fewer matrices with the same pixels', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('village', { variant: 'naive', freeze: '1' });
  await settle(forge.page);
  const naive = await forge.page.evaluate(async () => {
    const f = window.__forge;
    f.ledger.rescan();
    const frame = await f.frameAsync();
    return { auto: frame.js.autoUpdatedMatrices, objects: frame.js.objects, hints: frame.hints.map((h) => h.code) };
  });
  const before = await forge.page.screenshot({ type: 'png' });
  const compiled = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const report = f.compile();
    await f.world.warmup(f.renderer, f.camera);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    f.ledger.rescan();
    const frame = await f.frameAsync();
    return {
      frozen: report.after.frozen,
      auto: frame.js.autoUpdatedMatrices,
      hidden: frame.js.hiddenOriginals,
      hints: frame.hints.map((h) => h.code),
      unattributed: frame.totals.unattributed,
    };
  });
  const after = await forge.page.screenshot({ type: 'png' });
  console.log(
    `village autoUpdatedMatrices ${naive.auto} -> ${compiled.auto} (frozen ${compiled.frozen}, hidden ${compiled.hidden})`,
  );
  expect(compiled.auto).toBeLessThan(naive.auto / 4);
  expect(compiled.hidden).toBeGreaterThan(200);
  expect(compiled.hints).not.toContain('static-auto-update');
  expect(compiled.unattributed).toBe(0);
  expect(pixelDiff(before, after)).toBeLessThan(0.005);
});

test('markDirty: a batched prop moved after compile renders where the naive scene puts it', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  const move = async (compiled: boolean) => {
    await forge.open('naive', compiled ? { compile: '1' } : {});
    await settle(forge.page);
    await forge.page.evaluate(async (compiledFlag) => {
      const f = window.__forge;
      const prop = f.naive!.props[7]!;
      prop.position.x += 12;
      prop.position.y += 6;
      if (compiledFlag) {
        const updated = f.world.markDirty(prop);
        if (updated !== 1) throw new Error(`markDirty updated ${updated} instances`);
      }
      for (let i = 0; i < 3; i++) await f.frameAsync();
    }, compiled);
    return forge.page.screenshot({ type: 'png' });
  };
  const naiveMoved = await move(false);
  const compiledMoved = await move(true);
  const diff = pixelDiff(naiveMoved, compiledMoved);
  console.log(`markDirty pixel diff ${(diff * 100).toFixed(3)}%`);
  expect(diff).toBeLessThan(0.005);
});

test('statics placed through their matrix stay where the naive scene draws them', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('naive');
  await forge.page.evaluate(() => {
    const f = window.__forge;
    const { BoxGeometry, Mesh, MeshStandardMaterial, Vector3 } = f.three;
    const ahead = f.camera.getWorldDirection(new Vector3()).multiplyScalar(30).add(f.camera.position);
    // Its own material variant, so it stays a singleton and goes through the freeze pass rather than into a batch.
    const material = f.registry.register(
      new MeshStandardMaterial({ color: 0xff00ff, roughness: 0.13, metalness: 0.87 }),
    );
    const marker = new Mesh(new BoxGeometry(6, 6, 6), material);
    marker.name = 'manual-marker';
    marker.userData.forge = 'static';
    marker.matrixAutoUpdate = false;
    marker.matrix.makeTranslation(ahead.x, ahead.y, ahead.z);
    f.scene.add(marker);
    // A batched prop, moved the same way: the matrix holds the placement, position/quaternion/scale say identity.
    const prop = f.naive!.props.find((p) => p.userData.forge === 'static')!;
    prop.updateMatrix();
    prop.matrix.multiply(new f.three.Matrix4().makeScale(4, 4, 4));
    prop.matrixAutoUpdate = false;
    prop.position.set(0, 0, 0);
    prop.quaternion.identity();
    prop.scale.set(1, 1, 1);
  });
  await settle(forge.page);
  const before = await forge.page.screenshot({ type: 'png' });
  const compiled = await forge.page.evaluate(async () => {
    const f = window.__forge;
    f.compile();
    const marker = f.scene.getObjectByName('manual-marker')!;
    const frozen = f.world.frozenObjects.includes(marker);
    f.world.markDirty(f.scene);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    return { frozen };
  });
  const after = await forge.page.screenshot({ type: 'png' });
  expect(compiled.frozen).toBe(true);
  expect(pixelDiff(before, after)).toBeLessThan(0.005);
  const restored = await forge.page.evaluate(async () => {
    const f = window.__forge;
    f.world.decompile();
    for (let i = 0; i < 3; i++) await f.frameAsync();
    return f.scene.getObjectByName('manual-marker')!.matrixAutoUpdate;
  });
  expect(restored).toBe(false);
  expect(pixelDiff(before, await forge.page.screenshot({ type: 'png' }))).toBeLessThan(0.005);
});

test('originals: detach keeps a dynamic child of a batched static on screen', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('naive', { originals: 'detach' });
  await forge.page.evaluate(() => {
    const f = window.__forge;
    const { BoxGeometry, Mesh, MeshStandardMaterial, Vector3 } = f.three;
    const ahead = f.camera.getWorldDirection(new Vector3()).multiplyScalar(30).add(f.camera.position);
    const material = f.registry.register(new MeshStandardMaterial({ color: 0x00ffff, roughness: 0.4 }));
    const rider = new Mesh(new BoxGeometry(6, 6, 6), material);
    rider.name = 'rider';
    rider.userData.forge = 'dynamic';
    rider.position.copy(ahead);
    f.scene.add(rider);
    f.scene.updateMatrixWorld(true);
    f.naive!.props.find((p) => p.userData.forge === 'static')!.attach(rider);
  });
  await settle(forge.page);
  const before = await forge.page.screenshot({ type: 'png' });
  const compiled = await forge.page.evaluate(async () => {
    const f = window.__forge;
    f.compile();
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const rider = f.scene.getObjectByName('rider');
    const detached = f.naive!.props.filter((p) => p.parent === null).length;
    return { reachable: rider !== undefined, detached };
  });
  const after = await forge.page.screenshot({ type: 'png' });
  expect(compiled.reachable).toBe(true);
  expect(compiled.detached).toBeGreaterThan(300);
  expect(pixelDiff(before, after)).toBeLessThan(0.005);
});
