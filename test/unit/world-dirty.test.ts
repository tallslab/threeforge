import { describe, expect, it, vi } from 'vitest';
import { Box3, BoxGeometry, DodecahedronGeometry, Frustum, Group, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3, WebGLCoordinateSystem, type BatchedMesh, type Sphere } from 'three';
import { World } from '../../src/compiler/World.js';
import type { CulledInstancedMesh } from '../../src/compiler/instancing.js';
import { tag } from '../../src/tags.js';

const box = new BoxGeometry(1, 1, 1);
const dodeca = new DodecahedronGeometry(0.5);
const solid = (color: number) => new MeshStandardMaterial({ color });

function batchedScene() {
  const scene = new Scene();
  const props = new Group();
  props.name = 'props';
  const a = tag.static(new Mesh(box, solid(0xff0000)));
  const b = tag.static(new Mesh(dodeca, solid(0x00ff00)));
  a.name = 'a';
  b.name = 'b';
  a.position.set(1, 0, 0);
  b.position.set(4, 0, 0);
  props.add(a, b);
  const single = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x999999, roughness: 0.1, metalness: 0.9 })));
  single.name = 'single';
  scene.add(props, single);
  return { scene, props, a, b, single };
}

describe('World.markDirty', () => {
  it('moves a batched original: recomposes matrices, updates the batch matrix and the BVH leaf, returns the count', () => {
    const { scene, props, a } = batchedScene();
    const world = new World(scene);
    world.compile();
    const slot = world.slotOf(a)!;
    const batch = slot.batch as BatchedMesh;
    const handle = (world as unknown as { cullingHandles: Map<BatchedMesh, { move(id: number): void }> }).cullingHandles.get(batch)!;
    const move = vi.spyOn(handle, 'move');
    expect(props.matrixAutoUpdate).toBe(false);
    props.position.x = 10;
    const updated = world.markDirty(props);
    expect(updated).toBe(2);
    expect(a.matrixWorld.elements[12]).toBe(11);
    const m = new Matrix4();
    batch.getMatrixAt(slot.instanceId, m);
    expect(m.elements[12]).toBe(11);
    expect(move).toHaveBeenCalledWith(slot.instanceId);
  });

  it('moves an instanced original through its culling handle and a frozen singleton by itself', () => {
    const scene = new Scene();
    const meshes = Array.from({ length: 4 }, (_, i) => {
      const m = tag.static(new Mesh(box, solid(0x2244ff)));
      m.name = `b-${i}`;
      m.position.set(i * 2, 0, 0);
      scene.add(m);
      return m;
    });
    const single = tag.static(new Mesh(dodeca, new MeshStandardMaterial({ color: 0x999999, roughness: 0.1, metalness: 0.9 })));
    single.name = 'single';
    scene.add(single);
    const world = new World(scene, { instanceThreshold: 2 });
    world.compile();
    const instanced = world.instancedMeshes[0] as CulledInstancedMesh;
    const setMatrixAt = vi.spyOn(instanced.forgeCulling, 'setMatrixAt');
    meshes[1]!.position.y = 7;
    expect(world.markDirty(meshes[1]!)).toBe(1);
    expect(setMatrixAt).toHaveBeenCalledWith(world.slotOf(meshes[1]!)!.instanceId, meshes[1]!.matrixWorld);
    expect(meshes[1]!.matrixWorld.elements[13]).toBe(7);
    expect(single.matrixAutoUpdate).toBe(false);
    single.position.z = -3;
    expect(world.markDirty(single)).toBe(0);
    expect(single.matrixWorld.elements[14]).toBe(-3);
  });

  it('rebakes a baked group once and notifies onDirty listeners for markDirty and setVisible', () => {
    const { scene, props, a, b } = batchedScene();
    const world = new World(scene, { bake: true });
    world.compile();
    const baked = world.bakedMeshes[0]!;
    const before = Float32Array.from(baked.geometry.getAttribute('position').array);
    const events: string[] = [];
    const off = world.onDirty((e) => events.push(`${e.kind}:${e.object?.name ?? ''}`));
    props.position.y = 5;
    expect(world.markDirty(props)).toBe(2);
    const after = baked.geometry.getAttribute('position').array;
    expect(after).not.toEqual(before);
    world.setVisible(b, false);
    expect(events).toEqual(['markDirty:props', 'setVisible:b']);
    off();
    world.markDirty(a);
    expect(events).toHaveLength(2);
  });
});

