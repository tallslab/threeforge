import {
  type BatchedMesh,
  Box3,
  BoxGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  type Sphere,
  Vector3,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { CulledInstancedMesh } from '../../src/compiler/instancing.js';
import { World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';
import { webglRenderer } from './helpers/renderers.js';

const box = new BoxGeometry(1, 1, 1);
const dodeca = new DodecahedronGeometry(0.5);
const cylinder = new CylinderGeometry(0.4, 0.4, 1, 8);
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
  const single = tag.static(
    new Mesh(box, new MeshStandardMaterial({ color: 0x999999, roughness: 0.1, metalness: 0.9 })),
  );
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
    const handle = (
      world as unknown as { cullingHandles: Map<BatchedMesh, { move(id: number): void }> }
    ).cullingHandles.get(batch)!;
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
    const single = tag.static(
      new Mesh(dodeca, new MeshStandardMaterial({ color: 0x999999, roughness: 0.1, metalness: 0.9 })),
    );
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
  /** A camera looking straight down at (x, 0, 0), as three's whole-object culling sees it. */
  function frustumAt(x: number): Frustum {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(x, 10, 0);
    camera.lookAt(x, 0, 0);
    camera.updateMatrixWorld();
    return new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
  }

  function expectInside(box: Box3 | null, sphere: Sphere | null, moved: Box3, label: string): void {
    expect(
      box!.containsBox(moved),
      `${label}: bounding box ${JSON.stringify(box)} holds ${JSON.stringify(moved)}`,
    ).toBe(true);
    for (const x of [moved.min.x, moved.max.x]) {
      for (const y of [moved.min.y, moved.max.y]) {
        for (const z of [moved.min.z, moved.max.z])
          expect(sphere!.distanceToPoint(new Vector3(x, y, z)), `${label}: bounding sphere`).toBeLessThanOrEqual(1e-4);
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
    mesh.onBeforeRender(webglRenderer as never, scene, camera, mesh.geometry, mesh.material as never, null as never);
    expect(mesh.levels[0]!.count + mesh.levels[1]!.count).toBe(1);
    meshes[3]!.position.x = 500;
    expect(world.markDirty(meshes[3]!)).toBe(1);
    const rest = new Box3();
    for (const m of meshes.slice(0, 3)) rest.expandByObject(m, true);
    for (const level of mesh.levels) {
      expectInside(
        level.boundingBox,
        level.boundingSphere,
        new Box3().setFromObject(meshes[3]!, true),
        `level ${level.lodLevel}`,
      );
      expect(level.boundingBox!.containsBox(rest), `level ${level.lodLevel} still holds the undrawn instances`).toBe(
        true,
      );
      expect(frustumAt(500).intersectsObject(level), `level ${level.lodLevel} in view at x = 500`).toBe(true);
    }
    const refresh = vi.spyOn(mesh.forgeCulling, 'refreshBounds');
    world.markDirty(scene); // all four instances, one refresh
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('World.markDirty with originals: "detach"', () => {
  /**
   * A translated, scaled scene: two direct-child statics (former parent is the scene itself), and a transformed
   * `group` holding two nested-batched statics and four nested statics repeated enough to instance.
   */
  function detachedScene() {
    const scene = new Scene();
    scene.position.set(10, -3, 4);
    scene.scale.set(2, 1, 3);
    const direct = [0, 1].map((i) => {
      const m = tag.static(new Mesh(box, solid(0x223344)));
      m.name = `direct-${i}`;
      m.position.set(i * 3, 0, 0);
      scene.add(m);
      return m;
    });
    const group = new Group();
    group.name = 'group';
    group.position.set(1, 2, -1);
    group.rotation.y = 0.4;
    scene.add(group);
    // A distinct geometry from `direct` and `nestedInstanced`, so it forms its own small BatchedMesh: the compiler
    // groups by geometry signature first (colour alone folds into per-instance colour on a shared geometry).
    const nestedBatched = [0, 1].map((i) => {
      const m = tag.static(new Mesh(cylinder, solid(0x556677)));
      m.name = `nested-batched-${i}`;
      m.position.set(i * 2, 1, 0);
      group.add(m);
      return m;
    });
    const nestedInstanced = Array.from({ length: 4 }, (_, i) => {
      const m = tag.static(new Mesh(dodeca, solid(0x2244ff)));
      m.name = `nested-instanced-${i}`;
      m.position.set(i * 1.5, -1, 0);
      group.add(m);
      return m;
    });
    scene.updateMatrixWorld(true);
    return { scene, group, direct, nestedBatched, nestedInstanced };
  }

  /** Generous enough to keep every instance in `detachedScene()`'s small world region visible, whatever the test moves. */
  function wideCamera(): PerspectiveCamera {
    const camera = new PerspectiveCamera(170, 1, 0.1, 2000);
    camera.position.set(18, 500, 5);
    camera.lookAt(18, 0, 5);
    camera.updateMatrixWorld();
    return camera;
  }

  /** What three draws for master instance `id` after a cull pass, or null when it is not drawn. */
  function instancedWorld(
    mesh: CulledInstancedMesh,
    id: number,
    scene: Scene,
    camera: PerspectiveCamera,
  ): Matrix4 | null {
    mesh.onBeforeRender(webglRenderer as never, scene, camera, mesh.geometry, mesh.material as never, null as never);
    const k = mesh.visibleIds.indexOf(id);
    if (k < 0) return null;
    const row = new Matrix4();
    mesh.getMatrixAt(k, row);
    return new Matrix4().multiplyMatrices(mesh.matrixWorld, row);
  }

  /** What `mesh`'s `matrixWorld` would be if it were still parented under `formerParent` (its own local matrix recomposed). */
  function expectedDetachedWorld(mesh: Object3D, formerParent: Object3D): Matrix4 {
    formerParent.updateMatrixWorld(true);
    mesh.updateMatrix();
    return new Matrix4().multiplyMatrices(formerParent.matrixWorld, mesh.matrix);
  }

  it('rewrites a detached direct child of the translated, scaled scene to its former scene-relative transform', () => {
    const { scene, direct } = detachedScene();
    const world = new World(scene, { originals: 'detach' });
    world.compile();
    expect(direct[0]!.parent).toBeNull();
    const slot = world.slotOf(direct[0]!)!;
    const batch = slot.batch as BatchedMesh;
    direct[0]!.position.x += 5;
    direct[0]!.rotation.z = 0.6;
    expect(world.markDirty(direct[0]!)).toBe(1);
    scene.updateMatrixWorld();
    const m = new Matrix4();
    batch.getMatrixAt(slot.instanceId, m);
    const drawn = new Matrix4().multiplyMatrices(batch.matrixWorld, m);
    const expected = expectedDetachedWorld(direct[0]!, scene);
    drawn.elements.forEach((e, i) => expect(e).toBeCloseTo(expected.elements[i]!, 3));
  });

  it('rewrites a detached nested original (scene, a transformed group, then the mesh) to its former scene-relative transform: batched and instanced', () => {
    const { scene, group, nestedBatched, nestedInstanced } = detachedScene();
    const world = new World(scene, { originals: 'detach', instanceThreshold: 4 });
    world.compile();
    expect(nestedBatched[0]!.parent).toBeNull();
    expect(nestedInstanced[0]!.parent).toBeNull();

    const batchSlot = world.slotOf(nestedBatched[0]!)!;
    const batch = batchSlot.batch as BatchedMesh;
    nestedBatched[0]!.position.y += 4;
    expect(world.markDirty(nestedBatched[0]!)).toBe(1);
    scene.updateMatrixWorld();
    const m = new Matrix4();
    batch.getMatrixAt(batchSlot.instanceId, m);
    const drawnBatched = new Matrix4().multiplyMatrices(batch.matrixWorld, m);
    const expectedBatched = expectedDetachedWorld(nestedBatched[0]!, group);
    drawnBatched.elements.forEach((e, i) => expect(e).toBeCloseTo(expectedBatched.elements[i]!, 3));

    const instSlot = world.slotOf(nestedInstanced[0]!)!;
    const instanced = instSlot.batch as CulledInstancedMesh;
    nestedInstanced[0]!.position.z += 3;
    expect(world.markDirty(nestedInstanced[0]!)).toBe(1);
    scene.updateMatrixWorld();
    const drawnInstanced = instancedWorld(instanced, instSlot.instanceId, scene, wideCamera());
    expect(drawnInstanced, 'instanced original is drawn').not.toBeNull();
    const expectedInstanced = expectedDetachedWorld(nestedInstanced[0]!, group);
    drawnInstanced!.elements.forEach((e, i) => expect(e).toBeCloseTo(expectedInstanced.elements[i]!, 3));
  });

  it('markDirty on the former parent rewrites its detached descendants (batched and instanced), using the parent’s current transform', () => {
    const { scene, group, nestedBatched, nestedInstanced } = detachedScene();
    const world = new World(scene, { originals: 'detach', instanceThreshold: 4 });
    world.compile();
    group.position.x += 6; // the former parent itself moves; the originals' own local matrices are untouched
    const batchSlot = world.slotOf(nestedBatched[1]!)!;
    const instSlot = world.slotOf(nestedInstanced[1]!)!;

    const updated = world.markDirty(group);
    expect(updated).toBe(nestedBatched.length + nestedInstanced.length);

    scene.updateMatrixWorld();
    const batch = batchSlot.batch as BatchedMesh;
    const m = new Matrix4();
    batch.getMatrixAt(batchSlot.instanceId, m);
    const drawnBatched = new Matrix4().multiplyMatrices(batch.matrixWorld, m);
    const expectedBatched = expectedDetachedWorld(nestedBatched[1]!, group);
    drawnBatched.elements.forEach((e, i) => expect(e).toBeCloseTo(expectedBatched.elements[i]!, 3));

    const instanced = instSlot.batch as CulledInstancedMesh;
    const drawnInstanced = instancedWorld(instanced, instSlot.instanceId, scene, wideCamera());
    expect(drawnInstanced, 'instanced original is drawn').not.toBeNull();
    const expectedInstanced = expectedDetachedWorld(nestedInstanced[1]!, group);
    drawnInstanced!.elements.forEach((e, i) => expect(e).toBeCloseTo(expectedInstanced.elements[i]!, 3));
  });

  it('keeps a detached original’s composed world matrix through an unforced updateMatrixWorld(), so a detached child composed from it lands right', () => {
    const scene = new Scene();
    scene.position.set(10, -3, 4);
    scene.scale.set(2, 1, 3);
    // App-frozen statics (matrixAutoUpdate off), each holding a static child: both levels are batched and detached.
    const parents = [0, 1].map((i) => {
      const m = tag.static(new Mesh(box, solid(0x223344)));
      m.name = `parent-${i}`;
      m.position.set(i * 4, 0, 0);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      scene.add(m);
      return m;
    });
    const children = parents.map((p, i) => {
      const c = tag.static(new Mesh(cylinder, solid(0x556677)));
      c.name = `child-${i}`;
      c.position.set(0, 2, 0);
      p.add(c);
      return c;
    });
    scene.updateMatrixWorld(true);
    const world = new World(scene, { originals: 'detach' });
    world.compile();
    const parent = parents[0]!;
    const child = children[0]!;
    expect([parent.parent, child.parent]).toEqual([null, null]);

    parent.position.x += 5;
    world.markDirty(parent);
    const expectedParent = new Matrix4().multiplyMatrices(scene.matrixWorld, parent.matrix);
    parent.updateMatrixWorld(); // unforced, on the parentless original
    parent.matrixWorld.elements.forEach((e, i) =>
      expect(e, `parent matrixWorld[${i}]`).toBeCloseTo(expectedParent.elements[i]!, 5),
    );

    child.position.z += 1;
    world.markDirty(child); // composed from the detached parent's matrixWorld
    scene.updateMatrixWorld();
    const slot = world.slotOf(child)!;
    const batch = slot.batch as BatchedMesh;
    const row = new Matrix4();
    batch.getMatrixAt(slot.instanceId, row);
    const drawn = new Matrix4().multiplyMatrices(batch.matrixWorld, row);
    child.updateMatrix();
    const expected = new Matrix4().multiplyMatrices(expectedParent, child.matrix);
    drawn.elements.forEach((e, i) => expect(e, `child drawn[${i}]`).toBeCloseTo(expected.elements[i]!, 4));
  });

  it('rebakes a detached, nested, baked original at its former scene-relative place, after markDirty on the module and on its former parent', () => {
    const scene = new Scene();
    scene.position.set(10, -3, 4);
    scene.scale.set(2, 1, 3);
    const group = new Group();
    group.position.set(1, 2, -1);
    group.rotation.y = 0.4;
    scene.add(group);
    const modules = [0, 1, 2].map((i) => {
      const m = tag.static(new Mesh(box, solid(0x808080)));
      m.name = `module-${i}`;
      m.position.x = i;
      group.add(m);
      return m;
    });
    scene.updateMatrixWorld(true);
    const world = new World(scene, { originals: 'detach', bake: true });
    world.compile();
    const baked = world.bakedMeshes[0]!;
    expect(modules[0]!.parent).toBeNull();

    const expectPlaced = (label: string): void => {
      scene.updateMatrixWorld();
      const index = baked.geometry.index!;
      const position = baked.geometry.getAttribute('position');
      const drawn = new Box3();
      const v = new Vector3();
      for (let t = 0; t < index.count / 3; t++) {
        if (world.resolve({ object: baked, faceIndex: t } as never) !== modules[0]) continue;
        for (let k = 0; k < 3; k++)
          drawn.expandByPoint(v.fromBufferAttribute(position, index.getX(t * 3 + k)).applyMatrix4(baked.matrixWorld));
      }
      modules[0]!.updateMatrix();
      const expected = new Box3()
        .setFromBufferAttribute(box.getAttribute('position') as never)
        .applyMatrix4(new Matrix4().multiplyMatrices(group.matrixWorld, modules[0]!.matrix));
      expect(drawn.isEmpty(), `${label}: module 0 has faces in the bake`).toBe(false);
      for (const corner of ['min', 'max'] as const) {
        for (const axis of ['x', 'y', 'z'] as const)
          expect(drawn[corner][axis], `${label}: ${corner}.${axis}`).toBeCloseTo(expected[corner][axis], 4);
      }
    };
    modules[0]!.position.y += 2;
    expect(world.markDirty(modules[0]!)).toBe(1);
    expectPlaced('markDirty on the module');
    group.position.x += 3;
    expect(world.markDirty(group)).toBe(3);
    expectPlaced('markDirty on the former parent');
  });
});
