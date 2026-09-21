/**
 * Shadow passes on compiled batches and compacted instanced meshes: casters outside the main view must still shadow
 * what is in view. three renders a light's shadow map from inside the first `receiveShadow` object's draw, nested in
 * the main pass, so a batch's shadow draw must add the casters the shadow camera sees without rewriting the rows the
 * main pass already recorded (WebGPU submits the main pass only when it ends; on WebGL the receiver draws right after
 * the shadow render returns). Every scene compares the naive scene with the compiled one under 'per-pass' (the default
 * on both backends) and 'reuse-main'. Without pixel checks (SwiftShader WebGPU) the pass counts, `unattributed` and
 * the missing-caster spies still run; only the captures and the pixel comparison are skipped.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deviceLostOrder, expect, type ForgePage, test } from './fixtures.js';
import { pixelDiff, settle } from './pixels.js';

const OUT = 'test-results/nested-passes';

/** 'auto' resolves to 'per-pass' on both backends; 'reuse-main' is the other policy. */
const POLICIES = ['auto', 'reuse-main'] as const;
type Nested = (typeof POLICIES)[number];
const policyOf = (nested: Nested): string => (nested === 'reuse-main' ? 'reuse-main' : 'per-pass');
const nestedQuery = (nested: Nested): Record<string, string> => (nested === 'auto' ? {} : { nested });

/**
 * Without pixel checks the adapter is SwiftShader, which drops the WebGPU device between test steps (docs/design.md,
 * "WebGPU in the test harness"): every frame after that is empty, so the assertions would fail on the environment.
 * Skips with the loss message instead, saying whether the loss came before threeforge's first `compile()` (the
 * environment's) or after (needs a look); with pixel checks (native) it does nothing.
 */
async function skipIfDeviceLost(forge: ForgePage): Promise<void> {
  if (forge.pixelChecks) return;
  const { lost, timing } = await forge.page.evaluate(async () => ({
    lost: await window.__forge.deviceLost(),
    timing: window.__forge.deviceLostTiming(),
  }));
  test.skip(
    lost !== null,
    `the ${forge.backend} adapter dropped the device (${lost}), ${deviceLostOrder(timing)}; the count assertions from here on cannot run`,
  );
}