describe('World.markDirty bounds', () => {
  const renderer = { coordinateSystem: WebGLCoordinateSystem };

  /** A camera looking straight down at (x, 0, 0), as three's whole-object culling sees it. */
  function frustumAt(x: number): Frustum {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(x, 10, 0);
    camera.lookAt(x, 0, 0);
    camera.updateMatrixWorld();
    return new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  }

  function expectInside(box: Box3 | null, sphere: Sphere | null, moved: Box3, label: string): void {
    expect(box!.containsBox(moved), `${label}: bounding box ${JSON.stringify(box)} holds ${JSON.stringify(moved)}`).toBe(true);
    for (const x of [moved.min.x, moved.max.x]) {
      for (const y of [moved.min.y, moved.max.y]) {
        for (const z of [moved.min.z, moved.max.z]) expect(sphere!.distanceToPoint(new Vector3(x, y, z)), `${label}: bounding sphere`).toBeLessThanOrEqual(1e-4);
      }
    }
  }

  it('recomputes the bounds of a touched batch once, so an instance moved to x = 500 stays inside them and in view', () => {
    const { scene, props, a } = batchedScene();
    const world = new World(scene);
    world.compile();
    scene.updateMatrixWorld();
    const batch = world.slotOf(a)!.batch as BatchedMesh;
    expect(frustumAt(500).intersectsObject(batch)).toBe(false);
    const computeBox = vi.spyOn(batch, 'computeBoundingBox');
    const computeSphere = vi.spyOn(batch, 'computeBoundingSphere');
    a.position.x = 500;
    expect(world.markDirty(props)).toBe(2); // both instances of the batch, one recompute
    expect(computeBox).toHaveBeenCalledTimes(1);
    expect(computeSphere).toHaveBeenCalledTimes(1);
    expectInside(batch.boundingBox, batch.boundingSphere, new Box3().setFromObject(a, true), 'batch');
    expect(frustumAt(500).intersectsObject(batch)).toBe(true);
  });

  it("refreshes an instanced group's bounds on every LOD level from the moved instance, not from the rows it drew", () => {
    const geometry = new BoxGeometry(1, 1, 1);
    geometry.userData.forgeLods = [new BoxGeometry(1, 1, 1)];
    const scene = new Scene();
    const meshes = Array.from({ length: 4 }, (_, i) => {
      const m = tag.static(new Mesh(geometry, solid(0x2244ff)));
      m.name = `lod-${i}`;
      m.position.set(i * 2, 0, 0);
      scene.add(m);
      return m;
    });
    const world = new World(scene, { instanceThreshold: 2, lod: { distances: [50] } });
    world.compile();
    scene.updateMatrixWorld();
    const mesh = world.instancedMeshes[0] as CulledInstancedMesh;
    expect(mesh.levels).toHaveLength(2);
    // A narrow camera over instance 0: the rows then hold fewer instances than the group.
    const camera = new PerspectiveCamera(20, 1, 0.1, 100);
    camera.position.set(0, 5, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    mesh.onBeforeRender(renderer as never, scene, camera, mesh.geometry, mesh.material as never, null as never);
    expect(mesh.levels[0]!.count + mesh.levels[1]!.count).toBe(1);
    meshes[3]!.position.x = 500;
    expect(world.markDirty(meshes[3]!)).toBe(1);
    const rest = new Box3();
    for (const m of meshes.slice(0, 3)) rest.expandByObject(m, true);
    for (const level of mesh.levels) {
      expectInside(level.boundingBox, level.boundingSphere, new Box3().setFromObject(meshes[3]!, true), `level ${level.lodLevel}`);
      expect(level.boundingBox!.containsBox(rest), `level ${level.lodLevel} still holds the undrawn instances`).toBe(true);
      expect(frustumAt(500).intersectsObject(level), `level ${level.lodLevel} in view at x = 500`).toBe(true);
    }
    const refresh = vi.spyOn(mesh.forgeCulling, 'refreshBounds');
    world.markDirty(scene); // all four instances, one refresh
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
