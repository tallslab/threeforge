import { describe, expect, it } from 'vitest';
import { BatchedMesh, BoxGeometry, InstancedMesh, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, TorusKnotGeometry, WebGLCoordinateSystem } from 'three';
import { World } from '../../src/compiler/World.js';
import type { CulledInstancedMesh } from '../../src/compiler/instancing.js';
import { lodsOf, prepareLods } from '../../src/lod/generateLods.js';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer } from './helpers/fakeRenderer.js';

const solid = (color: number) => new MeshStandardMaterial({ color, roughness: 0.7, metalness: 0 });

function cull(object: BatchedMesh | InstancedMesh, scene: Scene, camera: PerspectiveCamera) {
  object.onBeforeRender({ coordinateSystem: WebGLCoordinateSystem } as never, scene, camera, object.geometry, object.material as never, null as never);
}

function cameraAtOrigin() {
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();
  return camera;
}

describe('World lod (batched path)', () => {
  it('draws each instance with the LOD level chosen by its distance to the camera', async () => {
    const scene = new Scene();
    const knot = new TorusKnotGeometry(1, 0.3, 64, 12);
    const distances = [10, 100, 220];
    const meshes = distances.map((z, i) => {
      const m = tag.static(new Mesh(knot, solid(0x101010 * (i + 1))));
      m.name = `knot-${i}`;
      m.position.set(0, 0, -z);
      scene.add(m);
      return m;
    });
    await prepareLods(scene, { ratios: [0.5, 0.2] });
    const lods = lodsOf(knot);
    const world = new World(scene, { lod: { distances: [50, 150] } });
    const report = world.compile();
    expect(report.groups[0]).toMatchObject({ kind: 'batched', lods: 2 });
    const batch = scene.children.find((o) => (o as BatchedMesh).isBatchedMesh) as BatchedMesh;
    cull(batch, scene, cameraAtOrigin());
    const b = batch as unknown as { _multiDrawCount: number; _multiDrawCounts: Int32Array; _indirectTexture: { image: { data: Uint32Array } } };
    expect(b._multiDrawCount).toBe(3);
    const countFor = (mesh: Mesh) => {
      const id = world.slotOf(mesh)!.instanceId;
      const k = Array.from(b._indirectTexture.image.data.subarray(0, 3)).indexOf(id);
      return b._multiDrawCounts[k];
    };
    expect(countFor(meshes[0]!)).toBe(knot.index!.count);
    expect(countFor(meshes[1]!)).toBe(lods[0]!.index!.count);
    expect(countFor(meshes[2]!)).toBe(lods[1]!.index!.count);
  });

  it('renders geometries without LODs at full detail at any distance', async () => {
    const scene = new Scene();
    const knot = new TorusKnotGeometry(1, 0.3, 64, 12);
    const box = new BoxGeometry(2, 2, 2);
    const far = tag.static(new Mesh(knot, solid(1)));
    far.position.set(0, 0, -300);
    const farBox = tag.static(new Mesh(box, solid(1)));
    farBox.position.set(3, 0, -300);
    scene.add(far, farBox);
    knot.userData.forgeLods = await (await import('../../src/lod/generateLods.js')).generateLods(knot, { ratios: [0.2] });
    const world = new World(scene, { lod: { distances: [50] } });
    world.compile();
    const batch = scene.children.find((o) => (o as BatchedMesh).isBatchedMesh) as BatchedMesh;
    cull(batch, scene, cameraAtOrigin());
    const b = batch as unknown as { _multiDrawCounts: Int32Array; _indirectTexture: { image: { data: Uint32Array } } };
    const ids = Array.from(b._indirectTexture.image.data.subarray(0, 2));
    const boxK = ids.indexOf(world.slotOf(farBox)!.instanceId);
    expect(b._multiDrawCounts[boxK]).toBe(box.index!.count);
  });
});

describe('World lod (instanced path)', () => {
  async function instancedScene() {
    const scene = new Scene();
    const box = new BoxGeometry(1, 1, 1, 4, 4, 4);
    const meshes = Array.from({ length: 70 }, (_, i) => {
      const m = tag.static(new Mesh(box, solid(0x2244ff)));
      m.name = `b-${i}`;
      m.position.set(0, 0, -(i * 2 + 1)); // z = -1 .. -139 straight ahead
      scene.add(m);
      return m;
    });
    await prepareLods(scene, { ratios: [0.5] });
    return { scene, meshes, box };
  }

  it('splits visible instances across one InstancedMesh per level by distance', async () => {
    const { scene, box } = await instancedScene();
    const world = new World(scene, { lod: { distances: [30] } });
    const report = world.compile();
    expect(report.after).toEqual({ batches: 0, instanced: 2, baked: 0, spriteBatches: 0, meshes: 0 });
    const levels = world.instancedMeshes;
    expect(levels).toHaveLength(2);
    expect(levels[1]!.geometry).toBe(lodsOf(box)[0]);
    const camera = cameraAtOrigin();
    for (const level of levels) cull(level, scene, camera);
    // z = -1..-29 (15 boxes) are within 30 units; the rest use level 1. All 70 are inside the frustum.
    expect(levels[0]!.count).toBe(15);
    expect(levels[1]!.count).toBe(55);
    expect(levels[0]!.userData.forge).toEqual({ instances: 70, lodLevel: 0 });
    expect(levels[1]!.userData.forge).toEqual({ instances: 0, lodLevel: 1 });
  });

  it('is counted by the ledger as one instanced submission per level with instances tallied once', async () => {
    const { scene } = await instancedScene();
    const renderer = new FakeRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    new World(scene, { lod: { distances: [30] }, ledger }).compile();
    renderer.render(scene, cameraAtOrigin());
    const frame = ledger.frame();
    expect(frame.byReason.instanced?.submissions).toBe(2);
    expect(frame.totals.instances).toBe(70);
    expect(frame.totals.instancesDrawn).toBe(70);
  });

  it('resolves hits on any level and decompiles every level mesh', async () => {
    const { scene, meshes } = await instancedScene();
    const world = new World(scene, { lod: { distances: [30] } });
    world.compile();
    const levels = world.instancedMeshes;
    const camera = cameraAtOrigin();
    for (const level of levels) cull(level, scene, camera);
    // BVH callback order is tree order, not id order: find the compacted slot that holds master 15.
    const k = (levels[1] as CulledInstancedMesh).visibleIds.indexOf(15);
    expect(k).toBeGreaterThanOrEqual(0);
    const hit = { object: levels[1], instanceId: k } as never;
    expect(world.resolve(hit)).toBe(meshes[15]);
    world.decompile();
    expect(scene.children.some((o) => (o as InstancedMesh).isInstancedMesh)).toBe(false);
    expect(scene.children.filter((o) => (o as Mesh).isMesh)).toHaveLength(70);
  });
});
