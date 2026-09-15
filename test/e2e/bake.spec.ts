import { expect, test, type ForgePage } from './fixtures.js';
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

/** A 6 x 3 wall of touching unit boxes (27 seams), optionally a block hidden inside a solid, optionally under a mirrored scene. */
async function buildWall(forge: ForgePage, options: { block: boolean; mirrored: boolean }): Promise<void> {
  await forge.page.evaluate(({ block, mirrored }) => {
    const f = window.__forge;
    const T = f.three;
    const material = new T.MeshStandardMaterial({ color: 0xc0a080, roughness: 0.8 });
    for (let x = 0; x < 6; x++) {
      for (let y = 0; y < 3; y++) {
        const brick = new T.Mesh(new T.BoxGeometry(1, 1, 1), material);
        brick.position.set(x - 2.5, y + 0.5, 0);
        brick.name = `wall-${x}-${y}`;
        f.scene.add(brick);
      }
    }
    if (block) {
      // One big block with a slightly smaller one hidden inside it (faces 5 cm apart: within the default buried
      // distance of 0.1, unlike a room interior).
      const big = new T.Mesh(new T.BoxGeometry(2, 2, 2), material);
      big.position.set(0, 1, -3);
      big.name = 'big';
      const inner = new T.Mesh(new T.BoxGeometry(1.9, 1.9, 1.9), material);
      inner.position.copy(big.position);
      inner.name = 'inner';
      f.scene.add(big, inner);
    }
    f.scene.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) (o.userData as { forge?: string }).forge = 'static'; });
    const sun = new T.DirectionalLight(0xffffff, 2);
    sun.position.set(3, 6, 5);
    f.scene.add(new T.AmbientLight(0xffffff, 0.6), sun);
    if (mirrored) f.scene.scale.x = -1;
    f.scene.updateMatrixWorld(true);
    f.camera.position.set(4, 4, 9);
    f.camera.lookAt(0, 1, -1);
    f.camera.updateMatrixWorld();
  }, options);
}

async function compileAndSettle(forge: ForgePage) {
  return forge.page.evaluate(async () => {
    const f = window.__forge;
    const report = f.compile();
    for (let i = 0; i < 3; i++) await f.frameAsync();
    return { bake: report.bake!, after: report.after, submissions: (await f.frameAsync()).totals.sceneSubmissions };
  });
}

test('a modular wall loses only its seams; a block buried inside a solid goes only with removeBuried', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  for (const mode of ['1', 'buried'] as const) {
    await forge.open('empty', { bake: mode });
    await buildWall(forge, { block: true, mirrored: false });
    await settle(forge.page);
    const before = await forge.page.screenshot({ type: 'png' });
    const r = await compileAndSettle(forge);
    const after = await forge.page.screenshot({ type: 'png' });
    expect(r.after.baked, mode).toBe(1);
    expect(r.submissions, mode).toBe(1);
    // 6x3 wall: 5x3 vertical seams + 6x2 horizontal seams = 27 seams x 4 triangles; the guard keeps none of them.
    expect(r.bake.contactFaces, mode).toBe(27 * 4);
    expect(r.bake.keptCoincidentFaces, mode).toBe(0);
    expect(r.bake.buriedFaces, mode).toBe(mode === 'buried' ? 12 : 0);
    const diff = pixelDiff(before, after, { threshold: 4 });
    console.log(`[${forge.backend}] wall bake=${mode}: ${r.bake.contactFaces} seam faces removed, ${r.bake.keptCoincidentFaces} kept, ${r.bake.buriedFaces} buried, pixel diff ${(diff * 100).toFixed(4)}%`);
    expect(diff, mode).toBeLessThan(0.0005);
  }
});

test('a modular wall under a mirrored scene loses exactly its seams and keeps its pixels', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('empty', { bake: '1' });
  await buildWall(forge, { block: false, mirrored: true });
  await settle(forge.page);
  const before = await forge.page.screenshot({ type: 'png' });
  const r = await compileAndSettle(forge);
  const after = await forge.page.screenshot({ type: 'png' });
  expect(r.after.baked).toBe(1);
  expect(r.submissions).toBe(1);
  expect(r.bake.contactFaces).toBe(27 * 4);
  expect(r.bake.keptCoincidentFaces).toBe(0);
  const diff = pixelDiff(before, after, { threshold: 4 });
  console.log(`[${forge.backend}] mirrored wall: ${r.bake.contactFaces} seam faces removed, ${r.bake.keptCoincidentFaces} kept, pixel diff ${(diff * 100).toFixed(4)}%`);
  expect(diff).toBeLessThan(0.0005);
});

