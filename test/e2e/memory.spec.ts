import { expect, note, test } from './fixtures.js';

/** createLoader decodes Draco and meshopt content; a tracked subtree, released, returns the renderer's counts to where they were. */
for (const asset of ['Duck-Draco', 'BrainStem-Meshopt']) {
  test(`memory: ${asset} loads through createLoader and releases without leaks`, { tag: '@corpus' }, async ({
    forge,
  }) => {
    await forge.open('empty');
    const r = await forge.page.evaluate(async (name) => {
      const f = window.__forge;
      await f.frameAsync();
      const before = f.memory.info();
      const loaded = await f.memory.load(name);
      await f.frameAsync();
      const during = f.memory.info();
      f.memory.remove(); // removed without dispose: the recount must notice
      await f.frameAsync();
      const removed = f.memory.info().unreferenced;
      f.memory.release();
      await f.frameAsync();
      const after = f.memory.info();
      return { before, loaded, during, removed, after };
    }, asset);
    console.log(`memory ${asset}:`, JSON.stringify(r));
    expect(r.loaded.geometries).toBeGreaterThan(0);
    expect(r.during.geometries).toBeGreaterThan(r.before.geometries);
    expect(r.during.unreferenced).toEqual({ geometries: 0, textures: 0 });
    expect(r.removed.geometries).toBeGreaterThan(0);
    expect(r.after.geometries).toBe(r.before.geometries);
    expect(r.after.textures).toBe(r.before.textures);
    expect(r.after.unreferenced).toEqual({ geometries: 0, textures: 0 });
  });
}

/*
 * Lit cells use MeshStandardMaterial on purpose: lighting one makes three r186 create its private 16 x 16 DFG_LUT
 * texture (nodes/functions/BSDF/DFGLUT.js), which nothing in the scene reaches and the ledger must still allow.
 */

test('memory: measuring overdraw adds the count target to info.memory.textures and nothing to memory.unreferenced', async ({
  forge,
}) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    f.scene.add(
      new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial({ color: 0xc0a080 })),
      new T.AmbientLight(0xffffff, 1),
    );
    const read = () => ({
      textures: f.renderer.info.memory.textures,
      unreferenced: f.ledger.measureMemory().unreferenced,
    });
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const before = read();
    await f.measureOverdraw();
    await f.frameAsync();
    const measured = read();
    await f.measureOverdraw(); // the same size: the same target
    await f.frameAsync();
    const again = read();
    await f.ledger.measureOverdraw(f.scene, f.camera, { scale: 1 / 4 }); // another size: a new target replaces it
    await f.frameAsync();
    const resized = read();
    return { before, measured, again, resized };
  });
  const added = r.measured.textures - r.before.textures;
  note(
    'memory',
    `[${forge.backend}] the overdraw count target adds ${added} texture(s) to info.memory.textures: ${JSON.stringify(r)}`,
  );
  console.log(`memory [${forge.backend}] overdraw count target textures: ${added}`, JSON.stringify(r));
  expect(r.before.unreferenced).toEqual({ geometries: 0, textures: 0 });
  // RenderTarget({ depthBuffer: false }): Textures.updateRenderTarget creates its colour texture and no depth texture.
  expect(added).toBe(1);
  expect(r.measured.unreferenced).toEqual({ geometries: 0, textures: 0 });
  expect([r.again.textures, r.resized.textures]).toEqual([r.measured.textures, r.measured.textures]);
  expect(r.resized.unreferenced).toEqual({ geometries: 0, textures: 0 });
});

test('memory: on the naive scene the overdraw count target adds one texture to info.memory and nothing to memory.unreferenced', async ({
  forge,
}) => {
  await forge.open('naive');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const read = () => ({
      textures: f.renderer.info.memory.textures,
      unreferenced: f.ledger.measureMemory().unreferenced,
    });
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const before = read();
    await f.measureOverdraw();
    await f.frameAsync();
    return { before, measured: read() };
  });
  note('memory', `[${forge.backend}] naive scene, before and after measureOverdraw: ${JSON.stringify(r)}`);
  expect(r.measured.textures - r.before.textures).toBe(1);
  expect(r.before.unreferenced).toEqual({ geometries: 0, textures: 0 });
  expect(r.measured.unreferenced).toEqual({ geometries: 0, textures: 0 });
});

