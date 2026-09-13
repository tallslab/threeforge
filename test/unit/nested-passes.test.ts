import { describe, expect, it } from 'vitest';
import { BatchedMesh, BoxGeometry, Color, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, WebGLCoordinateSystem, WebGPUCoordinateSystem } from 'three';
import { attachBvhCulling } from '../../src/compiler/culling.js';
import { createCulledInstancedMesh } from '../../src/compiler/instancing.js';
import { World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';
import { mulberry32 } from '../../test/scenes/naive.js';

const box = new BoxGeometry(1, 1, 1);
const renderer = { coordinateSystem: WebGLCoordinateSystem };

function cameras() {
  const main = new PerspectiveCamera(60, 1.5, 0.1, 300);
  main.position.set(0, 2, 0);
  main.lookAt(100, 1, 0);
  main.updateMatrixWorld();
  const mirror = main.clone();
  mirror.rotateY(Math.PI); // looks the other way: a different visible set
  mirror.updateMatrixWorld();
  return { main, mirror };
}

function batchField(count: number): BatchedMesh {
  const rng = mulberry32(3);
  const batch = new BatchedMesh(count, box.attributes.position!.count, box.index!.count, new MeshStandardMaterial());
  const id = batch.addGeometry(box);
  const m = new Matrix4();
  for (let i = 0; i < count; i++) {
    batch.setMatrixAt(batch.addInstance(id), m.makeTranslation(rng() * 2000 - 1000, 1, rng() * 2000 - 1000));
  }
  batch.computeBoundingSphere();
  return batch;
}

const drawn = (b: BatchedMesh) => {
  const x = b as unknown as { _multiDrawCount: number; _indirectTexture: { image: { data: Uint32Array } } };
  return Array.from(x._indirectTexture.image.data.subarray(0, x._multiDrawCount)).sort((p, q) => p - q);
};
const cull = (b: BatchedMesh, camera: PerspectiveCamera) => b.onBeforeRender(renderer as never, new Scene(), camera, b.geometry, b.material as never, null as never);

describe("nested passes: 'reuse-main' (batched)", () => {
  it('leaves the main list untouched for a nested camera and draws nothing before the first main cull', () => {
    const { main, mirror } = cameras();
    const batch = batchField(3000);
    let current: PerspectiveCamera | null = null;
    attachBvhCulling(batch, WebGLCoordinateSystem, { nestedPasses: 'reuse-main', mainCamera: () => current });
    current = main;
    cull(batch, mirror); // nested pass before any main pass in this frame
    expect(drawn(batch)).toEqual([]);
    cull(batch, main);
    const mainList = drawn(batch);
    expect(mainList.length).toBeGreaterThan(10);
    cull(batch, mirror); // next frame's nested pass reuses the main list
    expect(drawn(batch)).toEqual(mainList);
    cull(batch, main);
    expect(drawn(batch)).toEqual(mainList);
  });

  it("culls per pass under 'per-pass' (the default)", () => {
    const { main, mirror } = cameras();
    const batch = batchField(3000);
    attachBvhCulling(batch, WebGLCoordinateSystem, { mainCamera: () => main });
    cull(batch, main);
    const mainList = drawn(batch);
    cull(batch, mirror);
    expect(drawn(batch)).not.toEqual(mainList);
  });
});

describe("nested passes: 'reuse-main' (instanced)", () => {
  it('keeps the main compaction for nested cameras', () => {
    const { main, mirror } = cameras();
    const rng = mulberry32(5);
    const matrices = Array.from({ length: 2000 }, () => new Matrix4().makeTranslation(rng() * 2000 - 1000, 1, rng() * 2000 - 1000));
    let current: PerspectiveCamera | null = null;
    const mesh = createCulledInstancedMesh(box, new MeshStandardMaterial(), matrices, null, WebGLCoordinateSystem, { nestedPasses: 'reuse-main', mainCamera: () => current });
    const run = (c: PerspectiveCamera) => mesh.onBeforeRender(renderer as never, new Scene(), c, mesh.geometry, mesh.material as never, null as never);
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

describe('World nestedPasses option', () => {
  it("defaults to 'reuse-main' on WebGPU and 'per-pass' on WebGL, and tracks the main camera through the scene hooks", () => {
    const scene = new Scene();
    for (let i = 0; i < 4; i++) scene.add(tag.static(new Mesh(box, new MeshStandardMaterial({ color: new Color(i * 0x111111) }))));
    const a = new World(scene);
    expect(a.compile({ coordinateSystem: WebGPUCoordinateSystem }).nestedPasses).toBe('reuse-main');
    a.decompile();
    const b = new World(scene);
    expect(b.compile({ coordinateSystem: WebGLCoordinateSystem }).nestedPasses).toBe('per-pass');
    b.decompile();
    const { main, mirror } = cameras();
    const w = new World(scene, { nestedPasses: 'reuse-main' });
    w.compile();
    expect(w.mainCamera).toBeNull();
    scene.onBeforeRender(renderer as never, scene, main, null as never, null as never, null as never);
    scene.onBeforeRender(renderer as never, scene, mirror, null as never, null as never, null as never); // nested
    expect(w.mainCamera).toBe(main);
    scene.onAfterRender(renderer as never, scene, mirror, null as never, null as never, null as never);
    scene.onAfterRender(renderer as never, scene, main, null as never, null as never, null as never);
    w.decompile();
    expect(Object.prototype.hasOwnProperty.call(scene, 'onBeforeRender')).toBe(false);
  });
});