test('back-to-back sign cards and a floor under a ceiling keep both faces, seen from both sides', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('empty', { bake: '1' });
  await forge.page.evaluate(() => {
    const f = window.__forge;
    const T = f.three;
    const card = (color: number, name: string, turned: boolean) => {
      const mesh = new T.Mesh(new T.PlaneGeometry(2, 1.2), new T.MeshStandardMaterial({ color, roughness: 0.9 }));
      mesh.position.set(-1.8, 1.2, 0);
      if (turned) mesh.rotation.y = Math.PI;
      mesh.name = name;
      return mesh;
    };
    const slab = (color: number, name: string, up: boolean) => {
      const mesh = new T.Mesh(new T.PlaneGeometry(2.4, 2.4), new T.MeshStandardMaterial({ color, roughness: 0.9 }));
      mesh.position.set(1.6, 1.2, 0);
      mesh.rotation.x = up ? -Math.PI / 2 : Math.PI / 2;
      mesh.name = name;
      return mesh;
    };
    // A sign whose two faces are separate cards, and the upper storey's floor lying on the lower storey's ceiling:
    // coincident, opposite-winding pairs that are both visible, one from each side.
    f.scene.add(card(0xd04040, 'sign-front', false), card(0x4060d0, 'sign-back', true), slab(0x40b060, 'upper-floor', true), slab(0xd0b040, 'lower-ceiling', false));
    f.scene.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) (o.userData as { forge?: string }).forge = 'static'; });
    const above = new T.DirectionalLight(0xffffff, 2);
    above.position.set(3, 6, 5);
    const below = new T.DirectionalLight(0xffffff, 1.5);
    below.position.set(-3, -6, -5);
    f.scene.add(new T.AmbientLight(0xffffff, 0.8), above, below);
    f.scene.updateMatrixWorld(true);
  });
  const views: Array<{ name: string; position: [number, number, number] }> = [
    { name: 'front, above', position: [0, 4, 7] },
    { name: 'behind, below', position: [0, -2.5, -7] },
  ];
  const shoot = async (position: [number, number, number]): Promise<Buffer> => {
    await forge.page.evaluate((p) => {
      const f = window.__forge;
      f.camera.position.set(p[0], p[1], p[2]);
      f.camera.lookAt(0, 1.2, 0);
      f.camera.updateMatrixWorld();
    }, position);
    await settle(forge.page);
    return forge.page.screenshot({ type: 'png' });
  };
  const before: Buffer[] = [];
  for (const view of views) before.push(await shoot(view.position));
  const r = await compileAndSettle(forge);
  expect(r.after.baked).toBe(1);
  expect(r.submissions).toBe(1);
  expect(r.bake.contactFaces).toBe(0);
  expect(r.bake.keptCoincidentFaces).toBe(8);
  for (let i = 0; i < views.length; i++) {
    const diff = pixelDiff(before[i]!, await shoot(views[i]!.position), { threshold: 4 });
    console.log(`[${forge.backend}] cards and floor/ceiling from ${views[i]!.name}: ${r.bake.contactFaces} removed, ${r.bake.keptCoincidentFaces} kept, pixel diff ${(diff * 100).toFixed(4)}%`);
    expect(diff, views[i]!.name).toBeLessThan(0.0005);
  }
});

test('a mirrored, normal-mapped mesh baked by bakeGeometries keeps its tangents and its pixels', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('empty');
  await forge.page.evaluate(() => {
    const f = window.__forge;
    const T = f.three;
    // A normal map that tilts only along v, in stripes: the bitangent's sign decides the lighting.
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4;
        data[o] = 128;
        data[o + 1] = Math.round(128 + 110 * Math.sin((y / size) * Math.PI * 8));
        data[o + 2] = 200;
        data[o + 3] = 255;
      }
    }
    const normalMap = new T.DataTexture(data, size, size);
    normalMap.wrapS = normalMap.wrapT = T.RepeatWrapping;
    normalMap.needsUpdate = true;
    const geometry = new T.SphereGeometry(1.5, 64, 32);
    geometry.computeTangents();
    const mesh = new T.Mesh(geometry, new T.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.4, normalMap }));
    mesh.name = 'tangent-naive';
    mesh.scale.set(-1, 1, 1);
    mesh.rotation.y = 0.6;
    const sun = new T.DirectionalLight(0xffffff, 3);
    sun.position.set(2, 5, 4);
    f.scene.add(mesh, new T.AmbientLight(0xffffff, 0.2), sun);
    f.scene.updateMatrixWorld(true);
    f.camera.position.set(0, 0.5, 6);
    f.camera.lookAt(0, 0, 0);
    f.camera.updateMatrixWorld();
  });
  await settle(forge.page, 5);
  const before = await forge.page.screenshot({ type: 'png' });
  const r = await forge.page.evaluate(() => {
    const f = window.__forge;
    const T = f.three;
    const naive = f.scene.getObjectByName('tangent-naive') as InstanceType<typeof T.Mesh>;
    const result = f.bakeGeometries([{ geometry: naive.geometry, matrix: naive.matrixWorld, opaque: true, vertexColors: false }]);
    const baked = new T.Mesh(result.geometry, naive.material);
    baked.name = 'tangent-baked';
    naive.visible = false;
    f.scene.add(baked);
    f.scene.updateMatrixWorld(true);
    // The w values of the vertices the triangles use (computeTangents leaves w = 0 on vertices no triangle references,
    // such as unused pole vertices of a sphere, and the bake emits only referenced vertices).
    const wValues = (geometry: InstanceType<typeof T.BufferGeometry>): number[] => {
      const tangent = geometry.getAttribute('tangent') as InstanceType<typeof T.BufferAttribute> | undefined;
      if (!tangent) return [];
      const used = geometry.index ? new Set(Array.from(geometry.index.array)) : new Set(Array.from({ length: tangent.count }, (_, i) => i));
      return [...new Set([...used].map((i) => tangent.getW(i)))].sort();
    };
    return { mirrored: naive.matrixWorld.determinant() < 0, hasTangent: result.geometry.getAttribute('tangent') !== undefined, sourceW: wValues(naive.geometry), bakedW: wValues(result.geometry), report: result.report };
  });
  await settle(forge.page, 5);
  const after = await forge.page.screenshot({ type: 'png' });
  expect(r.mirrored).toBe(true);
  expect(r.hasTangent).toBe(true);
  expect(r.bakedW).toEqual(r.sourceW);
  expect(r.report.triangles).toBe(r.report.inputTriangles);
  const diff = pixelDiff(before, after, { threshold: 4 });
  console.log(`[${forge.backend}] mirrored normal-mapped sphere through bakeGeometries: tangent ${r.hasTangent ? 'carried' : 'dropped'}, w ${JSON.stringify(r.bakedW)}, pixel diff ${(diff * 100).toFixed(4)}%`);
  expect(diff).toBeLessThan(0.0005);
});
