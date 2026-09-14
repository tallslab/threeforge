import { expect, test } from './fixtures.js';
import { pixelDiff, settle } from './pixels.js';

/**
 * The bake must never change a pixel: a wrong deletion is visible, a missed one is invisible. Every case compares the
 * naive render with the baked one and inspects what the bake reports it removed.
 */

test('baking the village keeps the pixels and draws one mesh per group', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('village', { variant: 'naive', bake: '1' });
  await settle(forge.page);
  const before = await forge.page.screenshot({ type: 'png' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const report = f.compile();
    await f.world.warmup(f.renderer, f.camera);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const frame = await f.frameAsync();
    return { after: report.after, bake: report.bake, totals: frame.totals, baked: frame.byReason.baked?.submissions ?? 0 };
  });
  const after = await forge.page.screenshot({ type: 'png' });
  expect(r.after.baked).toBeGreaterThan(5);
  expect(r.after.batches).toBe(0);
  expect(r.baked).toBe(r.after.baked);
  expect(r.totals.unattributed).toBe(0);
  expect(r.bake!.triangles).toBeLessThanOrEqual(r.bake!.inputTriangles);
  expect(pixelDiff(before, after)).toBeLessThan(0.0005);
});

test('a modular wall loses only its seams; a block buried inside a solid goes only with removeBuried', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  for (const mode of ['1', 'buried'] as const) {
    await forge.open('empty', { bake: mode });
    await forge.page.evaluate(() => {
      const f = window.__forge;
      const T = f.three;
      const material = new T.MeshStandardMaterial({ color: 0xc0a080, roughness: 0.8 });
      // 6 x 3 wall of touching unit boxes, one big block with a slightly smaller one hidden inside it (faces 5 cm apart:
      // within the default buried distance of 0.1, unlike a room interior).
      for (let x = 0; x < 6; x++) {
        for (let y = 0; y < 3; y++) {
          const brick = new T.Mesh(new T.BoxGeometry(1, 1, 1), material);
          brick.position.set(x - 2.5, y + 0.5, 0);
          brick.name = `wall-${x}-${y}`;
          f.scene.add(brick);
        }
      }
      const big = new T.Mesh(new T.BoxGeometry(2, 2, 2), material);
      big.position.set(0, 1, -3);
      big.name = 'big';
      const inner = new T.Mesh(new T.BoxGeometry(1.9, 1.9, 1.9), material);
      inner.position.copy(big.position);
      inner.name = 'inner';
      f.scene.add(big, inner);
      f.scene.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) (o.userData as { forge?: string }).forge = 'static'; });
      const sun = new T.DirectionalLight(0xffffff, 2);
      sun.position.set(3, 6, 5);
      f.scene.add(new T.AmbientLight(0xffffff, 0.6), sun);
      f.camera.position.set(4, 4, 9);
      f.camera.lookAt(0, 1, -1);
      f.camera.updateMatrixWorld();
    });
    await settle(forge.page);
    const before = await forge.page.screenshot({ type: 'png' });
    const r = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const report = f.compile();
      for (let i = 0; i < 3; i++) await f.frameAsync();
      return { bake: report.bake!, after: report.after, submissions: (await f.frameAsync()).totals.sceneSubmissions };
    });
    const after = await forge.page.screenshot({ type: 'png' });
    expect(r.after.baked, mode).toBe(1);
    expect(r.submissions, mode).toBe(1);
    // 6x3 wall: 5x3 vertical seams + 6x2 horizontal seams = 27 seams x 4 triangles.
    expect(r.bake.contactFaces, mode).toBe(27 * 4);
    expect(r.bake.buriedFaces, mode).toBe(mode === 'buried' ? 12 : 0);
    expect(pixelDiff(before, after), mode).toBeLessThan(0.0005);
  }
});
