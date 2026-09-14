import { describe, expect, it } from 'vitest';
import { BatchedMesh, BoxGeometry, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, WebGLCoordinateSystem } from 'three';
import { FORGE_HIDDEN_LAYER, World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';

const box = new BoxGeometry(1, 1, 1);
const solid = (color: number) => new MeshStandardMaterial({ color, roughness: 0.7, metalness: 0 });

/** 4 statics and 1 dynamic sharing one material variant, plus 1 dynamic with a different variant. */
function sceneWithDynamics() {
  const scene = new Scene();
  const statics = [0, 1, 2, 3].map((i) => {
    const m = tag.static(new Mesh(box, solid(0x111111 * (i + 1))));
    m.name = `static-${i}`;
    m.position.set(i * 3, 0, 0);
    return m;
  });
  const mover = tag.dynamic(new Mesh(box, solid(0xff0000)));
  mover.name = 'mover';
  mover.position.set(0, 0, 5);
  const lonely = tag.dynamic(new Mesh(box, new MeshStandardMaterial({ color: 0x00ff00, roughness: 0.1, metalness: 1 })));
  lonely.name = 'lonely';
  scene.add(...statics, mover, lonely);
  return { scene, statics, mover, lonely };
}

function cullWith(batch: BatchedMesh | InstancedMesh, scene: Scene, camera: PerspectiveCamera) {
  batch.onBeforeRender({ coordinateSystem: WebGLCoordinateSystem } as never, scene, camera, batch.geometry, batch.material as never, null as never);
}

function camera() {
  const c = new PerspectiveCamera(60, 1, 0.1, 500);
  c.position.set(5, 5, 30);
  c.lookAt(5, 0, 0);
  c.updateMatrixWorld();
  return c;
}

function batchesIn(scene: Scene): BatchedMesh[] {
  const out: BatchedMesh[] = [];
  scene.traverse((o) => {
    if ((o as BatchedMesh).isBatchedMesh) out.push(o as BatchedMesh);
  });
  return out;
}

describe("World with dynamics: 'batch-sync'", () => {
  it('folds batchable dynamics into the batch and keeps their matrices auto-updating while hidden', () => {
    const { scene, mover, lonely } = sceneWithDynamics();
    const world = new World(scene, { dynamics: 'batch-sync' });
    const report = world.compile();
    const batch = batchesIn(scene)[0]!;
    expect(batch.instanceCount).toBe(5);
    expect(world.slotOf(mover)?.batch).toBe(batch);
    expect(mover.layers.mask).toBe((1 << FORGE_HIDDEN_LAYER) >>> 0);
    expect(mover.matrixAutoUpdate).toBe(true);
    expect(batch.frustumCulled).toBe(false);
    expect(report.after).toEqual({ batches: 1, instanced: 0, baked: 0, spriteBatches: 0, frozen: 0, meshes: 1 });
    expect(report.skipped.map((s) => s.name)).toEqual(['lonely']);
    expect(report.synced).toBe(1);
    expect(lonely.layers.mask).toBe(1);
  });

  it('keeps the default (separate) behaviour unless asked', () => {
    const { scene, mover } = sceneWithDynamics();
    new World(scene).compile();
    expect(batchesIn(scene)[0]!.instanceCount).toBe(4);
    expect(mover.layers.mask).toBe(1);
  });

  it('copies a moved dynamic into the batch on the next cull and moves its BVH leaf', () => {
    const { scene, mover } = sceneWithDynamics();
    const world = new World(scene, { dynamics: 'batch-sync' });
    world.compile();
    const batch = batchesIn(scene)[0]!;
    const cam = camera();
    const slot = world.slotOf(mover)!;
    cullWith(batch, scene, cam);
    const drawnBefore = (batch as unknown as { _multiDrawCount: number })._multiDrawCount;
    expect(drawnBefore).toBe(5);

    mover.position.set(0, 0, -5000); // far behind everything
    scene.updateMatrixWorld(true);
    cullWith(batch, scene, cam);
    const m = new Matrix4();
    batch.getMatrixAt(slot.instanceId, m);
    m.elements.forEach((e, i) => expect(e).toBeCloseTo(mover.matrixWorld.elements[i]!, 4));
    expect((batch as unknown as { _multiDrawCount: number })._multiDrawCount).toBe(4);

    mover.position.set(0, 0, 5);
    scene.updateMatrixWorld(true);
    cullWith(batch, scene, cam);
    expect((batch as unknown as { _multiDrawCount: number })._multiDrawCount).toBe(5);
  });

  it('does not touch the matrices texture when nothing moved', () => {
    const { scene } = sceneWithDynamics();
    const world = new World(scene, { dynamics: 'batch-sync' });
    world.compile();
    const batch = batchesIn(scene)[0]!;
    const cam = camera();
    cullWith(batch, scene, cam);
    // `needsUpdate` is a write-only setter that bumps `version`; observe the version instead.
    const texture = (batch as unknown as { _matricesTexture: { version: number } })._matricesTexture;
    const version = texture.version;
    cullWith(batch, scene, cam);
    expect(texture.version).toBe(version);
  });

  it('leaves dynamics that break batch rules (renderOrder, layers, hooks) as separate meshes', () => {
    const { scene, mover } = sceneWithDynamics();
    mover.renderOrder = 2;
    const world = new World(scene, { dynamics: 'batch-sync' });
    const report = world.compile();
    expect(batchesIn(scene)[0]!.instanceCount).toBe(4);
    expect(mover.layers.mask).toBe(1);
    expect(report.skipped).toContainEqual({ name: 'mover', rule: 'render-order' });
  });

  it('decompile restores synced dynamics like any other original', () => {
    const { scene, mover } = sceneWithDynamics();
    const world = new World(scene, { dynamics: 'batch-sync' });
    world.compile();
    world.decompile();
    expect(mover.layers.mask).toBe(1);
    expect(mover.matrixAutoUpdate).toBe(true);
    expect(batchesIn(scene)).toHaveLength(0);
  });
});

describe('World.setVisible', () => {
  it('toggles batched originals through setVisibleAt and plain meshes through visible', () => {
    const { scene, statics, lonely } = sceneWithDynamics();
    const world = new World(scene);
    world.compile();
    const batch = batchesIn(scene)[0]!;
    const slot = world.slotOf(statics[1]!)!;
    world.setVisible(statics[1]!, false);
    expect(batch.getVisibleAt(slot.instanceId)).toBe(false);
    world.setVisible(statics[1]!, true);
    expect(batch.getVisibleAt(slot.instanceId)).toBe(true);
    world.setVisible(lonely, false);
    expect(lonely.visible).toBe(false);
  });

  it('hides instanced originals from the compacted draw', () => {
    const scene = new Scene();
    const meshes = Array.from({ length: 70 }, (_, i) => {
      const m = tag.static(new Mesh(box, solid(0x2244ff)));
      m.name = `inst-${i}`;
      m.position.set((i % 10) * 2, 0, Math.floor(i / 10) * 2);
      return m;
    });
    scene.add(...meshes);
    const world = new World(scene);
    world.compile();
    const instanced = world.instancedMeshes[0]!;
    const cam = new PerspectiveCamera(60, 1, 0.1, 500);
    cam.position.set(9, 40, 9);
    cam.lookAt(9, 0, 9);
    cam.updateMatrixWorld();
    cullWith(instanced, scene, cam);
    expect(instanced.count).toBe(70);
    world.setVisible(meshes[5]!, false);
    cullWith(instanced, scene, cam);
    expect(instanced.count).toBe(69);
    expect(world.resolve({ object: instanced, instanceId: 5 } as never).name).not.toBe(meshes[5]!.name);
  });
});
