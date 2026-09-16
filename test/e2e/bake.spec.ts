import { expect, test, type ForgePage } from './fixtures.js';
import { differingPixels, pixelDiff, settle } from './pixels.js';

/** Records a measurement on the test (visible in the JSON and HTML reports) instead of printing it. */
function note(description: string): void {
  test.info().annotations.push({ type: 'bake', description });
}

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
  // And back: decompile() puts the originals in place of the baked meshes, so the picture must return to the first one.
  await forge.page.evaluate(async () => {
    window.__forge.decompile();
    for (let i = 0; i < 3; i++) await window.__forge.frameAsync();
  });
  await settle(forge.page, 2);
  const restored = await forge.page.screenshot({ type: 'png' });
  expect(r.after.baked).toBeGreaterThan(5);
  expect(r.after.batches).toBe(0);
  expect(r.baked).toBe(r.after.baked);
  expect(r.totals.unattributed).toBe(0);
  expect(r.bake!.triangles).toBeLessThanOrEqual(r.bake!.inputTriangles);
  const diff = pixelDiff(before, after, { threshold: 4 });
  const restoredDiff = differingPixels(before, restored, { threshold: 4 });
  note(`[${forge.backend}] village bake: ${r.after.baked} baked, pixel diff ${(diff * 100).toFixed(4)}%, after decompile ${restoredDiff} pixels`);
  expect(diff).toBeLessThan(0.0005);
  // Measured 0 differing pixels on webgl2 and 3 on webgpu (two runs each): held at a few pixels, not the bake's bound.
  expect(restoredDiff, 'decompile() did not restore the naive picture').toBeLessThanOrEqual(8);
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
    note(`[${forge.backend}] wall bake=${mode}: ${r.bake.contactFaces} seam faces removed, ${r.bake.keptCoincidentFaces} kept, ${r.bake.buriedFaces} buried, pixel diff ${(diff * 100).toFixed(4)}%`);
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
  note(`[${forge.backend}] mirrored wall: ${r.bake.contactFaces} seam faces removed, ${r.bake.keptCoincidentFaces} kept, pixel diff ${(diff * 100).toFixed(4)}%`);
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
    note(`[${forge.backend}] cards and floor/ceiling from ${views[i]!.name}: ${r.bake.contactFaces} removed, ${r.bake.keptCoincidentFaces} kept, pixel diff ${(diff * 100).toFixed(4)}%`);
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
  note(`[${forge.backend}] mirrored normal-mapped sphere through bakeGeometries: tangent ${r.hasTangent ? 'carried' : 'dropped'}, w ${JSON.stringify(r.bakedW)}, pixel diff ${(diff * 100).toFixed(4)}%`);
  expect(diff).toBeLessThan(0.0005);
});

