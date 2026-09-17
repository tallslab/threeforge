/**
 * BatchedMesh in nested render passes (shadow maps, reflections): every pass draws each id its frustum needs, once,
 * and nothing else, and the enclosing pass's index rows survive the nested render. Rig and reference in
 * `helpers/nestedPassRig.ts`.
 */

import {
  ArrayCamera,
  BatchedMesh,
  Box3,
  type Camera,
  Color,
  type DirectionalLight,
  type Frustum,
  FrustumArray,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Scene,
  Vector3,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
} from 'three';
import { describe, expect, it } from 'vitest';
import { attachBvhCulling, FORGE_HOOK, type NestedPassPolicy } from '../../src/compiler/culling.js';
import { World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';
import { type FakePass, FakeRenderer } from './helpers/fakeRenderer.js';
import {
  backends,
  box,
  cameraAt,
  drawnIds,
  expectExact,
  expectPassesExact,
  frustumOf,
  insertBefore,
  internals,
  listedIds,
  mainCamera,
  mirrorMesh,
  nameOf,
  passLabels,
  pointLight,
  policies,
  type Rig,
  reference,
  rig,
  setFrame,
  sunLight,
} from './helpers/nestedPassRig.js';

const _box = new Box3();
const _m = new Matrix4();

// ---- the matrix -----------------------------------------------------------------------------------------------------

describe.each(backends)('BatchedMesh in a shadow pass nested in the main pass (webgpu: $webgpu)', ({ webgpu }) => {
  describe.each(policies)("nestedPasses: '%s'", (nested) => {
    const resolved: NestedPassPolicy = nested === 'auto' ? 'per-pass' : nested;

    it('draws in every pass each id its frustum needs, once, and nothing else, on two consecutive frames', () => {
      const r = rig({ webgpu, nested });
      expect(r.report.nestedPasses).toBe(resolved);
      expect(r.report.after).toMatchObject({ batches: 2, instanced: 0 });
      expect(r.scene.children.indexOf(r.unlit), 'the unlit batch is first in traversal').toBeLessThan(
        r.scene.children.indexOf(r.lit),
      );
      for (let frame = 1; frame <= 2; frame++) {
        r.renderer.render(r.scene, r.main);
        expect(passLabels(r.renderer)).toEqual(['render:0', 'shadow:1']);
        expectPassesExact(r, `frame ${frame}`);
      }
      // The scene exercises both halves of a nested pass: main-list ids the sun does not see, sun ids the main list lacks.
      const [main, shadow] = r.renderer.passes as [FakePass, FakePass];
      const mainMust = new Set(reference(r, r.lit, frustumOf(main, r.cs)).must);
      const shadowMust = new Set(reference(r, r.lit, frustumOf(shadow, r.cs)).must);
      expect([...shadowMust].filter((id) => !mainMust.has(id)).length).toBeGreaterThan(20);
      expect([...mainMust].filter((id) => !shadowMust.has(id)).length).toBeGreaterThan(5);
    });

    it("leaves each batch's arrays holding its main list once the shadow pass is over", () => {
      const r = rig({ webgpu, nested });
      r.renderer.render(r.scene, r.main);
      const frustum = frustumOf(r.renderer.passes[0]!, r.cs);
      for (const batch of [r.unlit, r.lit]) {
        const b = internals(batch);
        const label = `${nameOf(r, batch)} batch after the frame`;
        expect(listedIds(batch).length, `${label}: no slot of the list is zeroed`).toBe(b._multiDrawCount);
        expectExact(label, listedIds(batch), reference(r, batch, frustum));
      }
    });

    it('serves two shadow lights in a row, each from the main list', () => {
      const r = rig({ webgpu, nested, suns: (cs) => [sunLight('east', 50, cs), sunLight('west', -50, cs)] });
      for (let frame = 1; frame <= 2; frame++) {
        r.renderer.render(r.scene, r.main);
        expect(passLabels(r.renderer)).toEqual(['render:0', 'shadow:1', 'shadow:1']);
        expectPassesExact(r, `frame ${frame}`);
      }
    });

    it("serves a point light's six faces, each drawing exactly what its face needs, and restores the counts after every face", () => {
      const r = rig({ webgpu, nested, suns: (cs) => [pointLight('bulb', 50, cs)] });
      const faceCamera = r.suns[0]!.shadow.camera;
      const afterFace: number[][][] = [];
      // Runs after the tracker's marked hook, which puts the counts back when a face's render ends.
      r.scene.onAfterRender = ((previous) =>
        function (this: Scene, ...args: Parameters<Scene['onAfterRender']>) {
          previous.apply(this, args);
          if (args[2] === faceCamera) afterFace.push([r.unlit, r.lit].map(listedIds));
        })(r.scene.onAfterRender);
      for (let frame = 1; frame <= 2; frame++) {
        afterFace.length = 0;
        r.renderer.render(r.scene, r.main);
        expect(passLabels(r.renderer)).toEqual(['render:0', ...Array<string>(6).fill('shadow:1')]);
        expect(r.renderer.passes.map((p) => p.face)).toEqual([null, 0, 1, 2, 3, 4, 5]);
        expectPassesExact(r, `frame ${frame}`);
        const mainLists = [r.unlit, r.lit].map(listedIds);
        expect(afterFace, 'the main lists after each face').toEqual(Array.from({ length: 6 }, () => mainLists));
      }
      // The faces need ids the main list lacks, and the main list holds ids no face needs.
      const mainMust = new Set(reference(r, r.lit, frustumOf(r.renderer.passes[0]!, r.cs)).must);
      const faceMust = new Set(r.renderer.passes.slice(1).flatMap((p) => reference(r, r.lit, frustumOf(p, r.cs)).must));
      expect([...faceMust].filter((id) => !mainMust.has(id)).length).toBeGreaterThan(10);
      expect([...mainMust].filter((id) => !faceMust.has(id)).length).toBeGreaterThan(5);
    });

    it('nests three deep: a reflection drawn between the batches renders its own shadow map', () => {
      const r = rig({ webgpu, nested });
      // Traversal: unlit batch (drawn in main before the reflection), the mirror, then the lit batch (first receiver).
      insertBefore(r.scene, mirrorMesh(r.scene, cameraAt(-60, r.cs)), r.lit);
      for (let frame = 1; frame <= 2; frame++) {
        r.renderer.render(r.scene, r.main);
        expect(passLabels(r.renderer)).toEqual(['render:0', 'render:1', 'shadow:2', 'shadow:1']);
        expectPassesExact(r, `frame ${frame}`);
      }
    });

    it('draws exact lists when a reflection reaches both batches before the main pass does', () => {
      const r = rig({ webgpu, nested });
      const mirror = mirrorMesh(r.scene, cameraAt(-60, r.cs));
      insertBefore(r.scene, mirror, null);
      r.renderer.render(r.scene, r.main);
      expectPassesExact(r, 'frame 1');
      const mainRows = [r.unlit, r.lit].map((b) =>
        Array.from(internals(b)._indirectTexture.image.data.subarray(0, internals(b)._multiDrawCount)),
      );
      // The rows as they stand once the reflection is over, before the main pass reaches the batches.
      let rowsAfterReflection: number[][] = [];
      mirror.onAfterRender = () => {
        rowsAfterReflection = [r.unlit, r.lit].map((b, i) =>
          Array.from(internals(b)._indirectTexture.image.data.subarray(0, mainRows[i]!.length)),
        );
      };
      r.renderer.render(r.scene, r.main);
      expect(passLabels(r.renderer)).toEqual(['render:0', 'render:1', 'shadow:2', 'shadow:1']);
      expectPassesExact(r, 'frame 2');
      // 'reuse-main' only ever appends to the last main list, so the rows change once per frame (in the main pass).
      if (resolved === 'reuse-main')
        expect(rowsAfterReflection, 'the reflection kept the previous main rows').toEqual(mainRows);
    });

    it('keeps the prefix order of a sorted transparent batch and sorts the appended ids for the nested camera', () => {
      const r = rig({ webgpu, nested, litMaterial: new MeshStandardMaterial({ transparent: true, opacity: 0.5 }) });
      r.renderer.render(r.scene, r.main);
      const [main, shadow] = r.renderer.passes as [FakePass, FakePass];
      expectPassesExact(r, 'transparent');
      const mainIds = drawnIds(main, r.lit, 'main');
      const shadowIds = drawnIds(shadow, r.lit, 'shadow');
      const inMain = new Set(mainIds);
      const split = shadowIds.findIndex((id) => !inMain.has(id));
      expect(split, 'the shadow pass appends ids the main list lacks').toBeGreaterThan(0);
      const kept = shadowIds.slice(0, split);
      const appended = shadowIds.slice(split);
      expect(
        appended.filter((id) => inMain.has(id)),
        'appended ids are not in the main list',
      ).toEqual([]);
      const keptSet = new Set(kept);
      expect(kept, 'kept ids stay in the main order').toEqual(mainIds.filter((id) => keptSet.has(id)));
      // Back to front for the shadow camera: its view-space z must not increase along the appended ids.
      const depth = (id: number): number => {
        const mesh = r.originals.get(r.lit)!.find((m) => r.world.slotOf(m)!.instanceId === id)!;
        return -new Vector3().setFromMatrixPosition(mesh.matrixWorld).applyMatrix4(shadow.matrixWorldInverse).z;
      };
      expect(appended.length).toBeGreaterThan(5);
      for (let i = 1; i < appended.length; i++)
        expect(depth(appended[i]!), `appended[${i}]`).toBeLessThanOrEqual(depth(appended[i - 1]!) + 1e-6);
    });

    it('uploads the index texture again only when a nested pass appends rows the texture does not hold yet', () => {
      const version = (b: BatchedMesh): number => internals(b)._indirectTexture.version;
      // A sun inside the main view: the shadow pass needs nothing the main list lacks.
      const inside = rig({ webgpu, nested, suns: (cs) => [sunLight('sun', 0, cs, 8)] });
      const v0 = [inside.unlit, inside.lit].map(version);
      inside.renderer.render(inside.scene, inside.main);
      expect(
        [inside.unlit, inside.lit].map((b, i) => version(b) - v0[i]!),
        'the main cull only',
      ).toEqual([1, 1]);
      expectPassesExact(inside, 'sun inside the view');

      const outside = rig({ webgpu, nested });
      const deltas = (render: () => void): number[] => {
        const before = [outside.unlit, outside.lit].map(version);
        render();
        return [outside.unlit, outside.lit].map((b, i) => version(b) - before[i]!);
      };
      const frame = (): void => outside.renderer.render(outside.scene, outside.main);
      expect(
        deltas(frame),
        'frame 1: the main cull and one append (the shadow pass culls twice, the rows change once)',
      ).toEqual([2, 2]);
      expect(deltas(frame), 'frame 2: the appended rows are already in the texture').toEqual([1, 1]);
      for (const light of outside.suns as DirectionalLight[]) {
        light.position.x = -50; // the sun moves to the other side: a different appended set
        light.target.position.x = -50;
        // compile() froze the static lights (matrixAutoUpdate = false), as it does every all-static object.
        light.updateMatrix();
        light.target.updateMatrix();
      }
      outside.scene.updateMatrixWorld(true);
      expect(deltas(frame), 'frame 3: a changed appended set uploads again').toEqual([2, 2]);
      expectPassesExact(outside, 'frame 3');
    });

    it('draws every instance in both passes with perObjectFrustumCulled off, and uploads nothing once nothing changes', () => {
      const r = rig({ webgpu, nested });
      r.unlit.perObjectFrustumCulled = false;
      r.renderer.render(r.scene, r.main);
      const v0 = internals(r.unlit)._indirectTexture.version;
      r.renderer.render(r.scene, r.main);
      const all = Array.from({ length: 101 }, (_, i) => i);
      for (const pass of r.renderer.passes)
        expect([...drawnIds(pass, r.unlit, pass.kind)].sort((a, b) => a - b)).toEqual(all);
      // An opaque batch does not sort (batchStatics), so three's own hook skips an unchanged list; the nested pass appends nothing.
      expect(internals(r.unlit)._indirectTexture.version - v0, 'no upload on the second frame').toBe(0);
    });

    it("tests a reversed-depth nested camera with three's reversed-depth frustum", () => {
      const r = rig({ webgpu, nested });
      const sc = r.suns[0]!.shadow.camera as unknown as { _reversedDepth: boolean; updateProjectionMatrix(): void };
      sc._reversedDepth = true; // what Renderer.render does under `reversedDepthBuffer`
      sc.updateProjectionMatrix();
      r.renderer.render(r.scene, r.main);
      expectPassesExact(r, 'reversed depth', (pass) => frustumOf(pass, r.cs, pass.kind === 'shadow'));
    });

    it('serves a nested ArrayCamera pass from the union of its sub-frusta', () => {
      const r = rig({ webgpu, nested });
      const array = new ArrayCamera([cameraAt(-60, r.cs), cameraAt(60, r.cs)]);
      r.scene.add(mirrorMesh(r.scene, array));
      r.renderer.render(r.scene, r.main);
      // The lit batch receives shadows in the array pass too, so that pass renders the sun's map again.
      expect(passLabels(r.renderer)).toEqual(['render:0', 'shadow:1', 'render:1', 'shadow:2']);
      const union = new FrustumArray().setFromArrayCamera(array);
      expectPassesExact(r, 'array camera', (pass) => (pass.camera === array ? union : frustumOf(pass, r.cs)));
    });

    it('recovers when a nested render throws: the next animation frame draws exact lists again', () => {
      const r = rig({ webgpu, nested });
      // An untagged caster after both batches: the shadow pass has appended to both when it throws.
      const thrower = new Mesh(box, new MeshBasicMaterial());
      thrower.name = 'thrower';
      thrower.castShadow = true;
      thrower.position.set(50, 0.5, 0);
      thrower.updateMatrixWorld();
      let armed = true;
      thrower.onBeforeRender = (_renderer, _scene, camera) => {
        if (armed && camera === r.suns[0]!.shadow.camera) throw new Error('shadow pass failed');
      };
      r.scene.add(thrower);
      setFrame(r.renderer, 1);
      expect(() => r.renderer.render(r.scene, r.main)).toThrow('shadow pass failed');
      armed = false;
      // The failed render left three's (and the fake's) call stack open and the shadow material on the scene
      // (ShadowNode.updateShadow restores the scene state only when the map render returns). The app puts three's
      // state back and carries on with the next tick; threeforge's own state must recover by itself.
      r.scene.overrideMaterial = null;
      const next = new FakeRenderer({
        webgpu,
        sceneHooks: true,
        shadowTrigger: 'first-receiver',
        record: true,
        shadowLights: r.suns,
      });
      setFrame(next, 2);
      const again: Rig = { ...r, renderer: next };
      for (let frame = 2; frame <= 3; frame++) {
        setFrame(next, frame);
        next.render(r.scene, r.main);
        expect(passLabels(next)).toEqual(['render:0', 'shadow:1']);
        expectPassesExact(again, `frame ${frame} after the throw`);
      }
      const frustum = frustumOf(next.passes[0]!, r.cs);
      for (const batch of [r.unlit, r.lit]) {
        expect(listedIds(batch).length, `${nameOf(r, batch)}: no slot left zeroed`).toBe(
          internals(batch)._multiDrawCount,
        );
        expectExact(`${nameOf(r, batch)} arrays`, listedIds(batch), reference(r, batch, frustum));
      }
    });
  });
});

// ---- without a pass tracker -----------------------------------------------------------------------------------------

describe('attachBvhCulling without a pass tracker', () => {
  it('culls for every camera: each call is an outermost pass', () => {
    const batch = new BatchedMesh(101, box.attributes.position!.count, box.index!.count, new MeshStandardMaterial());
    const g = batch.addGeometry(box);
    for (let i = 0; i < 101; i++) batch.setMatrixAt(batch.addInstance(g), _m.makeTranslation(-100 + 2 * i, 0.5, 3));
    batch.computeBoundingSphere();
    batch.updateMatrixWorld();
    attachBvhCulling(batch, WebGLCoordinateSystem, { nestedPasses: 'reuse-main' });
    const main = mainCamera(WebGLCoordinateSystem);
    const sun = sunLight('sun', 50, WebGLCoordinateSystem);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);
    const cull = (camera: Camera): void =>
      batch.onBeforeRender(
        { coordinateSystem: WebGLCoordinateSystem } as never,
        new Scene(),
        camera,
        batch.geometry,
        batch.material as never,
        null as never,
      );
    const idsIn = (frustum: Frustum): Set<number> => {
      const ids = new Set<number>();
      for (let i = 0; i < 101; i++) {
        batch.getMatrixAt(i, _m);
        if (frustum.intersectsBox(_box.copy(box.boundingBox!).applyMatrix4(_m))) ids.add(i);
      }
      return ids;
    };
    cull(main);
    expect(new Set(listedIds(batch))).toEqual(idsIn(frustumOf(main, WebGLCoordinateSystem)));
    cull(sun.shadow.camera);
    expect(new Set(listedIds(batch))).toEqual(idsIn(frustumOf(sun.shadow.camera, WebGLCoordinateSystem)));
  });
});