/** Keeps the measured numbers with the test result instead of printing them. */
async function attachNumbers(name: string, value: unknown): Promise<void> {
  await test.info().attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

for (const nested of POLICIES) {
  test(`out-of-view casters shadow a batch through a narrow sun frustum (nestedPasses: ${nested})`, async ({
    forge,
  }) => {
    // threshold=1000 keeps the 289 repeated tiles in the BatchedMesh (the default 64 would make them an InstancedMesh).
    await forge.open('empty', { threshold: '1000', ...nestedQuery(nested) });
    const built = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const T = f.three;
      const { scene, camera, renderer } = f;
      renderer.shadowMap.enabled = true;
      scene.add(new T.AmbientLight(0xffffff, 0.35));
      // The sun comes from +x at a 22 degree elevation: 40-unit pillars at x >= 56 throw shadows back to about x = -43.
      const sun = new T.DirectionalLight(0xffffff, 2.5);
      sun.name = 'sun';
      sun.position.set(200, 80, 0);
      sun.target.position.set(0, 0, 0);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      // Narrow across z: tiles in view with |z| > ~11 lie outside the shadow camera (the 40-unit pillars' bounding
      // spheres, radius 20, reach into it from every row).
      const sc = sun.shadow.camera;
      sc.left = -10;
      sc.right = 10;
      sc.top = 40;
      sc.bottom = -40;
      sc.near = 1;
      sc.far = 400;
      sc.updateProjectionMatrix();
      scene.add(sun, sun.target);
      // An unlit ground that neither casts nor receives: it stays a mesh and is not the first receiver.
      const ground = new T.Mesh(new T.PlaneGeometry(400, 400), new T.MeshBasicMaterial({ color: 0x2c3138 }));
      ground.name = 'ground';
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.01;
      ground.userData.forge = 'static';
      scene.add(ground);
      // One lit material shared by the tiles in view and the pillars out of view: one receiving and casting batch.
      const lit = new T.MeshStandardMaterial({ color: 0xb8c0c8, roughness: 0.9, metalness: 0 });
      const tileGeometry = new T.BoxGeometry(1.6, 0.4, 1.6);
      const pillarGeometry = new T.BoxGeometry(2, 40, 2);
      const tiles: InstanceType<typeof T.Mesh>[] = [];
      for (let x = -16; x <= 16; x += 2) {
        for (let z = -16; z <= 16; z += 2) {
          const tile = new T.Mesh(tileGeometry, lit);
          tile.name = `tile-${tiles.length}`;
          tile.position.set(x, 0.2, z);
          tile.castShadow = tile.receiveShadow = true;
          tile.userData.forge = 'static';
          tiles.push(tile);
          scene.add(tile);
        }
      }
      const pillars: InstanceType<typeof T.Mesh>[] = [];
      for (const x of [56, 60, 64, 68]) {
        for (const z of [-12, -6, 0, 6, 12]) {
          const pillar = new T.Mesh(pillarGeometry, lit);
          pillar.name = `pillar-${pillars.length}`;
          pillar.position.set(x, 20, z);
          pillar.castShadow = pillar.receiveShadow = true;
          pillar.userData.forge = 'static';
          pillars.push(pillar);
          scene.add(pillar);
        }
      }
      camera.position.set(0, 14, 26);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      scene.updateMatrixWorld(true);
      await f.frameAsync(); // sets both cameras' coordinate system for this backend and places the shadow camera
      const frustumOf = (c: typeof camera | typeof sc) =>
        new T.Frustum().setFromProjectionMatrix(
          new T.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse),
          c.coordinateSystem,
          c.reversedDepth,
        );
      const view = frustumOf(camera);
      const light = frustumOf(sc);
      return {
        tiles: tiles.length,
        pillars: pillars.length,
        tilesInView: tiles.filter((t) => view.intersectsObject(t)).length,
        pillarsInView: pillars.filter((p) => view.intersectsObject(p)).length,
        castersInShadow: [...tiles, ...pillars].filter((c) => light.intersectsObject(c)).length,
        pillarsInShadow: pillars.filter((p) => light.intersectsObject(p)).length,
        tilesInViewOutsideShadow: tiles.filter((t) => view.intersectsObject(t) && !light.intersectsObject(t)).length,
      };
    });
    expect(built).toMatchObject({ tiles: 289, pillars: 20, pillarsInView: 0 });
    // The shadow pass must both append (pillars the main list lacks) and skip main-list tiles the sun does not see.
    expect(built.pillarsInShadow).toBeGreaterThan(0);
    expect(built.tilesInViewOutsideShadow).toBeGreaterThan(0);
    expect(built.tilesInView).toBeGreaterThan(270);

    const naive = await forge.page.evaluate(async () => {
      const frame = await window.__forge.frameAsync({ items: true });
      const main = (frame.items ?? []).filter((i) => i.pass === 'main');
      return {
        passes: frame.passes.map((p) => [p.id, p.submissions]),
        mainTiles: main.filter((i) => i.name.includes('tile-')).length,
        mainOthers: main.filter((i) => !i.name.includes('tile-')).map((i) => i.name),
      };
    });
    await attachNumbers('pillars-naive', { backend: forge.backend, built, naive });
    await skipIfDeviceLost(forge);
    // Three's per-object culling: the casters the sun sees; the tiles in view, the ground and the output quad.
    expect(naive.passes).toEqual([
      ['shadow:sun', built.castersInShadow],
      ['main', naive.mainTiles + naive.mainOthers.length],
    ]);
    expect({ mainTiles: naive.mainTiles, mainOthers: naive.mainOthers }).toEqual({
      mainTiles: built.tilesInView,
      mainOthers: ['ground', 'Output Color Transform'],
    });
    await settle(forge.page, 2);
    const before = forge.pixelChecks ? await forge.page.screenshot({ type: 'png' }) : null;

    const compiled = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const report = f.compile();
      await f.world.warmup(f.renderer, f.camera);
      const frame = await f.frameAsync();
      return {
        after: report.after,
        nestedPasses: report.nestedPasses,
        passes: frame.passes.map((p) => [p.id, p.submissions]),
        unattributed: frame.totals.unattributed,
      };
    });
    await skipIfDeviceLost(forge);
    expect(compiled.nestedPasses).toBe(policyOf(nested));
    expect(compiled.after).toMatchObject({ batches: 1, instanced: 0 });
    // One batch in each pass; the ground and the output quad stay.
    expect(compiled.passes).toEqual([
      ['shadow:sun', 1],
      ['main', 1 + naive.mainOthers.length],
    ]);
    expect(compiled.unattributed).toBe(0);
    await settle(forge.page, 2);
    if (!before) return;
    const after = await forge.page.screenshot({ type: 'png' });
    mkdirSync(OUT, { recursive: true });
    const tag = `${nested}-${forge.backend}`;
    writeFileSync(`${OUT}/pillars-naive-${tag}.png`, before);
    writeFileSync(`${OUT}/pillars-compiled-${tag}.png`, after);
    const diff = pixelDiff(before, after, { threshold: 4, diffPath: `${OUT}/pillars-diff-${tag}.png` });
    await attachNumbers('pillars', {
      backend: forge.backend,
      nestedPasses: compiled.nestedPasses,
      built,
      diffPct: (diff * 100).toFixed(4),
    });
    expect(diff).toBeLessThan(0.0005);
  });

  test(`the shadowed naive scene from (24, 10, 18) compiles at parity (nestedPasses: ${nested})`, async ({ forge }) => {
    test.setTimeout(180_000);
    // transparent=keep: transparent statics stay individual meshes, so their draw order does not enter the comparison.
    await forge.open('naive', { shadows: '1', transparent: 'keep', ...nestedQuery(nested) });
    const naive = await forge.page.evaluate(async () => {
      const f = window.__forge;
      // Casters behind and beside the camera stay inside the sun's shadow frustum but leave the view.
      f.camera.position.set(24, 10, 18);
      f.camera.lookAt(-40, 0, -30);
      f.camera.updateMatrixWorld();
      let instanced = 0;
      f.scene.traverse((o) => {
        if ((o as { isInstancedMesh?: boolean }).isInstancedMesh) instanced++;
      });
      const frame = await f.frameAsync();
      return { instanced, passes: frame.passes.map((p) => [p.id, p.submissions, p.gpuDraws]) };
    });
    await skipIfDeviceLost(forge);
    // The naive scene has no InstancedMesh (compacted instancing), so this task controls every batch in it.
    expect(naive.instanced).toBe(0);
    await settle(forge.page, 2);
    const before = forge.pixelChecks ? await forge.page.screenshot({ type: 'png' }) : null;
    const compiled = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const T = f.three;
      const report = f.compile();
      await f.world.warmup(f.renderer, f.camera);
      await f.frameAsync();
      // Which ids every batch draws in the sun's shadow pass, read once three has issued the draw (onAfterRender,
      // composed with whatever hook the batch has and put back afterwards).
      const shadowCamera = (f.scene.getObjectByName('sun') as InstanceType<typeof T.DirectionalLight>).shadow.camera;
      type Spied = {
        onAfterRender: (...args: unknown[]) => void;
        _multiDrawCount: number;
        _multiDrawCounts: Int32Array;
        _indirectTexture: { image: { data: Uint32Array } };
      };
      const drawnInShadow = new Map<object, Set<number>>();
      const restores: (() => void)[] = [];
      for (const batch of f.world.batchedMeshes) {
        const b = batch as unknown as Spied;
        const hadOwn = Object.hasOwn(b, 'onAfterRender');
        const original = b.onAfterRender;
        b.onAfterRender = function (this: unknown, ...args: unknown[]) {
          if (args[2] === shadowCamera) {
            const ids = new Set<number>();
            for (let i = 0; i < b._multiDrawCount; i++)
              if (b._multiDrawCounts[i]! > 0) ids.add(b._indirectTexture.image.data[i]!);
            drawnInShadow.set(batch, ids);
          }
          original.apply(this, args);
        };
        restores.push(() => {
          if (hadOwn) b.onAfterRender = original;
          else delete (b as Partial<Spied>).onAfterRender;
        });
      }
      const frame = await f.frameAsync();
      for (const restore of restores) restore();
      // Every batched caster whose box meets the shadow camera's frustum must be in its batch's shadow list.
      const frustum = new T.Frustum().setFromProjectionMatrix(
        new T.Matrix4().multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse),
        shadowCamera.coordinateSystem,
        shadowCamera.reversedDepth,
      );
      const missing: string[] = [];
      let needed = 0;
      f.scene.traverse((o) => {
        const mesh = o as InstanceType<typeof T.Mesh>;
        if (!mesh.isMesh || !mesh.castShadow) return;
        const slot = f.world.slotOf(mesh);
        if (!slot || !(slot.batch as { isBatchedMesh?: boolean }).isBatchedMesh) return;
        if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
        if (!frustum.intersectsBox(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld))) return;
        needed++;
        if (!drawnInShadow.get(slot.batch)?.has(slot.instanceId)) missing.push(mesh.name);
      });
      return {
        after: report.after,
        nestedPasses: report.nestedPasses,
        passes: frame.passes.map((p) => [p.id, p.submissions, p.gpuDraws]),
        unattributed: frame.totals.unattributed,
        shadow: { needed, missing: missing.length, sample: missing.slice(0, 5) },
      };
    });
    await skipIfDeviceLost(forge);
    expect(compiled.nestedPasses).toBe(policyOf(nested));
    expect(compiled.after.instanced).toBe(0);
    expect(compiled.unattributed).toBe(0);
    expect(compiled.shadow.needed, 'batched casters inside the shadow frustum').toBeGreaterThan(100);
    expect(compiled.shadow.sample, 'batched casters missing from the shadow pass').toEqual([]);
    await settle(forge.page, 2);
    if (!before) {
      await attachNumbers('reproduction', {
        backend: forge.backend,
        nestedPasses: compiled.nestedPasses,
        after: compiled.after,
        naive: naive.passes,
        passes: compiled.passes,
        shadow: compiled.shadow,
        diffPct: null,
      });
      return;
    }
    const after = await forge.page.screenshot({ type: 'png' });
    mkdirSync(OUT, { recursive: true });
    const tag = `${nested}-${forge.backend}`;
    writeFileSync(`${OUT}/reproduction-naive-${tag}.png`, before);
    writeFileSync(`${OUT}/reproduction-compiled-${tag}.png`, after);
    const diff = pixelDiff(before, after, { threshold: 4, diffPath: `${OUT}/reproduction-diff-${tag}.png` });
    await attachNumbers('reproduction', {
      backend: forge.backend,
      nestedPasses: compiled.nestedPasses,
      after: compiled.after,
      naive: naive.passes,
      passes: compiled.passes,
      shadow: compiled.shadow,
      diffPct: (diff * 100).toFixed(4),
    });
    expect(diff).toBeLessThan(0.001);
  });

  for (const receiver of ['instanced', 'ground'] as const) {
    test(`1,500 boxes self-shadow under sun and spot (${receiver} first, nestedPasses: ${nested})`, async ({
      forge,
    }) => {
      test.setTimeout(180_000);
      await forge.open('empty', nestedQuery(nested));
      const built = await forge.page.evaluate(buildInstancedField, { groundFirst: receiver === 'ground', spot: true });
      expect(built.boxes).toBe(1500);
      expect(built.inView).toBeGreaterThan(100);
      expect(built.sunOutOfView, 'boxes the sun sees outside the view').toBeGreaterThan(50);
      expect(built.spotOutOfView, 'boxes the spot light sees outside the view').toBeGreaterThan(50);
      const naive = await forge.page.evaluate(async () =>
        (await window.__forge.frameAsync()).passes.map((p) => [p.id, p.submissions]),
      );
      await skipIfDeviceLost(forge);
      expect(naive.map(([id]) => id)).toEqual(expect.arrayContaining(['shadow:sun', 'shadow:spot', 'main']));
      await settle(forge.page, 2);
      const before = forge.pixelChecks ? await forge.page.screenshot({ type: 'png' }) : null;
      const report = await forge.page.evaluate(compileInstancedField);
      const compiled = await forge.page.evaluate(spyInstancedField);
      await skipIfDeviceLost(forge);
      expect(report.nestedPasses).toBe(policyOf(nested));
      expect(report.after).toMatchObject({ batches: 0, instanced: 1 });
      expect(compiled.unattributed).toBe(0);
      expect(compiled.needed.sun, 'instances inside the sun frustum').toBeGreaterThan(100);
      expect(compiled.needed.spot, 'instances inside the spot frustum').toBeGreaterThan(100);
      expect(compiled.sample, 'instances missing from the pass that needs them').toEqual({
        main: [],
        sun: [],
        spot: [],
      });
      await settle(forge.page, 2);
      if (!before) {
        await attachNumbers('instanced-field', {
          backend: forge.backend,
          receiver,
          built,
          naive,
          compiled: { ...report, ...compiled },
          diffPct: null,
        });
        return;
      }
      const after = await forge.page.screenshot({ type: 'png' });
      mkdirSync(OUT, { recursive: true });
      const tag = `field-${receiver}-${nested}-${forge.backend}`;
      writeFileSync(`${OUT}/${tag}-naive.png`, before);
      writeFileSync(`${OUT}/${tag}-compiled.png`, after);
      const diff = pixelDiff(before, after, { threshold: 4, diffPath: `${OUT}/${tag}-diff.png` });
      await attachNumbers('instanced-field', {
        backend: forge.backend,
        receiver,
        built,
        naive,
        compiled: { ...report, ...compiled },
        diffPct: (diff * 100).toFixed(4),
      });
      expect(diff).toBeLessThan(0.0005);
    });
  }

  test(`1,500 boxes stay exact when the camera moves after compile (nestedPasses: ${nested})`, async ({ forge }) => {
    test.setTimeout(180_000);
    await forge.open('empty', nestedQuery(nested));
    // The sun only. In three r186 Attributes.update keeps a version per attribute object, and every render object builds its
    // own attributes over the shared instance buffer: a second shadow light's render object would upload the whole buffer
    // again (its ranges already consumed) and hide rows a lost update range left stale on the GPU.
    const built = await forge.page.evaluate(buildInstancedField, { groundFirst: false, spot: false });
    expect(built.boxes).toBe(1500);
    // The naive scene at the second view: the view the compiled scene is compared at.
    await forge.page.evaluate(aimCamera, MOVED_VIEW);
    await forge.page.evaluate(async () => void (await window.__forge.frameAsync()));
    await settle(forge.page, 2);
    const before = forge.pixelChecks ? await forge.page.screenshot({ type: 'png' }) : null;
    // Compile and render at the first view: that frame creates the instance buffers with whole-array uploads. The first
    // frame at the second view then changes the main rows and the appended casters together: the update-range path.
    await forge.page.evaluate(aimCamera, FIELD_VIEW);
    const report = await forge.page.evaluate(compileInstancedField);
    await forge.page.evaluate(aimCamera, MOVED_VIEW);
    const moved = await forge.page.evaluate(spyInstancedField);
    await skipIfDeviceLost(forge);
    expect(report.nestedPasses).toBe(policyOf(nested));
    expect(report.after).toMatchObject({ batches: 0, instanced: 1 });
    expect(moved.unattributed).toBe(0);
    expect(moved.needed.main, 'instances in the moved view').toBeGreaterThan(100);
    expect(moved.needed.sun, 'instances inside the sun frustum').toBeGreaterThan(100);
    expect(moved.sample, 'instances missing from the pass that needs them').toEqual({ main: [], sun: [] });
    await settle(forge.page, 2);
    if (!before) {
      await attachNumbers('instanced-field-moved', {
        backend: forge.backend,
        built,
        compiled: { ...report, ...moved },
        diffPct: null,
      });
      return;
    }
    const after = await forge.page.screenshot({ type: 'png' });
    mkdirSync(OUT, { recursive: true });
    const tag = `field-moved-${nested}-${forge.backend}`;
    writeFileSync(`${OUT}/${tag}-naive.png`, before);
    writeFileSync(`${OUT}/${tag}-compiled.png`, after);
    const diff = pixelDiff(before, after, { threshold: 4, diffPath: `${OUT}/${tag}-diff.png` });
    await attachNumbers('instanced-field-moved', {
      backend: forge.backend,
      built,
      compiled: { ...report, ...moved },
      diffPct: (diff * 100).toFixed(4),
    });
    expect(diff).toBeLessThan(0.0005);
  });
}

