/**
 * Nested render passes (shadow maps, reflections, portals) on compiled batches.
 *
 * three r186 renders a shadow map from inside the first `receiveShadow` object's draw (`AnalyticLightNode.setup` ->
 * `ShadowNode.updateBefore`, called from `Renderer._renderObjectDirect` after `object.onBeforeRender`). Every material
 * of a `BatchedMesh` reads the same `_indirectTexture` (`nodes/accessors/Batch.js`). On WebGPU a texture upload lands
 * at once while the enclosing pass is submitted only in `finishRender`; on WebGL the receiving batch draws right after
 * the nested render returns. So a nested pass must not rewrite the index rows the enclosing pass already recorded.
 *
 * The FakeRenderer (Task 2) models exactly that timing (`webgpu`, `sceneHooks`, `shadowTrigger: 'first-receiver'`,
 * `record`). Every test here compiles plain meshes with `World` and checks the ids each pass actually draws against a
 * reference computed from the original meshes: every id whose box meets the pass's frustum is drawn, no id twice, and
 * nothing whose bounding sphere misses the frustum (so any id beyond the box reference lies outside the frustum).
 */
import { describe, expect, it } from 'vitest';
import {
  ArrayCamera,
  BatchedMesh,
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  Frustum,
  FrustumArray,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type Camera,
  type CoordinateSystem,
  type Material,
} from 'three';
import { attachBvhCulling, FORGE_HOOK, type NestedPassPolicy } from '../../src/compiler/culling.js';
import { createCulledInstancedMesh } from '../../src/compiler/instancing.js';
import { World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';
import { mulberry32 } from '../../test/scenes/naive.js';
import { FakeRenderer, type FakePass } from './helpers/fakeRenderer.js';

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
  suns?: (cs: CoordinateSystem) => DirectionalLight[];
  litMaterial?: Material;
}

/** An unlit casting batch first in traversal, then a lit receiving batch, compiled from plain meshes by `World`. */
function rig(options: RigOptions) {
  const cs = options.webgpu ? WebGPUCoordinateSystem : WebGLCoordinateSystem;
  const scene = new Scene();
  const main = mainCamera(cs);
  const suns = options.suns ? options.suns(cs) : [sunLight('sun', 50, cs)];
  for (const sun of suns) scene.add(sun, sun.target);
  const unlitOriginals = row(scene, 'unlit', -3, new MeshBasicMaterial(), false);
  const litOriginals = row(scene, 'lit', 3, options.litMaterial ?? new MeshStandardMaterial({ roughness: 0.8 }), true);
  scene.updateMatrixWorld(true);
  // threshold 1000: 101 repeats of one geometry stay a BatchedMesh (the default 64 makes an InstancedMesh, Task 17).
  const world = new World(scene, { instanceThreshold: 1000, ...(options.nested === 'auto' ? {} : { nestedPasses: options.nested }) });
  const report = world.compile({ coordinateSystem: cs });
  const unlit = world.slotOf(unlitOriginals[0]!)!.batch as BatchedMesh;
  const lit = world.slotOf(litOriginals[0]!)!.batch as BatchedMesh;
  const renderer = new FakeRenderer({ webgpu: options.webgpu, sceneHooks: true, shadowTrigger: 'first-receiver', record: true, shadowLights: suns });
  const originals = new Map<BatchedMesh, Mesh[]>([
    [unlit, unlitOriginals],
    [lit, litOriginals],
  ]);
  return { cs, scene, main, suns, world, report, unlit, lit, originals, renderer };
}
type Rig = ReturnType<typeof rig>;

/** Puts `object` into the scene's children right before `before` (or first when `before` is null). */
function insertBefore(scene: Scene, object: Mesh, before: BatchedMesh | null): void {
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

function frustumOf(pass: { projectionMatrix: Matrix4; matrixWorldInverse: Matrix4 }, cs: CoordinateSystem, reversedDepth = false): Frustum {
  return new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(pass.projectionMatrix, pass.matrixWorldInverse), cs, reversedDepth);
}