test('memory: one shadow light with a [0, 0] viewport reports no unreferenced textures', async ({ forge }) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    f.renderer.shadowMap.enabled = true;
    const material = new T.MeshStandardMaterial({ color: 0xc0a080 });
    const ground = new T.Mesh(new T.PlaneGeometry(10, 10), material);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    const box = new T.Mesh(new T.BoxGeometry(1, 1, 1), material);
    box.position.y = 1;
    box.castShadow = true;
    box.receiveShadow = true;
    const sun = new T.DirectionalLight(0xffffff, 2);
    sun.position.set(3, 6, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(512, 512);
    f.scene.add(ground, box, sun, new T.AmbientLight(0xffffff, 0.3));
    f.scene.updateMatrixWorld(true);
    f.ledger.setEnvironment({ viewport: [0, 0] });
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const m = f.ledger.measureMemory();
    return {
      built: sun.shadow.map !== null,
      textures: f.renderer.info.memory.textures,
      viewport: f.frame().env.viewport,
      unreferenced: m.unreferenced,
      renderTargets: m.renderTargets,
    };
  });
  note('memory', `[${forge.backend}] one shadow light, viewport [0, 0]: ${JSON.stringify(r)}`);
  expect(r.built).toBe(true);
  expect(r.viewport).toEqual([0, 0]);
  expect(r.unreferenced).toEqual({ geometries: 0, textures: 0 });
  expect(r.renderTargets).toEqual({ count: 1, bytes: 512 * 512 * 4 });
});

test('memory: a casting light whose shadow map three never built is not allowed for, so a texture removed without dispose() still counts', async ({
  forge,
}) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const receiver = new T.Mesh(new T.PlaneGeometry(10, 10), new T.MeshStandardMaterial({ color: 0xc0a080 }));
    receiver.rotation.x = -Math.PI / 2;
    receiver.receiveShadow = true;
    const sun = new T.DirectionalLight(0xffffff, 2);
    sun.castShadow = true; // renderer.shadowMap.enabled stays false: ShadowNode.setup returns before it builds a map
    f.scene.add(receiver, sun);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const clean = f.ledger.measureMemory().unreferenced;
    const map = new T.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    map.needsUpdate = true;
    const probe = new T.Mesh(new T.PlaneGeometry(4, 4), new T.MeshBasicMaterial({ map }));
    f.scene.add(probe);
    await f.frameAsync();
    probe.removeFromParent(); // without dispose(): three keeps its texture and geometry
    await f.frameAsync();
    return {
      enabled: f.renderer.shadowMap.enabled,
      built: sun.shadow.map !== null,
      clean,
      leaked: f.ledger.measureMemory().unreferenced,
    };
  });
  expect([r.enabled, r.built]).toEqual([false, false]);
  expect(r.clean).toEqual({ geometries: 0, textures: 0 });
  expect(r.leaked).toEqual({ geometries: 1, textures: 1 });
});

test("memory.measured is three's own renderer.info.memory", async ({ forge }) => {
  await forge.open('naive');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    for (let i = 0; i < 2; i++) await f.frameAsync();
    const measured = f.ledger.measureMemory().measured;
    const m = f.renderer.info.memory as unknown as Record<string, number>;
    const info = {
      textures: m.textures!,
      texturesSize: m.texturesSize!,
      geometries: m.geometries!,
      attributesSize: m.attributesSize!,
      indexAttributesSize: m.indexAttributesSize!,
      renderTargets: m.renderTargets!,
      total: m.total!,
    };
    return { measured, info, snapshot: f.frame().memory.measured };
  });
  note('memory', `[${forge.backend}] memory.measured on the naive scene: ${JSON.stringify(r.measured)}`);
  expect(r.measured).toEqual({
    textures: { count: r.info.textures, bytes: r.info.texturesSize },
    geometries: { count: r.info.geometries, bytes: r.info.attributesSize + r.info.indexAttributesSize },
    renderTargets: { count: r.info.renderTargets },
    bytes: r.info.total,
  });
  expect(r.measured!.textures.bytes).toBeGreaterThan(0);
  expect(r.snapshot).toEqual(r.measured);
});