/** Where the instanced field is first seen from, and a second view to move to: [position, target]. */
const FIELD_VIEW = [0, 16, 40, 0, 0, 0];
const MOVED_VIEW = [-36, 14, 34, -50, 0, -4];

/** In the page: points the harness camera from `view[0..2]` at `view[3..5]`. */
function aimCamera(view: number[]): void {
  const camera = window.__forge.camera;
  camera.position.set(view[0]!, view[1]!, view[2]!);
  camera.lookAt(view[3]!, view[4]!, view[5]!);
  camera.updateMatrixWorld();
}

/** In the page: compiles, warms up and renders one frame; returns the compile report's numbers. */
async function compileInstancedField() {
  const f = window.__forge;
  const report = f.compile();
  await f.world.warmup(f.renderer, f.camera);
  await f.frameAsync();
  return { after: report.after, nestedPasses: report.nestedPasses };
}

/**
 * In the page: renders one frame recording the ids each instanced mesh draws in the main, sun and spot passes (read once
 * three has issued the draw: onAfterRender, composed with whatever hook the mesh has and put back afterwards, the rows
 * [0, count) of its compaction table), and counts the instances each pass needs (box meets its frustum) but did not draw.
 */
async function spyInstancedField() {
  const f = window.__forge;
  const T = f.three;
  type Key = 'main' | 'sun' | 'spot';
  const cameras: Partial<Record<Key, InstanceType<typeof T.Camera>>> = { main: f.camera };
  for (const name of ['sun', 'spot'] as const) {
    const light = f.scene.getObjectByName(name) as InstanceType<typeof T.DirectionalLight> | undefined;
    if (light) cameras[name] = light.shadow.camera;
  }
  const keys = Object.keys(cameras) as Key[];
  type Spied = { onAfterRender: (...args: unknown[]) => void; count: number; visibleIds: number[] };
  const drawn: Record<Key, Set<number>> = { main: new Set<number>(), sun: new Set<number>(), spot: new Set<number>() };
  const restores: (() => void)[] = [];
  for (const mesh of f.world.instancedMeshes) {
    const m = mesh as unknown as Spied;
    const hadOwn = Object.hasOwn(m, 'onAfterRender');
    const original = m.onAfterRender;
    m.onAfterRender = function (this: unknown, ...args: unknown[]) {
      for (const key of keys)
        if (args[2] === cameras[key]) for (let k = 0; k < m.count; k++) drawn[key].add(m.visibleIds[k]!);
      original.apply(this, args);
    };
    restores.push(() => {
      if (hadOwn) m.onAfterRender = original;
      else delete (m as Partial<Spied>).onAfterRender;
    });
  }
  const frame = await f.frameAsync();
  for (const restore of restores) restore();
  const frusta = Object.fromEntries(
    keys.map((key) => {
      const c = cameras[key]!;
      return [
        key,
        new T.Frustum().setFromProjectionMatrix(
          new T.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse),
          c.coordinateSystem,
          c.reversedDepth,
        ),
      ];
    }),
  ) as Record<Key, InstanceType<typeof T.Frustum>>;
  const needed: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
  const missing: Record<string, string[]> = Object.fromEntries(keys.map((key) => [key, [] as string[]]));
  f.scene.traverse((o) => {
    const mesh = o as InstanceType<typeof T.Mesh>;
    if (!mesh.isMesh || !mesh.name.startsWith('box-')) return;
    const slot = f.world.slotOf(mesh);
    if (!slot || !(slot.batch as { isInstancedMesh?: boolean }).isInstancedMesh) return;
    if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
    const bounds = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    for (const key of keys) {
      if (!frusta[key].intersectsBox(bounds)) continue;
      needed[key]!++;
      if (!drawn[key].has(slot.instanceId)) missing[key]!.push(mesh.name);
    }
  });
  return {
    passes: frame.passes.map((p) => [p.id, p.submissions, p.gpuDraws]),
    unattributed: frame.totals.unattributed,
    needed,
    missing: Object.fromEntries(keys.map((key) => [key, missing[key]!.length])),
    sample: Object.fromEntries(keys.map((key) => [key, missing[key]!.slice(0, 5)])),
  };
}