/** From the original meshes' world matrices and geometry bounds, mapped to the batch's instance ids. */
function reference(r: Rig, batch: BatchedMesh, frustum: FrustumLike): Reference {
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
function expectPassesExact(r: Rig, label: string, frustumFor: (pass: FakePass) => FrustumLike = (pass) => frustumOf(pass, r.cs)): void {
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
  for (let i = 0; i < b._multiDrawCount; i++) if (b._multiDrawCounts[i]! > 0) ids.push(b._indirectTexture.image.data[i]!);
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
    const resolved: NestedPassPolicy = nested === 'auto' ? (webgpu ? 'reuse-main' : 'per-pass') : nested;

    it('draws in every pass each id its frustum needs, once, and nothing else, on two consecutive frames', () => {
      const r = rig({ webgpu, nested });
      expect(r.report.nestedPasses).toBe(resolved);
      expect(r.report.after).toMatchObject({ batches: 2, instanced: 0 });
      expect(r.scene.children.indexOf(r.unlit), 'the unlit batch is first in traversal').toBeLessThan(r.scene.children.indexOf(r.lit));
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
      const mainRows = [r.unlit, r.lit].map((b) => Array.from(internals(b)._indirectTexture.image.data.subarray(0, internals(b)._multiDrawCount)));
      // The rows as they stand once the reflection is over, before the main pass reaches the batches.
      let rowsAfterReflection: number[][] = [];
      mirror.onAfterRender = () => {
        rowsAfterReflection = [r.unlit, r.lit].map((b, i) => Array.from(internals(b)._indirectTexture.image.data.subarray(0, mainRows[i]!.length)));
      };
      r.renderer.render(r.scene, r.main);
      expect(passLabels(r.renderer)).toEqual(['render:0', 'render:1', 'shadow:2', 'shadow:1']);
      expectPassesExact(r, 'frame 2');
      // 'reuse-main' only ever appends to the last main list, so the rows change once per frame (in the main pass).
      if (resolved === 'reuse-main') expect(rowsAfterReflection, 'the reflection kept the previous main rows').toEqual(mainRows);
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
      expect(appended.filter((id) => inMain.has(id)), 'appended ids are not in the main list').toEqual([]);
      const keptSet = new Set(kept);
      expect(kept, 'kept ids stay in the main order').toEqual(mainIds.filter((id) => keptSet.has(id)));
      // Back to front for the shadow camera: its view-space z must not increase along the appended ids.
      const depth = (id: number): number => {
        const mesh = r.originals.get(r.lit)!.find((m) => r.world.slotOf(m)!.instanceId === id)!;
        return -new Vector3().setFromMatrixPosition(mesh.matrixWorld).applyMatrix4(shadow.matrixWorldInverse).z;
      };
      expect(appended.length).toBeGreaterThan(5);
      for (let i = 1; i < appended.length; i++) expect(depth(appended[i]!), `appended[${i}]`).toBeLessThanOrEqual(depth(appended[i - 1]!) + 1e-6);
    });

    it('uploads the index texture again only when a nested pass appends rows the texture does not hold yet', () => {
      const version = (b: BatchedMesh): number => internals(b)._indirectTexture.version;
      // A sun inside the main view: the shadow pass needs nothing the main list lacks.
      const inside = rig({ webgpu, nested, suns: (cs) => [sunLight('sun', 0, cs, 8)] });
      const v0 = [inside.unlit, inside.lit].map(version);
      inside.renderer.render(inside.scene, inside.main);
      expect([inside.unlit, inside.lit].map((b, i) => version(b) - v0[i]!), 'the main cull only').toEqual([1, 1]);
      expectPassesExact(inside, 'sun inside the view');

      const outside = rig({ webgpu, nested });
      const deltas = (render: () => void): number[] => {
        const before = [outside.unlit, outside.lit].map(version);
        render();
        return [outside.unlit, outside.lit].map((b, i) => version(b) - before[i]!);
      };
      const frame = (): void => outside.renderer.render(outside.scene, outside.main);
      expect(deltas(frame), 'frame 1: the main cull and one append (the shadow pass culls twice, the rows change once)').toEqual([2, 2]);
      expect(deltas(frame), 'frame 2: the appended rows are already in the texture').toEqual([1, 1]);
      for (const light of outside.suns) {
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
      for (const pass of r.renderer.passes) expect([...drawnIds(pass, r.unlit, pass.kind)].sort((a, b) => a - b)).toEqual(all);
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
      const next = new FakeRenderer({ webgpu, sceneHooks: true, shadowTrigger: 'first-receiver', record: true, shadowLights: r.suns });
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
        expect(listedIds(batch).length, `${nameOf(r, batch)}: no slot left zeroed`).toBe(internals(batch)._multiDrawCount);
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
    const cull = (camera: Camera): void => batch.onBeforeRender({ coordinateSystem: WebGLCoordinateSystem } as never, new Scene(), camera, batch.geometry, batch.material as never, null as never);
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
  it("resolves 'auto' to 'reuse-main' on WebGPU and 'per-pass' on WebGL, and tracks the main camera through the scene hooks", () => {
    const scene = new Scene();
    for (let i = 0; i < 4; i++) scene.add(tag.static(new Mesh(box, new MeshStandardMaterial({ color: new Color(i * 0x111111) }))));
    const a = new World(scene);
    expect(a.compile({ coordinateSystem: WebGPUCoordinateSystem }).nestedPasses).toBe('reuse-main');
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
    expect(Object.prototype.hasOwnProperty.call(scene, 'onBeforeRender')).toBe(false);
  });

  it.each(['per-pass', 'reuse-main'] as const)("installs marked scene hooks under '%s' and removes them on decompile", (nestedPasses) => {
    const scene = new Scene();
    for (let i = 0; i < 4; i++) scene.add(tag.static(new Mesh(box, new MeshStandardMaterial({ color: new Color(i * 0x111111) }))));
    const w = new World(scene, { nestedPasses });
    w.compile();
    for (const name of ['onBeforeRender', 'onAfterRender'] as const) {
      expect(Object.prototype.hasOwnProperty.call(scene, name), name).toBe(true);
      expect((scene[name] as unknown as Record<symbol, unknown>)[FORGE_HOOK], name).toBe(true);
    }
    w.decompile();
    expect(Object.prototype.hasOwnProperty.call(scene, 'onBeforeRender')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(scene, 'onAfterRender')).toBe(false);
  });
});

// ---- instanced meshes (unchanged here; Task 17) ----------------------------------------------------------------------

describe("nested passes: 'reuse-main' (instanced)", () => {
  it('keeps the main compaction for nested cameras', () => {
    const main = new PerspectiveCamera(60, 1.5, 0.1, 300);
    main.position.set(0, 2, 0);
    main.lookAt(100, 1, 0);
    main.updateMatrixWorld();
    const mirror = main.clone();
    mirror.rotateY(Math.PI); // looks the other way: a different visible set
    mirror.updateMatrixWorld();
    const rng = mulberry32(5);
    const matrices = Array.from({ length: 2000 }, () => new Matrix4().makeTranslation(rng() * 2000 - 1000, 1, rng() * 2000 - 1000));
    let current: PerspectiveCamera | null = null;
    const mesh = createCulledInstancedMesh(box, new MeshStandardMaterial(), matrices, null, WebGLCoordinateSystem, { nestedPasses: 'reuse-main', mainCamera: () => current });
    const run = (c: PerspectiveCamera) => mesh.onBeforeRender({ coordinateSystem: WebGLCoordinateSystem } as never, new Scene(), c, mesh.geometry, mesh.material as never, null as never);
    current = main;
    run(mirror);
    expect(mesh.count).toBe(0);
    run(main);
    const ids = [...mesh.visibleIds];
    expect(ids.length).toBeGreaterThan(10);
    const version = mesh.instanceMatrix.version;
    run(mirror);
    expect(mesh.visibleIds).toEqual(ids);
    expect(mesh.instanceMatrix.version).toBe(version); // no upload for the nested pass
  });
});