test('touching BackSide rooms keep the wall between them, seen from inside a room and from outside', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('empty', { bake: '1' });
  await forge.page.evaluate(() => {
    const f = window.__forge;
    const T = f.three;
    // Two modular rooms drawn from the inside (BackSide) touching at x = 1.5. three draws only their back faces, so
    // from inside the first room, and from outside on its -x side, the nearest drawn surface ahead is the shared wall.
    const rooms: Array<[number, number, string]> = [[0, 0xc04040, 'room-a'], [3, 0x4060c0, 'room-b']];
    for (const [x, color, name] of rooms) {
      const room = new T.Mesh(new T.BoxGeometry(3, 3, 3), new T.MeshStandardMaterial({ color, roughness: 0.9, side: T.BackSide }));
      room.position.x = x;
      room.name = name;
      (room.userData as { forge?: string }).forge = 'static';
      f.scene.add(room);
    }
    const sun = new T.DirectionalLight(0xffffff, 1.5);
    sun.position.set(2, 5, 3);
    f.scene.add(new T.AmbientLight(0xffffff, 0.7), sun);
    f.scene.updateMatrixWorld(true);
  });
  const views: Array<{ name: string; position: [number, number, number] }> = [
    { name: 'inside the first room', position: [-1, 0.3, 0.4] },
    { name: 'outside, on -x', position: [-9, 1, 0.5] },
  ];
  const shoot = async (position: [number, number, number]): Promise<Buffer> => {
    await forge.page.evaluate((p) => {
      const f = window.__forge;
      f.camera.position.set(p[0], p[1], p[2]);
      f.camera.lookAt(1.5, 0, 0);
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
  expect(r.bake.keptCoincidentFaces).toBe(4);
  for (let i = 0; i < views.length; i++) {
    const diff = pixelDiff(before[i]!, await shoot(views[i]!.position), { threshold: 4 });
    note(`[${forge.backend}] BackSide rooms from ${views[i]!.name}: ${r.bake.contactFaces} removed, ${r.bake.keptCoincidentFaces} kept, pixel diff ${(diff * 100).toFixed(4)}%`);
    expect(diff, views[i]!.name).toBeLessThan(0.0005);
  }
});

test('touching toon boxes that cast shadows keep their seam, lit along it with shadows on', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('empty', { bake: '1' });
  await forge.page.evaluate(() => {
    const f = window.__forge;
    const T = f.three;
    f.renderer.shadowMap.enabled = true;
    // Non-VSM shadow maps draw a front-side material's back faces. With the light along +x, the first box's +x seam face
    // is the nearest caster, so the second box's +x face (turned away from the light) is in shadow; a toon material
    // still lights that face at 0.7 x light x shadow, so removing the seam would light it.
    const material = new T.MeshToonMaterial({ color: 0xd0b890 });
    for (const x of [0, 1]) {
      const box = new T.Mesh(new T.BoxGeometry(1, 1, 1), material);
      box.position.set(x, 0.5, 0);
      box.castShadow = true;
      box.receiveShadow = true;
      box.name = `toon-${x}`;
      (box.userData as { forge?: string }).forge = 'static';
      f.scene.add(box);
    }
    const sun = new T.DirectionalLight(0xffffff, 2.5);
    sun.position.set(-10, 0.6, 0.3);
    sun.target.position.set(1, 0.5, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const shadowCamera = sun.shadow.camera;
    shadowCamera.left = -3;
    shadowCamera.right = 3;
    shadowCamera.top = 3;
    shadowCamera.bottom = -3;
    shadowCamera.near = 1;
    shadowCamera.far = 30;
    shadowCamera.updateProjectionMatrix();
    f.scene.add(sun, sun.target, new T.AmbientLight(0xffffff, 0.3));
    f.scene.updateMatrixWorld(true);
    f.camera.position.set(4, 2.5, 3);
    f.camera.lookAt(1, 0.5, 0);
    f.camera.updateMatrixWorld();
  });
  await settle(forge.page, 5);
  const before = await forge.page.screenshot({ type: 'png' });
  const r = await compileAndSettle(forge);
  await settle(forge.page, 2);
  const after = await forge.page.screenshot({ type: 'png' });
  const diff = pixelDiff(before, after, { threshold: 4 });
  note(`[${forge.backend}] shadow-casting toon boxes: ${r.bake.contactFaces} removed, ${r.bake.keptCoincidentFaces} kept, pixel diff ${(diff * 100).toFixed(4)}%`);
  expect(r.after.baked).toBe(1);
  expect(r.bake.contactFaces).toBe(0);
  expect(r.bake.keptCoincidentFaces).toBe(4);
  expect(diff).toBeLessThan(0.0005);
});

test('a tinted duplicate keeps the colour three draws on top, and an interchangeable duplicate still goes', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('empty', { bake: '1' });
  await forge.page.evaluate(() => {
    const f = window.__forge;
    const T = f.three;
    const crate = (color: number, x: number, name: string) => {
      const mesh = new T.Mesh(new T.BoxGeometry(1.5, 1.5, 1.5), new T.MeshStandardMaterial({ color, roughness: 0.8 }));
      mesh.position.set(x, 0.75, 0);
      mesh.name = name;
      (mesh.userData as { forge?: string }).forge = 'static';
      return mesh;
    };
    // Two crates in one place differing only by colour, red created first: at equal depth three draws the later object
    // (opaque items sort by object id after depth), so the naive picture is blue. Two green crates in another place are
    // interchangeable copies. All four share one material variant, so they bake into one group.
    f.scene.add(crate(0xd04040, -1.2, 'crate-red'), crate(0x4060d0, -1.2, 'crate-blue'), crate(0x40b060, 1.2, 'crate-green-a'), crate(0x40b060, 1.2, 'crate-green-b'));
    const sun = new T.DirectionalLight(0xffffff, 2);
    sun.position.set(3, 6, 5);
    f.scene.add(new T.AmbientLight(0xffffff, 0.6), sun);
    f.scene.updateMatrixWorld(true);
    f.camera.position.set(2.5, 3, 6);
    f.camera.lookAt(0, 0.75, 0);
    f.camera.updateMatrixWorld();
  });
  await settle(forge.page);
  const before = await forge.page.screenshot({ type: 'png' });
  const r = await compileAndSettle(forge);
  const after = await forge.page.screenshot({ type: 'png' });
  const diff = pixelDiff(before, after, { threshold: 4 });
  note(`[${forge.backend}] tinted and interchangeable duplicate crates: ${r.bake.duplicateFaces} duplicate faces removed, ${r.bake.keptDuplicateFaces} kept, pixel diff ${(diff * 100).toFixed(4)}%`);
  expect(diff).toBeLessThan(0.0005);
  expect(r.after.baked).toBe(1);
  expect(r.submissions).toBe(1);
  expect(r.bake.duplicateFaces).toBe(12);
  expect(r.bake.keptDuplicateFaces).toBe(24);
});

test('vertex colours with alpha and a custom attribute a node material reads stay out of the bake, batched at parity', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('empty', { bake: '1' });
  await forge.page.evaluate(() => {
    const f = window.__forge;
    const T = f.three;
    const TSL = f.webgpu.TSL;
    // glTF BLEND with an RGBA COLOR_0: three multiplies the vertex colour's alpha into the diffuse alpha.
    const glass = new T.MeshStandardMaterial({ vertexColors: true, transparent: true, roughness: 0.6 });
    const pane = (x: number, name: string) => {
      const geometry = new T.PlaneGeometry(1.6, 1.6);
      const count = geometry.attributes.position!.count;
      const rgba = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) rgba.set([i % 2 ? 1 : 0.2, 0.7, i % 2 ? 0.2 : 1, 0.3], i * 4);
      geometry.setAttribute('color', new T.BufferAttribute(rgba, 4));
      const mesh = new T.Mesh(geometry, glass);
      mesh.position.set(x, 1.6, 0.5);
      mesh.name = name;
      return mesh;
    };
    // A node material colouring each vertex from an attribute the bake does not carry.
    const painted = new f.webgpu.MeshStandardNodeMaterial({ roughness: 0.7 });
    painted.colorNode = TSL.attribute('paint', 'vec3');
    const block = (x: number, name: string) => {
      const geometry = new T.BoxGeometry(1.2, 1.2, 1.2);
      const count = geometry.attributes.position!.count;
      const paint = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) paint.set([(i % 3) / 2, 0.8 - (i % 4) / 5, 0.4], i * 3);
      geometry.setAttribute('paint', new T.BufferAttribute(paint, 3));
      const mesh = new T.Mesh(geometry, painted);
      mesh.position.set(x, 0.6, -0.5);
      mesh.name = name;
      return mesh;
    };
    const backdrop = new T.Mesh(new T.BoxGeometry(6, 4, 0.2), new T.MeshStandardMaterial({ color: 0x303848 }));
    backdrop.position.set(0, 1.5, -2);
    backdrop.name = 'backdrop';
    f.scene.add(pane(-0.9, 'pane-a'), pane(0.9, 'pane-b'), block(-1.2, 'block-a'), block(1.2, 'block-b'), backdrop);
    f.scene.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) (o.userData as { forge?: string }).forge = 'static'; });
    const sun = new T.DirectionalLight(0xffffff, 2);
    sun.position.set(3, 6, 5);
    f.scene.add(new T.AmbientLight(0xffffff, 0.6), sun);
    f.scene.updateMatrixWorld(true);
    f.camera.position.set(0, 2, 6);
    f.camera.lookAt(0, 1, 0);
    f.camera.updateMatrixWorld();
  });
  await settle(forge.page);
  const before = await forge.page.screenshot({ type: 'png' });
  const r = await compileAndSettle(forge);
  const after = await forge.page.screenshot({ type: 'png' });
  const diff = pixelDiff(before, after, { threshold: 4 });
  note(`[${forge.backend}] RGBA vertex colours and a custom attribute: ${r.after.baked} baked, ${r.after.batches} batches, ${r.bake.unbakeableEntries} unbakeable, pixel diff ${(diff * 100).toFixed(4)}%`);
  expect(diff).toBeLessThan(0.0005);
  expect(r.after.baked).toBe(0);
  expect(r.after.batches).toBe(2);
  expect(r.bake.unbakeableEntries).toBe(4);
});