/**
 * In the page: 1,500 tall boxes (one geometry and one material: a single InstancedMesh at instanceThreshold 64, whose
 * 1,500 x 64 bytes of matrices exceed the 65,536-byte uniform buffer, so three uploads them to one vertex buffer shared by
 * every pass), a narrow sun and (with `spot`) a narrow spot light with casters outside the view, and a lit ground whose renderOrder
 * decides whether the boxes or the ground receive shadows first. Returns counts from three's own frusta.
 */
async function buildInstancedField({ groundFirst, spot: withSpot }: { groundFirst: boolean; spot: boolean }) {
  const f = window.__forge;
  const T = f.three;
  const { scene, camera, renderer } = f;
  renderer.shadowMap.enabled = true;
  scene.add(new T.AmbientLight(0xffffff, 0.3));
  // A low sun from +x: a 6-unit box throws an 18-unit shadow toward -x, so boxes right of the view shadow it. Narrow
  // across z (|z| <= 12), so its list misses boxes in view and a pass that draws it in the main pass shows.
  const sun = new T.DirectionalLight(0xffffff, 2);
  sun.name = 'sun';
  sun.position.set(150, 50, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -12,
    right: 12,
    top: 40,
    bottom: -40,
    near: 1,
    far: 400,
  }).updateProjectionMatrix();
  // A narrow spot light low on the left: boxes left of the view shadow it toward +x.
  const spot = new T.SpotLight(0xffe8d0, 4000, 0, Math.PI / 12, 0.2, 2);
  spot.name = 'spot';
  spot.position.set(-90, 22, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.camera.near = 1;
  spot.shadow.camera.far = 300;
  scene.add(sun, sun.target);
  if (withSpot) scene.add(spot, spot.target);
  // A lit ground that receives and does not cast. Its renderOrder decides which receiver three draws first, and so
  // which draw renders the shadow maps: the boxes (just culled for the main camera) or the ground (before that cull).
  const ground = new T.Mesh(
    new T.PlaneGeometry(400, 400),
    new T.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 1 }),
  );
  ground.name = 'ground';
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.renderOrder = groundFirst ? -1 : 1;
  ground.userData.forge = 'static';
  scene.add(ground);
  // One geometry and one material: a single InstancedMesh (instanceThreshold 64) whose 1,500 x 64 bytes of matrices
  // exceed the 65,536-byte uniform buffer, so three uploads them to one vertex buffer shared by every pass.
  const geometry = new T.BoxGeometry(1.2, 6, 1.2);
  const material = new T.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.85, metalness: 0 });
  const boxes: InstanceType<typeof T.Mesh>[] = [];
  for (let i = 0; i < 50; i++) {
    for (let j = 0; j < 30; j++) {
      const b = new T.Mesh(geometry, material);
      b.name = `box-${boxes.length}`;
      b.position.set(-98 + 4 * i, 3, -29 + 2 * j);
      b.castShadow = b.receiveShadow = true;
      b.userData.forge = 'static';
      boxes.push(b);
      scene.add(b);
    }
  }
  camera.position.set(0, 16, 40);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  scene.updateMatrixWorld(true);
  await f.frameAsync(); // places the shadow cameras and gives them this backend's coordinate system
  const frustumOf = (c: typeof camera | typeof sun.shadow.camera | typeof spot.shadow.camera) =>
    new T.Frustum().setFromProjectionMatrix(
      new T.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse),
      c.coordinateSystem,
      c.reversedDepth,
    );
  const view = frustumOf(camera);
  const sunView = frustumOf(sun.shadow.camera);
  const spotView = frustumOf(spot.shadow.camera);
  return {
    boxes: boxes.length,
    inView: boxes.filter((b) => view.intersectsObject(b)).length,
    sunOutOfView: boxes.filter((b) => sunView.intersectsObject(b) && !view.intersectsObject(b)).length,
    spotOutOfView: withSpot ? boxes.filter((b) => spotView.intersectsObject(b) && !view.intersectsObject(b)).length : 0,
  };
}
