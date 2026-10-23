import {
  BatchedMesh,
  Box3,
  BoxGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLCoordinateSystem,
} from 'three';
import { describe, expect, it } from 'vitest';
import { attachBvhCulling } from '../../src/compiler/culling.js';
import { frustumCull, InstanceBvh } from '../../src/compiler/instanceBvh.js';
import { createCulledInstancedMesh } from '../../src/compiler/instancing.js';
import { PassTracker } from '../../src/compiler/passTracker.js';
import { World } from '../../src/compiler/World.js';
import { Streamer } from '../../src/streaming/Streamer.js';
import { tag } from '../../src/tags.js';
import { mulberry32 } from '../../test/scenes/naive.js';
import { bytesPerCall } from './helpers/allocations.js';
import { webglRenderer } from './helpers/renderers.js';

/**
 * Bytes per call that count as nothing: V8's own work when the optimiser finishes during the measured loop lands on
 * whatever function is running, up to about 1.5 bytes on a loaded machine. The smallest object these paths could
 * regain, a stats object per update, is 40.
 */
const NOTHING = 8;

const box = new BoxGeometry(1, 1, 1);
box.computeBoundingBox();

/** Two cameras over the same field, looking different ways, so every call has a new view to cull for. */
function cameras(): [PerspectiveCamera, PerspectiveCamera] {
  const make = (x: number) => {
    const camera = new PerspectiveCamera(60, 1.5, 0.1, 300);
    camera.position.set(0, 2, 0);
    camera.lookAt(x, 1, 50);
    camera.updateMatrixWorld();
    return camera;
  };
  return [make(100), make(-100)];
}

/** Instance positions scattered over a square of `area`. */
function scatter(count: number, area = 600): Matrix4[] {
  const rng = mulberry32(9);
  return Array.from({ length: count }, () =>
    new Matrix4().makeTranslation(rng() * area - area / 2, 1, rng() * area - area / 2),
  );
}

describe('per-frame allocations', () => {
  it('culls a BVH frustum in the order bvh.js does, allocating nothing', async () => {
    const matrices = scatter(500);
    const boxes = matrices.map((m) => box.boundingBox!.clone().applyMatrix4(m));
    const tree = new InstanceBvh(WebGLCoordinateSystem, (id) => boxes[id]!);
    tree.build(
      boxes.map((_, i) => i),
      new Box3(),
    );
    const views = cameras().map((c) => new Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse));
    for (const view of views) {
      const theirs: number[] = [];
      const ours: number[] = [];
      tree.bvh.frustumCulling(view.elements, (node) => theirs.push(node.object!));
      frustumCull(tree.bvh, view.elements, (node) => ours.push(node.object!));
      expect(ours.length).toBeGreaterThan(10);
      expect(ours).toEqual(theirs);
    }
    let hits = 0;
    let k = 0;
    const visit = () => {
      hits++;
    };
    expect(await bytesPerCall(() => frustumCull(tree.bvh, views[k++ & 1]!.elements, visit))).toBeLessThan(NOTHING);
    expect(hits).toBeGreaterThan(0);
  });

  it('a sorted BatchedMesh cull allocates nothing per frame', async () => {
    const matrices = scatter(400);
    const material = new MeshStandardMaterial({ transparent: true });
    const batch = new BatchedMesh(400, box.attributes.position!.count, box.index!.count, material);
    const id = batch.addGeometry(box);
    for (const m of matrices) batch.setMatrixAt(batch.addInstance(id), m);
    batch.computeBoundingSphere();
    attachBvhCulling(batch, WebGLCoordinateSystem);
    const pair = cameras();
    const scene = new Scene();
    let k = 0;
    const cull = () =>
      batch.onBeforeRender(webglRenderer as never, scene, pair[k++ & 1]!, batch.geometry, material, null as never);
    cull();
    expect((batch as unknown as { _multiDrawCount: number })._multiDrawCount).toBeGreaterThan(10);
    expect(await bytesPerCall(cull)).toBeLessThan(NOTHING);
  });

  it('a culled InstancedMesh cull allocates nothing per frame', async () => {
    const instanced = createCulledInstancedMesh(
      box,
      new MeshStandardMaterial(),
      scatter(400),
      null,
      WebGLCoordinateSystem,
    );
    const pair = cameras();
    const scene = new Scene();
    let k = 0;
    const cull = () =>
      instanced.onBeforeRender(
        webglRenderer as never,
        scene,
        pair[k++ & 1]!,
        instanced.geometry,
        instanced.material as never,
        null as never,
      );
    cull();
    expect(instanced.count).toBeGreaterThan(10);
    expect(await bytesPerCall(cull)).toBeLessThan(NOTHING);
  });

  it('tracking a frame with a nested pass allocates nothing', async () => {
    // A shadow map renders inside the main pass; culling registers end callbacks on it every frame.
    const tracker = new PassTracker();
    const [main, shadow] = cameras();
    let ended = 0;
    let frames = 0;
    const onEnd = () => {
      ended++;
    };
    const frame = () => {
      frames++;
      tracker.begin(main);
      tracker.begin(shadow);
      tracker.atEnd(onEnd);
      tracker.atEnd(onEnd);
      tracker.end();
      tracker.atEnd(onEnd);
      tracker.end();
    };
    expect(await bytesPerCall(frame)).toBeLessThan(NOTHING);
    expect(ended).toBe(3 * frames);
  });

  it('Streamer.step allocates nothing while no chunk changes', async () => {
    const scene = new Scene();
    for (let c = 0; c < 16; c++) {
      const tile = tag.static(new Mesh(new BoxGeometry(20, 1, 20), new MeshStandardMaterial({ color: c * 4000 })));
      tile.position.set((c % 4) * 20 + 10, 0, Math.floor(c / 4) * 20 + 10);
      scene.add(tile);
    }
    const camera = new PerspectiveCamera(60, 1, 0.1, 30);
    camera.position.set(30, 5, 30);
    camera.updateMatrixWorld();
    const world = new World(scene, { chunkSize: 20 });
    world.compile();
    const streamer = new Streamer({ world, camera });
    streamer.update();
    const before = streamer.stats();
    // Moving within the cell keeps every chunk where it is.
    let k = 0;
    const step = () => {
      camera.position.x = 30 + (k++ & 1);
      camera.updateMatrixWorld();
      streamer.step();
    };
    expect(await bytesPerCall(step)).toBeLessThan(NOTHING);
    expect(streamer.stats()).toEqual(before);
    // update() is step() and then stats(), a new object every call, as it always was.
    expect(streamer.update()).toEqual(before);
    expect(streamer.update()).not.toBe(streamer.update());
    expect(before.resident).toBeLessThan(before.chunks);
  });
});