test('a node material reading a colour attribute its vertexColors flag ignores stays out of the bake, batched at parity', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('empty', { bake: '1' });
  await forge.page.evaluate(() => {
    const f = window.__forge;
    const T = f.three;
    const TSL = f.webgpu.TSL;
    const coloured = () => {
      const geometry = new T.BoxGeometry(1.2, 1.2, 1.2);
      const count = geometry.attributes.position!.count;
      const rgb = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) rgb.set([(i % 3) / 2, 0.9 - (i % 4) / 5, 0.3 + (i % 2) * 0.5], i * 3);
      geometry.setAttribute('color', new T.BufferAttribute(rgb, 3));
      return geometry;
    };
    // `vertexColors` stays false, so three's own diffuse colour ignores the attribute; the colour node reads it anyway.
    const painted = new f.webgpu.MeshStandardNodeMaterial({ roughness: 0.7 });
    painted.colorNode = TSL.vertexColor();
    // The control: three's own code alone reads its geometry, so the flag provably ignores the attribute and it bakes.
    const plain = new T.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.7 });
    const box = (material: InstanceType<typeof T.Material>, x: number, y: number, name: string) => {
      const mesh = new T.Mesh(coloured(), material);
      mesh.position.set(x, y, 0);
      mesh.name = name;
      return mesh;
    };
    const backdrop = new T.Mesh(new T.BoxGeometry(7, 5, 0.2), new T.MeshStandardMaterial({ color: 0x303848 }));
    backdrop.position.set(0, 1.5, -2);
    backdrop.name = 'backdrop';
    f.scene.add(box(painted, -1.6, 0.7, 'painted-a'), box(painted, 1.6, 0.7, 'painted-b'), box(plain, -1.6, 2.3, 'plain-a'), box(plain, 1.6, 2.3, 'plain-b'), backdrop);
    f.scene.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) (o.userData as { forge?: string }).forge = 'static'; });
    const sun = new T.DirectionalLight(0xffffff, 2);
    sun.position.set(3, 6, 5);
    f.scene.add(new T.AmbientLight(0xffffff, 0.6), sun);
    f.scene.updateMatrixWorld(true);
    f.camera.position.set(0, 1.5, 7);
    f.camera.lookAt(0, 1.5, 0);
    f.camera.updateMatrixWorld();
  });
  await settle(forge.page);
  const before = await forge.page.screenshot({ type: 'png' });
  const r = await compileAndSettle(forge);
  const after = await forge.page.screenshot({ type: 'png' });
  const diff = pixelDiff(before, after, { threshold: 4 });
  note(`[${forge.backend}] vertexColor() node with vertexColors false: ${r.after.baked} baked, ${r.after.batches} batches, ${r.bake.unbakeableEntries} unbakeable, pixel diff ${(diff * 100).toFixed(4)}%`);
  expect(diff).toBeLessThan(0.0005);
  expect(r.after.baked).toBe(1);
  expect(r.after.batches).toBe(1);
  expect(r.bake.unbakeableEntries).toBe(2);
});