test('memory: bakeDebug() twice, attached and then disposed: reachable while attached, and the counts return to where they were', async ({
  forge,
}) => {
  await forge.open('empty', { bake: '1' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const material = new T.MeshStandardMaterial({ color: 0xc0a080 });
    for (let x = 0; x < 4; x++) {
      const brick = new T.Mesh(new T.BoxGeometry(1, 1, 1), material);
      brick.position.set(x - 1.5, 0.5, 0);
      brick.userData.forge = 'static';
      f.scene.add(brick);
    }
    f.scene.add(new T.AmbientLight(0xffffff, 1));
    f.scene.updateMatrixWorld(true);
    const report = f.compile();
    const counts = () => {
      const m = f.renderer.info.memory;
      return { geometries: m.geometries, textures: m.textures, unreferenced: f.ledger.measureMemory().unreferenced };
    };
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const start = counts();
    const debug = [f.world.bakeDebug(), f.world.bakeDebug()];
    f.scene.add(...debug);
    for (let i = 0; i < 2; i++) await f.frameAsync();
    const attached = counts();
    for (const group of debug) {
      group.removeFromParent();
      group.traverse((o) => {
        const mesh = o as unknown as { isMesh?: boolean; geometry: { dispose(): void }; material: { dispose(): void } };
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        mesh.material.dispose();
      });
    }
    for (let i = 0; i < 2; i++) await f.frameAsync();
    return {
      baked: report.after.baked,
      debugMeshes: debug.map((g) => g.children.length),
      start,
      attached,
      disposed: counts(),
    };
  });
  note('memory', `[${forge.backend}] bakeDebug twice: ${JSON.stringify(r)}`);
  expect(r.baked).toBeGreaterThan(0);
  expect(r.debugMeshes.every((n) => n > 0)).toBe(true);
  expect(r.start.unreferenced).toEqual({ geometries: 0, textures: 0 });
  expect(r.attached.geometries).toBe(r.start.geometries + r.debugMeshes[0]! + r.debugMeshes[1]!);
  expect(r.attached.unreferenced).toEqual({ geometries: 0, textures: 0 });
  expect(r.disposed).toEqual(r.start);
});