// ---- World options --------------------------------------------------------------------------------------------------

describe('World nestedPasses option', () => {
  it("resolves 'auto' to 'per-pass' on both backends, and tracks the main camera through the scene hooks", () => {
    const scene = new Scene();
    for (let i = 0; i < 4; i++)
      scene.add(tag.static(new Mesh(box, new MeshStandardMaterial({ color: new Color(i * 0x111111) }))));
    const a = new World(scene);
    expect(a.compile({ coordinateSystem: WebGPUCoordinateSystem }).nestedPasses).toBe('per-pass');
    a.decompile();
    const b = new World(scene);
    expect(b.compile({ coordinateSystem: WebGLCoordinateSystem }).nestedPasses).toBe('per-pass');
    b.decompile();
    const main = mainCamera(WebGLCoordinateSystem);
    const w = new World(scene, { nestedPasses: 'reuse-main' });
    w.compile();
    expect(w.mainCamera).toBeNull();
    let seen: Camera | null = null;
    const mirror = mirrorMesh(scene, cameraAt(40, WebGLCoordinateSystem));
    mirror.onAfterRender = () => {
      seen = w.mainCamera;
    };
    scene.add(mirror);
    new FakeRenderer({ sceneHooks: true }).render(scene, main);
    expect(seen, 'the main camera while the nested render is over').toBe(main);
    expect(w.mainCamera).toBe(main);
    w.decompile();
    expect(Object.hasOwn(scene, 'onBeforeRender')).toBe(false);
  });

  it.each(['per-pass', 'reuse-main'] as const)(
    "installs marked scene hooks under '%s' and removes them on decompile",
    (nestedPasses) => {
      const scene = new Scene();
      for (let i = 0; i < 4; i++)
        scene.add(tag.static(new Mesh(box, new MeshStandardMaterial({ color: new Color(i * 0x111111) }))));
      const w = new World(scene, { nestedPasses });
      w.compile();
      for (const name of ['onBeforeRender', 'onAfterRender'] as const) {
        expect(Object.hasOwn(scene, name), name).toBe(true);
        expect((scene[name] as unknown as Record<symbol, unknown>)[FORGE_HOOK], name).toBe(true);
      }
      w.decompile();
      expect(Object.hasOwn(scene, 'onBeforeRender')).toBe(false);
      expect(Object.hasOwn(scene, 'onAfterRender')).toBe(false);
    },
  );
});
