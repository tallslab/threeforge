/**
 * Nested render passes (shadow maps, reflections, portals) on compiled batches.
 *
 * three r186 renders a shadow map from inside the first `receiveShadow` object's draw (`AnalyticLightNode.setup` ->
 * `ShadowNode.updateBefore`, called from `Renderer._renderObjectDirect` after `object.onBeforeRender`). Every material
 * of a `BatchedMesh` reads the same `_indirectTexture` (`nodes/accessors/Batch.js`). On WebGPU a texture upload lands
 * at once while the enclosing pass is submitted only in `finishRender`; on WebGL the receiving batch draws right after
 * the nested render returns. So a nested pass must not rewrite the index rows the enclosing pass already recorded.
 *
 * The FakeRenderer models exactly that timing (`webgpu`, `sceneHooks`, `shadowTrigger: 'first-receiver'`,
 * `record`). Every test here compiles plain meshes with `World` and checks the ids each pass actually draws against a
 * reference computed from the original meshes: every id whose box meets the pass's frustum is drawn, no id twice, and
 * nothing whose bounding sphere misses the frustum (so any id beyond the box reference lies outside the frustum).
 */

import {
  ArrayCamera,
  BatchedMesh,
  Box3,
  BoxGeometry,
  type Camera,
  Color,
  type CoordinateSystem,
  DirectionalLight,
  Frustum,
  FrustumArray,
  type InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Scene,
  Sphere,
  Vector3,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
} from 'three';
import { describe, expect, it } from 'vitest';
import { attachBvhCulling, FORGE_HOOK, type NestedPassPolicy } from '../../src/compiler/culling.js';
import { createCulledInstancedMesh } from '../../src/compiler/instancing.js';
import { PassTracker } from '../../src/compiler/passTracker.js';
import { World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';
import { mulberry32 } from '../scenes/naive.js';
import { type FakePass, FakeRenderer } from './helpers/fakeRenderer.js';

const box = new BoxGeometry(1, 1, 1);
box.computeBoundingBox();
box.computeBoundingSphere();

type BatchInternals = BatchedMesh & {
  _multiDrawCount: number;
  _multiDrawCounts: Int32Array;
  _indirectTexture: { version: number; image: { data: Uint32Array } };
};
const internals = (b: BatchedMesh): BatchInternals => b as BatchInternals;

// ---- scene pieces -------------------------------------------------------------------------------------------------

/** Sees x in about [-20, 20] at the rows' depth. */
function mainCamera(cs: CoordinateSystem): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 200);
  camera.coordinateSystem = cs;
  camera.updateProjectionMatrix();
  camera.position.set(0, 6, 35);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