test('memory: a tinted group batches with a clone sharing the source texture, counted once, and decompile() and world.dispose() return the counts to the naive ones', async ({
  forge,
}) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const map = new T.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    map.needsUpdate = true;
    const sources: unknown[] = [];
    [0xff8080, 0x80ff80, 0x8080ff, 0xffff80].forEach((color, i) => {
      // Different sizes, so the group batches instead of instancing.
      const material = new T.MeshStandardMaterial({ color, map });
      sources.push(material);
      const box = new T.Mesh(new T.BoxGeometry(0.4 + i * 0.1, 0.5, 0.5), material);
      box.position.set(i - 1.5, 0, 0);
      box.userData.forge = 'static';
      f.scene.add(box);
    });
    f.scene.add(new T.AmbientLight(0xffffff, 1));
    f.scene.updateMatrixWorld(true);
    const counts = () => {
      const m = f.renderer.info.memory;
      const info = f.memory.info();
      return {
        geometries: m.geometries,
        textures: m.textures,
        reachableTextures: info.reachable.textures,
        unreferenced: info.unreferenced,
      };
    };
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const naive = counts();
    const report = f.compile();
    for (let i = 0; i < 3; i++) await f.frameAsync();
    type Batch = {
      material: { map?: unknown; addEventListener(type: 'dispose', listener: () => void): void };
      _matricesTexture?: unknown;
      _indirectTexture?: unknown;
      _colorsTexture?: unknown;
    };
    const disposed: string[] = [];
    const batchOf = (label: string) => {
      const batch = f.world.batchedMeshes[0] as unknown as Batch | undefined;
      batch?.material.addEventListener('dispose', () => disposed.push(label));
      return batch;
    };
    const batch = batchOf('clone released by decompile()');
    const batchTextures = batch
      ? [batch._matricesTexture, batch._indirectTexture, batch._colorsTexture].filter(Boolean).length
      : 0;
    const compiled = {
      ...counts(),
      batches: report.after.batches,
      isClone: !!batch && !sources.includes(batch.material),
      sharesMap: batch?.material.map === map,
      batchTextures,
    };
    f.decompile();
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const decompiled = counts();
    f.compile();
    for (let i = 0; i < 3; i++) await f.frameAsync();
    batchOf('clone released by dispose()');
    const recompiled = counts();
    f.world.dispose();
    for (let i = 0; i < 3; i++) await f.frameAsync();
    return { naive, compiled, decompiled, recompiled, worldDisposed: counts(), disposed };
  });
  note('memory', `[${forge.backend}] tinted group: ${JSON.stringify(r)}`);
  expect(r.compiled.batches).toBe(1);
  expect(r.compiled.isClone, 'the batch draws with a white clone carrying the tints, not a source material').toBe(true);
  expect(r.compiled.sharesMap).toBe(true);
  // The source materials and the clone reach one texture: the batch adds only its own data textures.
  expect(r.compiled.reachableTextures).toBe(r.naive.reachableTextures + r.compiled.batchTextures);
  expect(r.naive.unreferenced).toEqual({ geometries: 0, textures: 0 });
  expect(r.compiled.unreferenced).toEqual({ geometries: 0, textures: 0 });
  expect(r.decompiled).toEqual(r.naive);
  expect(r.recompiled.unreferenced).toEqual({ geometries: 0, textures: 0 });
  expect(r.worldDisposed).toEqual(r.naive);
  expect(r.disposed).toEqual(['clone released by decompile()', 'clone released by dispose()']);
});

test('memory: occlusion proxies add nothing unreferenced while compiled, and decompile() returns the counts to the naive ones', async ({
  forge,
}) => {
  await forge.open('naive', { chunk: '40', occlusion: '1', wall: '1' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const counts = () => {
      const m = f.renderer.info.memory;
      return { geometries: m.geometries, textures: m.textures, unreferenced: f.ledger.measureMemory().unreferenced };
    };
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const naive = counts();
    f.compile();
    for (let i = 0; i < 6; i++) await f.frameAsync();
    const proxies = f.frame().byReason['occlusion-proxy']?.submissions ?? 0;
    const compiled = { ...counts(), proxies };
    f.decompile();
    for (let i = 0; i < 3; i++) await f.frameAsync();
    return { naive, compiled, decompiled: counts() };
  });
  note('memory', `[${forge.backend}] occlusion proxies: ${JSON.stringify(r)}`);
  expect(r.compiled.proxies).toBeGreaterThan(4);
  expect(r.naive.unreferenced).toEqual({ geometries: 0, textures: 0 });
  expect(r.compiled.unreferenced).toEqual({ geometries: 0, textures: 0 });
  expect(r.decompiled).toEqual(r.naive);
});

test('memory: a VSM shadow light: its map, depth and two blur targets are allowed, so nothing reads as unreferenced', async ({
  forge,
}) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    f.renderer.shadowMap.enabled = true;
    f.renderer.shadowMap.type = T.VSMShadowMap;
    const material = new T.MeshStandardMaterial({ color: 0xc0a080 });
    const ground = new T.Mesh(new T.PlaneGeometry(10, 10), material);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    const box = new T.Mesh(new T.BoxGeometry(1, 1, 1), material);
    box.position.y = 1;
    box.castShadow = true;
    box.receiveShadow = true;
    const sun = new T.DirectionalLight(0xffffff, 2);
    sun.position.set(3, 6, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(256, 256);
    f.scene.add(ground, box, sun);
    f.scene.updateMatrixWorld(true);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const m = f.ledger.measureMemory();
    return { built: sun.shadow.map !== null, textures: f.renderer.info.memory.textures, unreferenced: m.unreferenced };
  });
  note('memory', `[${forge.backend}] VSM shadow light: ${JSON.stringify(r)}`);
  expect(r.built).toBe(true);
  // The frame buffer (2), the DFG LUT (1), the map and its depth (2), the two blur targets (2).
  expect(r.textures).toBe(7);
  expect(r.unreferenced).toEqual({ geometries: 0, textures: 0 });
});

