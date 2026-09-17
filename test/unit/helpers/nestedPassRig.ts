/**
 * Rig for nested render passes (shadow maps, reflections) on compiled batches and compacted instanced meshes.
 *
 * three r186 renders a shadow map from inside the first `receiveShadow` object's draw (`ShadowNode.updateBefore`, from
 * `Renderer._renderObjectDirect` after `object.onBeforeRender`), and every material of a `BatchedMesh` reads the same
 * `_indirectTexture` (`nodes/accessors/Batch.js`), so a nested pass must not rewrite the index rows the enclosing pass
 * already recorded. The FakeRenderer models that timing. The reference for a pass comes from the original meshes: every
 * id whose box meets the frustum must be drawn, once, and nothing whose bounding sphere misses it may be.
 */

import {
  type BatchedMesh,
  Box3,
  BoxGeometry,
  type Camera,
  Color,
  type CoordinateSystem,
  DirectionalLight,
  Frustum,
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
import { expect } from 'vitest';
import type { NestedPassPolicy } from '../../../src/compiler/culling.js';
import { World } from '../../../src/compiler/World.js';
import { tag } from '../../../src/tags.js';
import { type FakePass, FakeRenderer } from './fakeRenderer.js';

export const box = new BoxGeometry(1, 1, 1);
box.computeBoundingBox();
box.computeBoundingSphere();

type BatchInternals = BatchedMesh & {
  _multiDrawCount: number;
  _multiDrawCounts: Int32Array;
  _indirectTexture: { version: number; image: { data: Uint32Array } };
};
export const internals = (b: BatchedMesh): BatchInternals => b as BatchInternals;

// ---- scene pieces -------------------------------------------------------------------------------------------------

/** Sees x in about [-20, 20] at the rows' depth. */
export function mainCamera(cs: CoordinateSystem): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 200);
  camera.coordinateSystem = cs;
  camera.updateProjectionMatrix();
  camera.position.set(0, 6, 35);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

/** A camera like the main one, moved along x: sees x in about [cx - 20, cx + 20]. */
export function cameraAt(cx: number, cs: CoordinateSystem): PerspectiveCamera {
  const camera = mainCamera(cs);
  camera.position.set(cx, 6, 35);
  camera.lookAt(cx, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

/** A sun whose orthographic shadow camera covers x in [cx - halfWidth, cx + halfWidth] and z in [-20, 20]. */
export function sunLight(name: string, cx: number, cs: CoordinateSystem, halfWidth = 50): DirectionalLight {
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
export function pointLight(name: string, cx: number, cs: CoordinateSystem, distance = 25): PointLight {
  const light = new PointLight(0xffffff, 1, distance);
  light.name = name;
  light.castShadow = true;
  light.position.set(cx + 0.25, 3.1, 0);
  const camera = light.shadow.camera;
  camera.coordinateSystem = cs;
  camera.updateProjectionMatrix();
  return light;
}

export type ShadowLight = DirectionalLight | PointLight;

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

export type Policy = NestedPassPolicy | 'auto';

export interface RigOptions {
  webgpu: boolean;
  nested: Policy;
  suns?: (cs: CoordinateSystem) => ShadowLight[];
  litMaterial?: Material;
}

/** An unlit casting batch first in traversal, then a lit receiving batch, compiled from plain meshes by `World`. */
export function rig(options: RigOptions) {
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
export type Rig = ReturnType<typeof rig>;

/** Puts `object` into the scene's children right before `before` (or first when `before` is null). */
export function insertBefore(scene: Scene, object: Mesh, before: Mesh | BatchedMesh | null): void {
  scene.add(object);
  scene.children.splice(scene.children.indexOf(object), 1);
  scene.children.splice(before ? scene.children.indexOf(before) : 0, 0, object);
}

/** A mesh that renders the scene with `camera` from its own onBeforeRender, once per outer draw (a reflector). */
export function mirrorMesh(scene: Scene, camera: Camera): Mesh {
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

export type FrustumLike = { intersectsBox(b: Box3): boolean; intersectsSphere(s: Sphere): boolean };

export interface Reference {
  /** Ids whose world box meets the frustum: possibly visible, so they must be drawn. */
  must: number[];
  /** Ids whose world bounding sphere meets the frustum (three's own test): nothing outside this set may be drawn. */
  may: Set<number>;
}

export function frustumOf(
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
export function reference(
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

export function drawnIds(pass: FakePass, batch: BatchedMesh, label: string): number[] {
  const draws = pass.draws.filter((d) => d.object === batch);
  expect(draws, `${label}: one draw of the batch`).toHaveLength(1);
  expect(draws[0]!.batchIds, `${label}: batch ids resolved`).not.toBeNull();
  return draws[0]!.batchIds!;
}

export function expectExact(label: string, ids: number[], ref: Reference): void {
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

export const nameOf = (r: Rig, batch: BatchedMesh): string => (batch === r.unlit ? 'unlit' : 'lit');

/** Every recorded pass draws exactly what its frustum needs, for both batches. */
export function expectPassesExact(
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
export function listedIds(batch: BatchedMesh): number[] {
  const b = internals(batch);
  const ids: number[] = [];
  for (let i = 0; i < b._multiDrawCount; i++)
    if (b._multiDrawCounts[i]! > 0) ids.push(b._indirectTexture.image.data[i]!);
  return ids;
}

export const passLabels = (renderer: FakeRenderer): string[] => renderer.passes.map((p) => `${p.kind}:${p.depth}`);
export const setFrame = (renderer: FakeRenderer, frame: number): void => {
  // three's Animation loop writes the animation-frame id here every tick (Animation.js:85); the fake has no loop.
  (renderer.info as { frame?: number }).frame = frame;
};

export const backends = [{ webgpu: true }, { webgpu: false }] as const;
export const policies: Policy[] = ['auto', 'per-pass', 'reuse-main'];

// ---- compacted instanced meshes -------------------------------------------------------------------------------------

export type Instanced = InstancedMesh & { visibleIds: number[] };

export interface InstancedRigOptions {
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
export function instancedRig(options: InstancedRigOptions) {
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
export type InstancedRig = ReturnType<typeof instancedRig>;

/** The ids a pass drew from a mesh: the rows three would bind (FakeDraw.instanceRows), mapped back through their translation. */
export function instancedIds(r: InstancedRig, pass: FakePass, mesh: Instanced, label: string): number[] {
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
export function expectInstancedPasses(r: InstancedRig, label: string): void {
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
