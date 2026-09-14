import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, DodecahedronGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Scene, type BatchedMesh } from 'three';
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