/** A camera like the main one, moved along x: sees x in about [cx - 20, cx + 20]. */
function cameraAt(cx: number, cs: CoordinateSystem): PerspectiveCamera {
  const camera = mainCamera(cs);
  camera.position.set(cx, 6, 35);
  camera.lookAt(cx, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

/** A sun whose orthographic shadow camera covers x in [cx - halfWidth, cx + halfWidth] and z in [-20, 20]. */
function sunLight(name: string, cx: number, cs: CoordinateSystem, halfWidth = 50): DirectionalLight {
  const sun = new DirectionalLight(0xffffff, 1);
  sun.name = name;
  sun.castShadow = true;
  sun.position.set(cx, 60, 10);
  sun.target.position.set(cx, 0, 0);
  const sc = sun.shadow.camera;
  sc.coordinateSystem = cs;
  sc.left = -halfWidth;
  sc.right = halfWidth;
  sc.top = 20;
  sc.bottom = -20;
  sc.near = 1;
  sc.far = 200;
  sc.updateProjectionMatrix();
  return sun;
}

/**
 * A shadow-casting point light near (cx, 3, 0) with range `distance`: its six faces see at most the cube of half-size
 * `distance` around it. Off the grid by a fraction, so no cube-face boundary plane only touches a cube of the rows.
 */
function pointLight(name: string, cx: number, cs: CoordinateSystem, distance = 25): PointLight {
  const light = new PointLight(0xffffff, 1, distance);
  light.name = name;
  light.castShadow = true;
  light.position.set(cx + 0.25, 3.1, 0);
  const camera = light.shadow.camera;
  camera.coordinateSystem = cs;
  camera.updateProjectionMatrix();
  return light;
}

type ShadowLight = DirectionalLight | PointLight;

function addLights(scene: Scene, lights: ShadowLight[]): void {
  for (const light of lights) {
    scene.add(light);
    if (light instanceof DirectionalLight) scene.add(light.target);
  }
}

/** 101 tagged static unit cubes in a row along x from -100 to 100 at depth z. */
function row(scene: Scene, name: string, z: number, material: Material, receiveShadow: boolean): Mesh[] {
  const meshes: Mesh[] = [];
  for (let i = 0; i < 101; i++) {
    const mesh = new Mesh(box, material);
    mesh.name = `${name}-${i}`;
    mesh.position.set(-100 + 2 * i, 0.5, z);
    mesh.castShadow = true;
    mesh.receiveShadow = receiveShadow;
    scene.add(tag.static(mesh));
    meshes.push(mesh);
  }
  return meshes;
}

type Policy = NestedPassPolicy | 'auto';

interface RigOptions {
  webgpu: boolean;
  nested: Policy;
  suns?: (cs: CoordinateSystem) => ShadowLight[];
  litMaterial?: Material;
}

/** An unlit casting batch first in traversal, then a lit receiving batch, compiled from plain meshes by `World`. */
function rig(options: RigOptions) {
  const cs = options.webgpu ? WebGPUCoordinateSystem : WebGLCoordinateSystem;
  const scene = new Scene();
  const main = mainCamera(cs);
  const suns = options.suns ? options.suns(cs) : [sunLight('sun', 50, cs)];
  addLights(scene, suns);
  const unlitOriginals = row(scene, 'unlit', -3, new MeshBasicMaterial(), false);
  const litOriginals = row(scene, 'lit', 3, options.litMaterial ?? new MeshStandardMaterial({ roughness: 0.8 }), true);
  scene.updateMatrixWorld(true);
  // threshold 1000: 101 repeats of one geometry stay a BatchedMesh (the default 64 makes an InstancedMesh).
  const world = new World(scene, {
    instanceThreshold: 1000,
    ...(options.nested === 'auto' ? {} : { nestedPasses: options.nested }),
  });
  const report = world.compile({ coordinateSystem: cs });
  const unlit = world.slotOf(unlitOriginals[0]!)!.batch as BatchedMesh;
  const lit = world.slotOf(litOriginals[0]!)!.batch as BatchedMesh;
  const renderer = new FakeRenderer({
    webgpu: options.webgpu,
    sceneHooks: true,
    shadowTrigger: 'first-receiver',
    record: true,
    shadowLights: suns,
  });
  const originals = new Map<BatchedMesh, Mesh[]>([
    [unlit, unlitOriginals],
    [lit, litOriginals],
  ]);
  return { cs, scene, main, suns, world, report, unlit, lit, originals, renderer };
}
type Rig = ReturnType<typeof rig>;

/** Puts `object` into the scene's children right before `before` (or first when `before` is null). */
function insertBefore(scene: Scene, object: Mesh, before: Mesh | BatchedMesh | null): void {
  scene.add(object);
  scene.children.splice(scene.children.indexOf(object), 1);
  scene.children.splice(before ? scene.children.indexOf(before) : 0, 0, object);
}

/** A mesh that renders the scene with `camera` from its own onBeforeRender, once per outer draw (a reflector). */
function mirrorMesh(scene: Scene, camera: Camera): Mesh {
  const mirror = new Mesh(box, new MeshBasicMaterial());
  mirror.name = 'mirror';
  let reflecting = false;
  mirror.onBeforeRender = (renderer) => {
    if (reflecting) return;
    reflecting = true;
    (renderer as unknown as FakeRenderer).render(scene, camera);
    reflecting = false;
  };
  return mirror;
}

// ---- reference and assertions ---------------------------------------------------------------------------------------

const _box = new Box3();
const _sphere = new Sphere();
const _m = new Matrix4();

type FrustumLike = { intersectsBox(b: Box3): boolean; intersectsSphere(s: Sphere): boolean };

interface Reference {
  /** Ids whose world box meets the frustum: possibly visible, so they must be drawn. */
  must: number[];
  /** Ids whose world bounding sphere meets the frustum (three's own test): nothing outside this set may be drawn. */
  may: Set<number>;
}

function frustumOf(
  pass: { projectionMatrix: Matrix4; matrixWorldInverse: Matrix4 },
  cs: CoordinateSystem,
  reversedDepth = false,
): Frustum {
  return new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(pass.projectionMatrix, pass.matrixWorldInverse),
    cs,
    reversedDepth,
  );
}

/** From the original meshes' world matrices and geometry bounds, mapped to the batch's instance ids. */
function reference(
  r: { world: World; originals: ReadonlyMap<object, Mesh[]> },
  batch: object,
  frustum: FrustumLike,
): Reference {
  const must: number[] = [];
  const may = new Set<number>();
  for (const mesh of r.originals.get(batch)!) {
    const id = r.world.slotOf(mesh)!.instanceId;
    _box.copy(box.boundingBox!).applyMatrix4(mesh.matrixWorld);
    _sphere.copy(box.boundingSphere!).applyMatrix4(mesh.matrixWorld);
    if (frustum.intersectsSphere(_sphere)) may.add(id);
    if (frustum.intersectsBox(_box)) must.push(id);
  }
  return { must, may };
}

function drawnIds(pass: FakePass, batch: BatchedMesh, label: string): number[] {
  const draws = pass.draws.filter((d) => d.object === batch);
  expect(draws, `${label}: one draw of the batch`).toHaveLength(1);
  expect(draws[0]!.batchIds, `${label}: batch ids resolved`).not.toBeNull();
  return draws[0]!.batchIds!;
}

function expectExact(label: string, ids: number[], ref: Reference): void {
  const seen = new Set(ids);
  expect(ids.length, `${label}: duplicate ids`).toBe(seen.size);
  expect(
    ref.must.filter((id) => !seen.has(id)),
    `${label}: ids inside the frustum that were not drawn`,
  ).toEqual([]);
  expect(
    ids.filter((id) => !ref.may.has(id)),
    `${label}: drawn ids whose sphere lies outside the frustum`,
  ).toEqual([]);
}

const nameOf = (r: Rig, batch: BatchedMesh): string => (batch === r.unlit ? 'unlit' : 'lit');

/** Every recorded pass draws exactly what its frustum needs, for both batches. */
function expectPassesExact(
  r: Rig,
  label: string,
  frustumFor: (pass: FakePass) => FrustumLike = (pass) => frustumOf(pass, r.cs),
): void {
  for (const pass of r.renderer.passes) {
    const frustum = frustumFor(pass);
    for (const batch of [r.unlit, r.lit]) {
      const name = `${label}, ${pass.kind} pass at depth ${pass.depth}${pass.light ? ` (${pass.light.name})` : ''}, ${nameOf(r, batch)} batch`;
      expectExact(name, drawnIds(pass, batch, name), reference(r, batch, frustum));
    }
  }
}

/** The ids of the slots `[0, _multiDrawCount)` that draw something, read from the batch's CPU arrays. */
function listedIds(batch: BatchedMesh): number[] {
  const b = internals(batch);
  const ids: number[] = [];
  for (let i = 0; i < b._multiDrawCount; i++)
    if (b._multiDrawCounts[i]! > 0) ids.push(b._indirectTexture.image.data[i]!);
  return ids;
}

const passLabels = (renderer: FakeRenderer): string[] => renderer.passes.map((p) => `${p.kind}:${p.depth}`);
const setFrame = (renderer: FakeRenderer, frame: number): void => {
  // three's Animation loop writes the animation-frame id here every tick (Animation.js:85); the fake has no loop.
  (renderer.info as { frame?: number }).frame = frame;
};

const backends = [{ webgpu: true }, { webgpu: false }] as const;
const policies: Policy[] = ['auto', 'per-pass', 'reuse-main'];

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

// ---- compacted instanced meshes -------------------------------------------------------------------------------------

type Instanced = InstancedMesh & { visibleIds: number[] };

interface InstancedRigOptions {
  webgpu: boolean;
  nested: Policy;
  /** 'uniform': 101 x 64 bytes of matrices fit three's uniform buffer; 'vertex': a 1024-byte limit puts them in the shared vertex buffer. */
  buffers: 'uniform' | 'vertex';
  lights?: (cs: CoordinateSystem) => ShadowLight[];
  /** The lit (receiving) row first in traversal: the unlit row is then first reached inside the shadow pass. */
  litFirst?: boolean;
  /** Every lit cube gets its own colour, so the lit mesh carries per-instance colours (`instanceColor`). */
  colors?: boolean;
}

/** The two rows of `rig` at the default instanceThreshold (64): one compacted InstancedMesh per row. */
function instancedRig(options: InstancedRigOptions) {
  const cs = options.webgpu ? WebGPUCoordinateSystem : WebGLCoordinateSystem;
  const scene = new Scene();
  const main = mainCamera(cs);
  const lights = options.lights ? options.lights(cs) : [sunLight('sun', 50, cs)];
  addLights(scene, lights);
  const unlitMaterial = new MeshBasicMaterial();
  const litMaterial = new MeshStandardMaterial({ roughness: 0.8 });
  const litFirst = options.litFirst === true;
  const firstRow = litFirst ? row(scene, 'lit', 3, litMaterial, true) : row(scene, 'unlit', -3, unlitMaterial, false);
  const secondRow = litFirst ? row(scene, 'unlit', -3, unlitMaterial, false) : row(scene, 'lit', 3, litMaterial, true);
  const [unlitOriginals, litOriginals] = litFirst ? [secondRow, firstRow] : [firstRow, secondRow];
  if (options.colors)
    litOriginals.forEach(
      (mesh, i) =>
        (mesh.material = new MeshStandardMaterial({ roughness: 0.8, color: new Color().setHSL(i / 101, 0.7, 0.5) })),
    );
  scene.updateMatrixWorld(true);
  const world = new World(scene, options.nested === 'auto' ? {} : { nestedPasses: options.nested });
  const report = world.compile({ coordinateSystem: cs });
  const unlit = world.slotOf(unlitOriginals[0]!)!.batch as Instanced;
  const lit = world.slotOf(litOriginals[0]!)!.batch as Instanced;
  const renderer = new FakeRenderer({
    webgpu: options.webgpu,
    sceneHooks: true,
    shadowTrigger: 'first-receiver',
    record: true,
    shadowLights: lights,
    uniformBufferLimit: options.buffers === 'vertex' ? 1024 : 65536,
  });
  const originals = new Map<Instanced, Mesh[]>([
    [unlit, unlitOriginals],
    [lit, litOriginals],
  ]);
  /** Per mesh: a row's translation (x, z) -> the instance id placed there. */
  const idAt = new Map<Instanced, Map<string, number>>();
  for (const [mesh, meshes] of originals)
    idAt.set(
      mesh,
      new Map(
        meshes.map((m) => [`${Math.round(m.position.x)},${Math.round(m.position.z)}`, world.slotOf(m)!.instanceId]),
      ),
    );
  /** Per mesh: instance id -> the colour of its original's material. */
  const colorOf = new Map<Instanced, Map<number, Color>>();
  for (const [mesh, meshes] of originals)
    colorOf.set(
      mesh,
      new Map(meshes.map((m) => [world.slotOf(m)!.instanceId, (m.material as MeshStandardMaterial).color])),
    );
  return { cs, scene, main, lights, world, report, unlit, lit, originals, renderer, idAt, colorOf };
}
type InstancedRig = ReturnType<typeof instancedRig>;

/** The ids a pass drew from a mesh: the rows three would bind (FakeDraw.instanceRows), mapped back through their translation. */
function instancedIds(r: InstancedRig, pass: FakePass, mesh: Instanced, label: string): number[] {
  const draws = pass.draws.filter((d) => d.object === mesh);
  if (draws.length === 0) return []; // count 0: no draw
  expect(draws, `${label}: one draw of the mesh`).toHaveLength(1);
  const rows = draws[0]!.instanceRows;
  expect(rows, `${label}: rows resolved`).not.toBeNull();
  const byPosition = r.idAt.get(mesh)!;
  const ids: number[] = [];
  for (let k = 0; k < rows!.length / 16; k++) {
    const id = byPosition.get(`${Math.round(rows![k * 16 + 12]!)},${Math.round(rows![k * 16 + 14]!)}`);
    expect(id, `${label}: row ${k} holds no instance of this mesh`).toBeDefined();
    ids.push(id!);
  }
  // With per-instance colours, row k's colour must be the colour of the instance its matrix row holds.
  const colors = draws[0]!.instanceColorRows;
  if (colors !== null) {
    const wrong: number[] = [];
    ids.forEach((id, k) => {
      const c = r.colorOf.get(mesh)!.get(id)!;
      if (
        Math.abs(colors[k * 3]! - c.r) > 1e-4 ||
        Math.abs(colors[k * 3 + 1]! - c.g) > 1e-4 ||
        Math.abs(colors[k * 3 + 2]! - c.b) > 1e-4
      )
        wrong.push(k);
    });
    expect(wrong, `${label}: colour rows that do not hold their instance's colour`).toEqual([]);
  }
  return ids;
}

/** What a shadow pass's light reaches: its camera's frustum, or for a point light the cube of half-size `distance || far` its six faces lie in. */
function lightVolume(pass: FakePass, cs: CoordinateSystem): FrustumLike {
  if (pass.face === null) return frustumOf(pass, cs);
  const light = pass.light as PointLight;
  const reach = 2 * (light.distance || light.shadow.camera.far);
  return new Box3().setFromCenterAndSize(
    new Vector3().setFromMatrixPosition(light.matrixWorld),
    new Vector3(reach, reach, reach),
  );
}

/**
 * The main pass draws exactly its list. A shadow pass draws, once each, every caster its camera needs, and nothing that
 * neither the main camera nor any shadow light of the frame reaches (it keeps the enclosing rows and appends what the
 * frame's lights need). Any other nested pass draws nothing that neither the main camera nor its own camera reaches.
 */
function expectInstancedPasses(r: InstancedRig, label: string): void {
  const [main, ...nested] = r.renderer.passes as [FakePass, ...FakePass[]];
  for (const mesh of [r.unlit, r.lit]) {
    const name = mesh === r.unlit ? 'unlit' : 'lit';
    const mainRef = reference(r, mesh, frustumOf(main, r.cs));
    expectExact(`${label}, main pass, ${name} mesh`, instancedIds(r, main, mesh, `${label}, main`), mainRef);
    const reachable = new Set(mainRef.may);
    for (const pass of nested)
      if (pass.kind === 'shadow') for (const id of reference(r, mesh, lightVolume(pass, r.cs)).may) reachable.add(id);
    for (const pass of nested) {
      const passLabel = `${label}, ${pass.kind} pass at depth ${pass.depth}${pass.light ? ` (${pass.light.name}${pass.face === null ? '' : ` face ${pass.face}`})` : ''}, ${name} mesh`;
      const ids = instancedIds(r, pass, mesh, passLabel);
      expect(ids.length, `${passLabel}: duplicate ids`).toBe(new Set(ids).size);
      const own = reference(r, mesh, frustumOf(pass, r.cs));
      if (pass.kind === 'shadow') {
        const drawn = new Set(ids);
        expect(
          own.must.filter((id) => !drawn.has(id)),
          `${passLabel}: casters inside the frustum that were not drawn`,
        ).toEqual([]);
        expect(
          ids.filter((id) => !reachable.has(id)),
          `${passLabel}: drawn ids no light of the frame and not the main camera reaches`,
        ).toEqual([]);
      } else {
        expect(
          ids.filter((id) => !mainRef.may.has(id) && !own.may.has(id)),
          `${passLabel}: drawn ids neither the main camera nor this camera reaches`,
        ).toEqual([]);
      }
    }
  }
}

describe.each(backends)(
  'more shadow cameras in a frame than the caster bitmask has bits (webgpu: $webgpu)',
  ({ webgpu }) => {
    it('falls back to appending the whole union past the 32nd camera, and still draws every caster that camera needs', () => {
      // `bitFor` (src/compiler/instancing.ts ~379) gives each shadow camera of the frame one bit of a Uint32, and
      // `appendCasters` (~518) uses that bit to append only the casters the camera reaches. Past the 32nd camera there is
      // no bit left, so `bitFor` returns 0, the per-light filter is skipped, and the pass appends the frame's whole union
      // instead — the old, conservative superset. It may draw more than the light needs, but it must never drop a caster,
      // which is the one failure mode here that would show as a missing shadow. Nothing covered this branch.
      const COUNT = 33;
      const r = instancedRig({
        webgpu,
        nested: 'auto',
        buffers: 'uniform',
        // Narrow suns spread along the rows, so each reaches a different few cubes and the slices stay distinguishable.
        lights: (cs) => Array.from({ length: COUNT }, (_, i) => sunLight(`sun-${i}`, -96 + i * 6, cs, 3)),
      });
      expect(r.lights).toHaveLength(COUNT);
      r.renderer.render(r.scene, r.main);
      expect(passLabels(r.renderer)).toEqual(['render:0', ...Array<string>(COUNT).fill('shadow:1')]);
      // The contract every pass keeps, the fallback included: every caster its own camera needs is drawn, and nothing
      // that no light of the frame and not the main camera reaches.
      expectInstancedPasses(r, `${COUNT} suns`);

      const [main, ...shadows] = r.renderer.passes as [FakePass, ...FakePass[]];
      const past = shadows[32]!;
      expect(past.light!.name, 'the 33rd shadow camera').toBe('sun-32');
      for (const mesh of [r.unlit, r.lit]) {
        const name = mesh === r.unlit ? 'unlit' : 'lit';
        const held = new Set(instancedIds(r, main, mesh, `${name}, main`));
        const ids = instancedIds(r, past, mesh, `${name}, the 33rd sun`);
        const own = reference(r, mesh, frustumOf(past, r.cs));
        const drawn = new Set(ids);
        expect(
          own.must.filter((id) => !drawn.has(id)),
          `${name}: casters the 33rd sun needs but did not draw`,
        ).toEqual([]);
        // It appended the other suns' casters too, which is what the missing bit costs: the superset, not a narrowed list.
        const foreign = [
          ...new Set(shadows.filter((p) => p !== past).flatMap((p) => reference(r, mesh, frustumOf(p, r.cs)).must)),
        ].filter((id) => !held.has(id) && !own.may.has(id));
        expect(foreign.length, `${name}: the other suns have casters of their own`).toBeGreaterThan(15);
        expect(
          foreign.filter((id) => !drawn.has(id)),
          `${name}: past the 32nd camera the pass appends the frame's whole union`,
        ).toEqual([]);
      }
      // A camera inside the 32 still gets only its own casters, so the fallback is the exception and not the new rule.
      for (const mesh of [r.unlit, r.lit]) {
        const name = mesh === r.unlit ? 'unlit' : 'lit';
        const held = new Set(instancedIds(r, main, mesh, `${name}, main`));
        const first = shadows[0]!;
        const own = reference(r, mesh, frustumOf(first, r.cs));
        expect(
          instancedIds(r, first, mesh, `${name}, the 1st sun`).filter((id) => !held.has(id) && !own.may.has(id)),
          `${name}: the 1st sun appended only the casters it reaches`,
        ).toEqual([]);
      }
    });
  },
);

const bufferPaths = ['uniform', 'vertex'] as const;

describe.each(backends)('compacted InstancedMesh in nested passes (webgpu: $webgpu)', ({ webgpu }) => {
  describe.each(policies)("nestedPasses: '%s'", (nested) => {
    describe.each(bufferPaths)('%s buffers', (buffers) => {
      const resolved: NestedPassPolicy = nested === 'auto' ? 'per-pass' : nested;

      it.each([false, true])(
        'draws the main list exactly and every caster a shadow camera needs, on two frames (lit row first: %s)',
        (litFirst) => {
          const r = instancedRig({ webgpu, nested, buffers, litFirst });
          expect(r.report.nestedPasses).toBe(resolved);
          expect(r.report.after).toMatchObject({ batches: 0, instanced: 2 });
          expect(
            r.scene.children.indexOf(r.unlit) < r.scene.children.indexOf(r.lit),
            'the unlit mesh is first in traversal',
          ).toBe(!litFirst);
          for (let frame = 1; frame <= 2; frame++) {
            r.renderer.render(r.scene, r.main);
            expect(passLabels(r.renderer)).toEqual(['render:0', 'shadow:1']);
            expectInstancedPasses(r, `frame ${frame}`);
          }
          const [main, shadow] = r.renderer.passes as [FakePass, FakePass];
          for (const mesh of [r.unlit, r.lit]) {
            const mainMust = new Set(reference(r, mesh, frustumOf(main, r.cs)).must);
            expect(
              reference(r, mesh, frustumOf(shadow, r.cs)).must.filter((id) => !mainMust.has(id)).length,
              'casters outside the view',
            ).toBeGreaterThan(20);
          }
        },
      );

      it.each([false, true])(
        'keeps the rows exact while the main camera moves every frame, the lit mesh receiving shadows first (per-instance colours: %s)',
        (colors) => {
          const r = instancedRig({ webgpu, nested, buffers, colors });
          expect(r.lit.instanceColor === null, 'per-instance colours on the lit mesh').toBe(!colors);
          for (let frame = 1; frame <= 3; frame++) {
            // Two cubes leave the view and two enter each frame: the main rows and the appended casters both change.
            r.main.position.set(4 * (frame - 1), 6, 35);
            r.main.lookAt(4 * (frame - 1), 0, 0);
            r.main.updateMatrixWorld();
            r.renderer.render(r.scene, r.main);
            expect(passLabels(r.renderer)).toEqual(['render:0', 'shadow:1']);
            expectInstancedPasses(r, `frame ${frame}`);
          }
        },
      );

      it('leaves count and visibleIds holding the main list once the frame is over', () => {
        const r = instancedRig({ webgpu, nested, buffers });
        r.renderer.render(r.scene, r.main);
        const frustum = frustumOf(r.renderer.passes[0]!, r.cs);
        for (const mesh of [r.unlit, r.lit]) {
          expect(mesh.visibleIds.length, 'visibleIds matches count').toBe(mesh.count);
          expectExact('after the frame', mesh.visibleIds, reference(r, mesh, frustum));
        }
      });

      it("serves two suns and a point light's six faces from rows appended once, restoring count after every shadow render", () => {
        const r = instancedRig({
          webgpu,
          nested,
          buffers,
          lights: (cs) => [sunLight('east', 60, cs, 20), sunLight('west', -60, cs, 20), pointLight('bulb', 0, cs, 30)],
        });
        const shadowCameras = new Set<Camera>(r.lights.map((light) => light.shadow.camera));
        const afterShadow: number[][] = [];
        r.scene.onAfterRender = ((previous) =>
          function (this: Scene, ...args: Parameters<Scene['onAfterRender']>) {
            previous.apply(this, args);
            if (shadowCameras.has(args[2])) afterShadow.push([r.unlit.count, r.lit.count]);
          })(r.scene.onAfterRender);
        for (let frame = 1; frame <= 2; frame++) {
          afterShadow.length = 0;
          r.renderer.render(r.scene, r.main);
          expect(passLabels(r.renderer)).toEqual(['render:0', ...Array<string>(8).fill('shadow:1')]);
          expectInstancedPasses(r, `frame ${frame}`);
          const counts = [r.unlit.count, r.lit.count];
          expect(afterShadow, 'count is back to the main list after each shadow render').toEqual(
            Array.from({ length: 8 }, () => counts),
          );
        }
      });

      it('appends to each shadow light only the casters that light reaches, on top of the enclosing rows in their order', () => {
        // Two suns with disjoint volumes, neither overlapping the main view: every appended caster belongs to exactly
        // one of them, so a pass that appended the frame's union would draw the other light's casters too.
        const r = instancedRig({
          webgpu,
          nested,
          buffers,
          lights: (cs) => [sunLight('east', 60, cs, 20), sunLight('west', -60, cs, 20)],
        });
        for (let frame = 1; frame <= 2; frame++) {
          r.renderer.render(r.scene, r.main);
          expect(passLabels(r.renderer)).toEqual(['render:0', 'shadow:1', 'shadow:1']);
          expectInstancedPasses(r, `frame ${frame}`);
          const [main, ...shadows] = r.renderer.passes as [FakePass, ...FakePass[]];
          expect(shadows.map((p) => p.light!.name)).toEqual(['east', 'west']);
          for (const mesh of [r.unlit, r.lit]) {
            const name = mesh === r.unlit ? 'unlit' : 'lit';
            const prefix = instancedIds(r, main, mesh, `frame ${frame}, ${name}, main`);
            for (const pass of shadows) {
              const label = `frame ${frame}, ${name}, ${pass.light!.name}`;
              const ids = instancedIds(r, pass, mesh, label);
              // Compared in row order, never as a set: the enclosing pass's rows must be the same rows, unreordered.
              expect(ids.slice(0, prefix.length), `${label}: the enclosing pass's rows`).toEqual(prefix);
              const own = reference(r, mesh, frustumOf(pass, r.cs));
              const other = reference(r, mesh, frustumOf(shadows.find((p) => p !== pass)!, r.cs));
              const held = new Set(prefix);
              expect(
                other.must.filter((id) => !held.has(id) && !own.may.has(id)).length,
                `${label}: the other light has casters of its own`,
              ).toBeGreaterThan(15);
              expect(
                ids.slice(prefix.length).filter((id) => !own.may.has(id)),
                `${label}: appended casters this light does not reach`,
              ).toEqual([]);
              expect(
                own.must.filter((id) => !ids.includes(id)),
                `${label}: casters this light reaches that were not drawn`,
              ).toEqual([]);
            }
          }
        }
      });

      it('rewrites the appended tail once per shadow light whose casters differ from the rows it holds', () => {
        // The worst case for uploads: two disjoint caster sets, so each pass rewrites what the pass before it wrote.
        // A light whose casters are the rows already there (a point light's faces, or a set the tail starts with)
        // writes nothing; `writeRows` marks only rows that change.
        const r = instancedRig({
          webgpu,
          nested,
          buffers,
          lights: (cs) => [sunLight('east', 60, cs, 20), sunLight('west', -60, cs, 20)],
        });
        const bumps = (): number[] => {
          const before = [r.unlit, r.lit].map((m) => m.instanceMatrix.version);
          r.renderer.render(r.scene, r.main);
          return [r.unlit, r.lit].map((m, i) => m.instanceMatrix.version - before[i]!);
        };
        // Frame 1: the outermost compaction, then one append per sun. Frame 2: the compaction is skipped (the view and
        // the rows are unchanged), and each sun rewrites the tail the other left.
        expect(bumps(), 'frame 1').toEqual([3, 3]);
        expect(bumps(), 'frame 2').toEqual([2, 2]);
      });

      it("draws the main camera's list in a reflection drawn between the rows, which renders its own shadow map", () => {
        const r = instancedRig({ webgpu, nested, buffers });
        insertBefore(r.scene, mirrorMesh(r.scene, cameraAt(-60, r.cs)), r.lit);
        for (let frame = 1; frame <= 2; frame++) {
          r.renderer.render(r.scene, r.main);
          expect(passLabels(r.renderer)).toEqual(['render:0', 'render:1', 'shadow:2', 'shadow:1']);
          expectInstancedPasses(r, `frame ${frame}`);
          const [main, reflection] = r.renderer.passes as [FakePass, FakePass];
          // The open main pass compacted the unlit row; the reflection reaches the lit row first and compacts it for the
          // main camera. Either way the reflection draws the main list and appends nothing.
          for (const mesh of [r.unlit, r.lit]) {
            const name = mesh === r.unlit ? 'unlit' : 'lit';
            expect(
              new Set(instancedIds(r, reflection, mesh, `reflection, ${name}`)),
              `frame ${frame}, reflection, ${name}`,
            ).toEqual(new Set(instancedIds(r, main, mesh, `main, ${name}`)));
          }
        }
      });

      it('uploads only rows that change: the main cull and one append on the first frame, nothing on a static frame, one append when the light moves', () => {
        const r = instancedRig({ webgpu, nested, buffers });
        const versions = (): number[] => [r.unlit, r.lit].map((m) => m.instanceMatrix.version);
        const frame = (): number[] => {
          const before = versions();
          r.renderer.render(r.scene, r.main);
          return versions().map((v, i) => v - before[i]!);
        };
        expect(frame(), 'frame 1').toEqual([2, 2]);
        expect(frame(), 'frame 2').toEqual([0, 0]);
        const sun = r.lights[0] as DirectionalLight;
        sun.position.x = -50;
        sun.target.position.x = -50;
        sun.updateMatrix(); // compile() froze the static light
        sun.target.updateMatrix();
        r.scene.updateMatrixWorld(true);
        expect(frame(), 'frame 3').toEqual([1, 1]);
        expectInstancedPasses(r, 'frame 3');
      });

      it('recovers when a nested render throws: count and the lists are exact again on the next animation frame', () => {
        const r = instancedRig({ webgpu, nested, buffers });
        const thrower = new Mesh(box, new MeshBasicMaterial());
        thrower.name = 'thrower';
        thrower.castShadow = true;
        thrower.position.set(50, 0.5, 0);
        thrower.updateMatrixWorld();
        let armed = true;
        thrower.onBeforeRender = (_renderer, _scene, camera) => {
          if (armed && camera === r.lights[0]!.shadow.camera) throw new Error('shadow pass failed');
        };
        r.scene.add(thrower);
        setFrame(r.renderer, 1);
        expect(() => r.renderer.render(r.scene, r.main)).toThrow('shadow pass failed');
        armed = false;
        r.scene.overrideMaterial = null; // three's state, left behind by the failed map render (see the batch test)
        const next = new FakeRenderer({
          webgpu,
          sceneHooks: true,
          shadowTrigger: 'first-receiver',
          record: true,
          shadowLights: r.lights,
          uniformBufferLimit: buffers === 'vertex' ? 1024 : 65536,
        });
        const again: InstancedRig = { ...r, renderer: next };
        for (let frame = 2; frame <= 3; frame++) {
          setFrame(next, frame);
          next.render(r.scene, r.main);
          expect(passLabels(next)).toEqual(['render:0', 'shadow:1']);
          expectInstancedPasses(again, `frame ${frame} after the throw`);
        }
        const frustum = frustumOf(next.passes[0]!, r.cs);
        for (const mesh of [r.unlit, r.lit]) {
          expect(mesh.visibleIds.length).toBe(mesh.count);
          expectExact('after the throw', mesh.visibleIds, reference(r, mesh, frustum));
        }
      });
    });
  });
});

describe('compacted InstancedMesh driven by a PassTracker', () => {
  function field(nestedPasses: NestedPassPolicy) {
    const main = new PerspectiveCamera(60, 1.5, 0.1, 300);
    main.position.set(0, 2, 0);
    main.lookAt(100, 1, 0);
    main.updateMatrixWorld();
    const mirror = main.clone();
    mirror.rotateY(Math.PI); // looks the other way: a different visible set
    mirror.updateMatrixWorld();
    const rng = mulberry32(5);
    const matrices = Array.from({ length: 2000 }, () =>
      new Matrix4().makeTranslation(rng() * 2000 - 1000, 1, rng() * 2000 - 1000),
    );
    const passes = new PassTracker();
    const mesh = createCulledInstancedMesh(box, new MeshStandardMaterial(), matrices, null, WebGLCoordinateSystem, {
      nestedPasses,
      passes,
    }) as Instanced;
    const scene = new Scene();
    const run = (c: Camera): void =>
      mesh.onBeforeRender(
        { coordinateSystem: WebGLCoordinateSystem } as never,
        scene,
        c,
        mesh.geometry,
        mesh.material as never,
        null as never,
      );
    const inView = (c: Camera): Set<number> => {
      const frustum = frustumOf(c, WebGLCoordinateSystem);
      const ids = new Set<number>();
      matrices.forEach((m, id) => {
        if (frustum.intersectsBox(_box.copy(box.boundingBox!).applyMatrix4(m))) ids.add(id);
      });
      return ids;
    };
    return { main, mirror, mesh, passes, run, inView };
  }

  it.each(['per-pass', 'reuse-main'] as const)(
    "draws the enclosing pass's list in a nested render that is not a shadow map, without an upload (%s)",
    (nestedPasses) => {
      const f = field(nestedPasses);
      f.passes.begin(f.main);
      f.run(f.main);
      const ids = [...f.mesh.visibleIds];
      expect(new Set(ids)).toEqual(f.inView(f.main));
      const version = f.mesh.instanceMatrix.version;
      f.passes.begin(f.mirror);
      f.run(f.mirror);
      expect(f.mesh.visibleIds).toEqual(ids);
      expect(f.mesh.count).toBe(ids.length);
      expect(f.mesh.instanceMatrix.version, 'no upload for the nested pass').toBe(version);
      f.passes.end();
      f.passes.end();
      expect([f.mesh.count, f.mesh.visibleIds]).toEqual([ids.length, ids]);
    },
  );

  it.each(['per-pass', 'reuse-main'] as const)(
    'compacts for the main camera when a nested render reaches the mesh before its outermost render does, and serves that render from it (%s)',
    (nestedPasses) => {
      const f = field(nestedPasses);
      for (let frame = 1; frame <= 2; frame++) {
        f.passes.begin(f.main); // the outermost render has not drawn the mesh yet
        f.passes.begin(f.mirror);
        f.run(f.mirror);
        const ids = [...f.mesh.visibleIds];
        expect(new Set(ids), `frame ${frame}: the nested render draws the main camera's list`).toEqual(
          f.inView(f.main),
        );
        expect(f.mesh.count).toBe(ids.length);
        f.passes.end();
        const version = f.mesh.instanceMatrix.version;
        f.run(f.main);
        expect([f.mesh.count, f.mesh.visibleIds], `frame ${frame}: the outermost render draws the same list`).toEqual([
          ids.length,
          ids,
        ]);
        expect(f.mesh.instanceMatrix.version, 'without another upload').toBe(version);
        f.passes.end();
      }
    },
  );
});
