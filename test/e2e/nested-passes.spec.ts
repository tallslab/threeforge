/**
 * Shadow passes on compiled batches: casters outside the main view must still shadow what is in view.
 *
 * three renders a directional light's shadow map from inside the first `receiveShadow` object's draw, nested in the
 * main pass. A batch's shadow draw must therefore add the casters the shadow camera sees without rewriting the index
 * rows the main pass already recorded (WebGPU submits the main pass only when it ends; on WebGL the receiving batch
 * draws right after the shadow render returns). Both scenes compare the naive scene (one mesh per prop, three's own
 * per-object culling) with the compiled one, under the backend's default policy and under explicit 'per-pass'.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from './fixtures.js';
import { pixelDiff, settle } from './pixels.js';

const OUT = 'test-results/nested-passes';

/** 'auto' is 'reuse-main' on WebGPU and 'per-pass' on WebGL2, so explicit 'per-pass' only adds a case on WebGPU. */
const POLICIES = ['auto', 'per-pass'] as const;

for (const nested of POLICIES) {
  test(`tall casters out of view shadow a receiving batch through a narrow sun frustum (nestedPasses: ${nested})`, async ({ forge }) => {
    test.skip(!forge.pixelChecks, 'pixel checks need a native WebGPU adapter');
    test.skip(nested === 'per-pass' && forge.backend === 'webgl2', "'per-pass' is the WebGL2 default, covered by 'auto'");
    // threshold=1000 keeps the 289 repeated tiles in the BatchedMesh (the default 64 would make them an InstancedMesh, Task 17).
    await forge.open('empty', { threshold: '1000', ...(nested === 'per-pass' ? { nested } : {}) });
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
        new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse), c.coordinateSystem, c.reversedDepth);
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
    console.log(JSON.stringify({ test: 'pillars-naive', backend: forge.backend, built, naive }));
    // Three's per-object culling: the casters the sun sees; the tiles in view, the ground and the output quad.
    expect(naive.passes).toEqual([
      ['shadow:sun', built.castersInShadow],
      ['main', naive.mainTiles + naive.mainOthers.length],
    ]);
    expect({ mainTiles: naive.mainTiles, mainOthers: naive.mainOthers }).toEqual({ mainTiles: built.tilesInView, mainOthers: ['ground', 'Output Color Transform'] });
    await settle(forge.page, 2);
    const before = await forge.page.screenshot({ type: 'png' });

    const compiled = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const report = f.compile();
      await f.world.warmup(f.renderer, f.camera);
      const frame = await f.frameAsync();
      return { after: report.after, nestedPasses: report.nestedPasses, passes: frame.passes.map((p) => [p.id, p.submissions]), unattributed: frame.totals.unattributed };
    });
    expect(compiled.nestedPasses).toBe(nested === 'per-pass' || forge.backend === 'webgl2' ? 'per-pass' : 'reuse-main');
    expect(compiled.after).toMatchObject({ batches: 1, instanced: 0 });
    // One batch in each pass; the ground and the output quad stay.
    expect(compiled.passes).toEqual([
      ['shadow:sun', 1],
      ['main', 1 + naive.mainOthers.length],
    ]);
    expect(compiled.unattributed).toBe(0);
    await settle(forge.page, 2);
    const after = await forge.page.screenshot({ type: 'png' });
    mkdirSync(OUT, { recursive: true });
    const tag = `${nested}-${forge.backend}`;
    writeFileSync(`${OUT}/pillars-naive-${tag}.png`, before);
    writeFileSync(`${OUT}/pillars-compiled-${tag}.png`, after);
    const diff = pixelDiff(before, after, { threshold: 4, diffPath: `${OUT}/pillars-diff-${tag}.png` });
    console.log(JSON.stringify({ test: 'pillars', backend: forge.backend, nestedPasses: compiled.nestedPasses, built, diffPct: (diff * 100).toFixed(4) }));
    expect(diff).toBeLessThan(0.0005);
  });

  test(`audit reproduction: the shadowed naive scene seen from (24, 10, 18) compiles with the same pixels (nestedPasses: ${nested})`, async ({ forge }) => {
    test.skip(!forge.pixelChecks, 'pixel checks need a native WebGPU adapter');
    test.skip(nested === 'per-pass' && forge.backend === 'webgl2', "'per-pass' is the WebGL2 default, covered by 'auto'");
    test.setTimeout(180_000);
    // transparent=keep: transparent statics stay individual meshes, so their draw order does not enter the comparison.
    await forge.open('naive', { shadows: '1', transparent: 'keep', ...(nested === 'per-pass' ? { nested } : {}) });
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
    // The naive scene has no InstancedMesh (Task 17's compacted instancing), so this task controls every batch in it.
    expect(naive.instanced).toBe(0);
    await settle(forge.page, 2);
    const before = await forge.page.screenshot({ type: 'png' });
    const compiled = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const T = f.three;
      const report = f.compile();
      await f.world.warmup(f.renderer, f.camera);
      await f.frameAsync();
      // Which ids every batch draws in the sun's shadow pass, read once three has issued the draw (onAfterRender,
      // composed with whatever hook the batch has and put back afterwards).
      const shadowCamera = (f.scene.getObjectByName('sun') as InstanceType<typeof T.DirectionalLight>).shadow.camera;
      type Spied = { onAfterRender: (...args: unknown[]) => void; _multiDrawCount: number; _multiDrawCounts: Int32Array; _indirectTexture: { image: { data: Uint32Array } } };
      const drawnInShadow = new Map<object, Set<number>>();
      const restores: (() => void)[] = [];
      for (const batch of f.world.batchedMeshes) {
        const b = batch as unknown as Spied;
        const hadOwn = Object.prototype.hasOwnProperty.call(b, 'onAfterRender');
        const original = b.onAfterRender;
        b.onAfterRender = function (this: unknown, ...args: unknown[]) {
          if (args[2] === shadowCamera) {
            const ids = new Set<number>();
            for (let i = 0; i < b._multiDrawCount; i++) if (b._multiDrawCounts[i]! > 0) ids.add(b._indirectTexture.image.data[i]!);
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
    await settle(forge.page, 2);
    const after = await forge.page.screenshot({ type: 'png' });
    mkdirSync(OUT, { recursive: true });
    const tag = `${nested}-${forge.backend}`;
    writeFileSync(`${OUT}/audit-naive-${tag}.png`, before);
    writeFileSync(`${OUT}/audit-compiled-${tag}.png`, after);
    const diff = pixelDiff(before, after, { threshold: 4, diffPath: `${OUT}/audit-diff-${tag}.png` });
    console.log(JSON.stringify({ test: 'audit', backend: forge.backend, nestedPasses: compiled.nestedPasses, after: compiled.after, naive: naive.passes, passes: compiled.passes, shadow: compiled.shadow, diffPct: (diff * 100).toFixed(4) }));
    expect(compiled.after.instanced).toBe(0);
    expect(compiled.unattributed).toBe(0);
    expect(compiled.shadow.needed, 'batched casters inside the shadow frustum').toBeGreaterThan(100);
    expect(compiled.shadow.sample, 'batched casters missing from the shadow pass').toEqual([]);
    expect(diff).toBeLessThan(0.001);
  });
}