/*
 * Resources three creates for itself that nothing in the scene reaches (three r186): PMREM for an equirect
 * `scene.environment`/`background` (PMREMNode's own generator, nodes/pmrem/PMREMNode.js ~323, renders LOD planes with
 * an `outputDirection` attribute, renderers/common/extras/PMREMGenerator.js ~821, into targets whose textures carry
 * `isPMREMTexture`, ~850-853); the background sphere (renderers/common/Background.js ~131), drawn outside the scene;
 * one float DataArrayTexture per morphed geometry (nodes/accessors/Morph.js ~93); and post-processing's PassNode and
 * BloomNode render targets, drawn every frame.
 */
test("memory: three's own PMREM, background, morph and post-processing resources are not unreferenced, while a real leak still is", async ({
  forge,
}) => {
  await forge.open('empty', { bloom: '1' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const width = 256;
    const height = 128;
    const sky = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const up = y / height;
        sky.set([0.4 + 2.5 * up, 0.5 + 2 * up, 0.9 + 3 * up, 1], o);
      }
    }
    const hdr = new T.DataTexture(sky, width, height, T.RGBAFormat, T.FloatType);
    hdr.mapping = T.EquirectangularReflectionMapping;
    hdr.needsUpdate = true;
    f.scene.environment = hdr;
    f.scene.background = hdr;
    const body = new T.BoxGeometry(1, 1, 1);
    const position = body.attributes.position!;
    const inflated = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++)
      inflated.set([position.getX(i) * 1.3, position.getY(i) * 1.3, position.getZ(i) * 1.3], i * 3);
    body.morphAttributes.position = [new T.Float32BufferAttribute(inflated, 3)];
    const blob = new T.Mesh(body, new T.MeshStandardMaterial({ color: 0x8090c0, roughness: 0.2, metalness: 0.8 }));
    blob.morphTargetInfluences = [0.5];
    blob.position.set(-1, 0, 0);
    const ball = new T.Mesh(
      new T.SphereGeometry(0.6, 32, 16),
      new T.MeshStandardMaterial({ color: 0xc09060, roughness: 0.4 }),
    );
    ball.position.set(1, 0, 0);
    f.scene.add(blob, ball);
    f.camera.position.set(0, 1, 4);
    f.camera.lookAt(0, 0, 0);
    f.camera.updateMatrixWorld();
    for (let i = 0; i < 4; i++) await f.frameAsync();
    const memory = f.renderer.info.memory;
    const clean = {
      unreferenced: f.ledger.measureMemory().unreferenced,
      textures: memory.textures,
      geometries: memory.geometries,
      hints: f.frame().hints.map((h) => h.code),
    };
    const map = new T.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    map.needsUpdate = true;
    const probe = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map }));
    f.scene.add(probe);
    await f.frameAsync();
    probe.removeFromParent(); // without dispose(): three keeps its texture and geometry
    await f.frameAsync();
    return { clean, leaked: f.ledger.measureMemory().unreferenced };
  });
  note('memory', `[${forge.backend}] PMREM + background + morph + bloom: ${JSON.stringify(r)}`);
  expect(r.clean.unreferenced).toEqual({ geometries: 0, textures: 0 });
  expect(r.clean.hints).not.toContain('unreferenced-resources');
  expect(r.leaked).toEqual({ geometries: 1, textures: 1 });
});
