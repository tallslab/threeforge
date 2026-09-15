/**
 * PassTracker (render nesting through the scene hooks) and the parts of the stable-prefix culling that need a tracker
 * driven by hand: the LOD of appended ids and restoring the counts after a render that threw.
 */
import { describe, expect, it } from 'vitest';
import { BatchedMesh, BoxGeometry, DirectionalLight, Matrix4, MeshStandardMaterial, PerspectiveCamera, Scene, WebGLCoordinateSystem, type Camera } from 'three';
import { attachBvhCulling, FORGE_HOOK } from '../../src/compiler/culling.js';
import { PassTracker } from '../../src/compiler/passTracker.js';
import { FakeRenderer } from './helpers/fakeRenderer.js';

const box = new BoxGeometry(1, 1, 1);
/** A denser box: a distinct index range (72 indices vs 36), so a LOD level is recognisable by its draw count. */
const denseBox = new BoxGeometry(1, 1, 1, 1, 2, 1);

type BatchInternals = BatchedMesh & {
  _multiDrawCount: number;
  _multiDrawCounts: Int32Array;
  _indirectTexture: { image: { data: Uint32Array } };
  _geometryInfo: { start: number; count: number }[];
};
const internals = (b: BatchedMesh): BatchInternals => b as BatchInternals;

function camera(): PerspectiveCamera {
  const c = new PerspectiveCamera(60, 1, 0.1, 200);
  c.position.set(0, 6, 35);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  return c;
}

function sun(): DirectionalLight {
  const light = new DirectionalLight(0xffffff, 1);
  light.castShadow = true;
  light.position.set(50, 60, 10);
  light.target.position.set(50, 0, 0);
  Object.assign(light.shadow.camera, { left: -50, right: 50, top: 20, bottom: -20, near: 1, far: 200 }).updateProjectionMatrix();
  return light;
}

describe('PassTracker', () => {
  it('tracks depth, the outermost camera, one frame per outermost render and one id per pass', () => {
    const t = new PassTracker();
    const a = camera();
    const b = camera();
    expect([t.depth, t.pass, t.mainCamera]).toEqual([0, 0, null]);
    t.begin(a);
    expect([t.depth, t.frame, t.mainCamera]).toEqual([1, 1, a]);
    const outer = t.pass;
    expect(outer).toBeGreaterThan(0);
    t.begin(b);
    expect([t.depth, t.mainCamera]).toEqual([2, a]);
    expect(t.passAt(1)).toBe(outer);
    const inner = t.pass;
    expect(inner).not.toBe(outer);
    t.end();
    expect(t.passAt(2), 'a closed pass has no id').toBe(0);
    t.begin(b);
    expect([t.pass === inner, t.pass === outer], 'a sibling pass gets a new id').toEqual([false, false]);
    t.end();
    t.end();
    expect([t.depth, t.passAt(1)]).toEqual([0, 0]);
    t.begin(b);
    expect([t.frame, t.mainCamera, t.pass === outer]).toEqual([2, b, false]);
    t.end();
    t.end(); // never below zero
    expect(t.depth).toBe(0);
  });

  it('runs end callbacks when the pass that registered them ends, innermost first, with that depth', () => {
    const t = new PassTracker();
    const calls: string[] = [];
    t.atEnd((depth) => calls.push(`outside:${depth}`));
    expect(calls, 'outside a render a callback runs at once').toEqual(['outside:0']);
    t.begin(camera());
    t.atEnd((depth) => calls.push(`main:${depth}`));
    t.begin(camera());
    t.atEnd((depth) => calls.push(`nested-a:${depth}`));
    t.atEnd((depth) => calls.push(`nested-b:${depth}`));
    expect(calls).toHaveLength(1);
    t.end();
    expect(calls).toEqual(['outside:0', 'nested-b:2', 'nested-a:2']);
    t.end();
    expect(calls).toEqual(['outside:0', 'nested-b:2', 'nested-a:2', 'main:1']);
  });

  it('installs marked scene hooks and removes them again', () => {
    const scene = new Scene();
    const t = new PassTracker();
    const uninstall = t.install(scene);
    for (const name of ['onBeforeRender', 'onAfterRender'] as const) {
      expect(Object.prototype.hasOwnProperty.call(scene, name)).toBe(true);
      expect((scene[name] as unknown as Record<symbol, unknown>)[FORGE_HOOK]).toBe(true);
    }
    const c = camera();
    const renderer = new FakeRenderer({ sceneHooks: true });
    let depthInside = -1;
    scene.onAfterRender = ((original) =>
      function (this: Scene, ...args: Parameters<Scene['onAfterRender']>) {
        depthInside = t.depth;
        original.apply(this, args);
      })(scene.onAfterRender);
    renderer.render(scene, c);
    expect([depthInside, t.depth, t.mainCamera]).toEqual([1, 0, c]);
    uninstall();
    expect(t.mainCamera).toBeNull();
  });

  it('heals a depth left open by a render that threw once a new animation frame starts, running the pending callbacks', () => {
    const t = new PassTracker();
    const c = camera();
    const info = { frame: 7 };
    const calls: number[] = [];
    t.begin(c, { info });
    t.begin(c, { info });
    t.atEnd((depth) => calls.push(depth));
    // No end(): the nested render threw. Another render in the same animation frame still counts as nested.
    t.begin(c, { info });
    expect(t.depth).toBe(3);
    t.end();
    expect(calls).toEqual([]);
    info.frame = 8;
    t.begin(c, { info });
    expect([t.depth, t.frame], 'a new animation frame with a stuck depth starts over at depth 1').toEqual([1, 2]);
    expect(calls, 'the pending callback ran with its own depth').toEqual([2]);
    t.end();
  });
});

describe('stable-prefix culling driven by a PassTracker', () => {
  function rowBatch(xs: number[], extraGeometry = false): { batch: BatchedMesh; g0: number; g1: number } {
    const batch = new BatchedMesh(xs.length, box.attributes.position!.count + denseBox.attributes.position!.count, box.index!.count + denseBox.index!.count, new MeshStandardMaterial());
    const g0 = batch.addGeometry(box);
    const g1 = extraGeometry ? batch.addGeometry(denseBox) : -1;
    const m = new Matrix4();
    for (const x of xs) batch.setMatrixAt(batch.addInstance(g0), m.makeTranslation(x, 0.5, 3));
    batch.computeBoundingSphere();
    batch.updateMatrixWorld();
    return { batch, g0, g1 };
  }

  it('picks the LOD level of an appended id by the main camera distance, not the nested camera', () => {
    const scene = new Scene();
    const main = camera();
    const light = sun();
    scene.add(light, light.target);
    // x = 0: in view. x = 40: 51.6 from the main camera, 60.7 from the sun. x = 80: 86 from the main camera.
    const { batch, g0, g1 } = rowBatch([0, 40, 80], true);
    batch.castShadow = batch.receiveShadow = true;
    scene.add(batch);
    scene.updateMatrixWorld(true);
    const tracker = new PassTracker();
    tracker.install(scene);
    attachBvhCulling(batch, WebGLCoordinateSystem, { nestedPasses: 'per-pass', passes: tracker, lod: { distances: [55], geometryIds: new Map([[g0, [g0, g1]]]) } });
    const renderer = new FakeRenderer({ sceneHooks: true, shadowTrigger: 'first-receiver', record: true, shadowLights: [light] });
    renderer.render(scene, main);
    expect(renderer.passes.map((p) => p.kind)).toEqual(['render', 'shadow']);
    const shadowDraw = renderer.passes[1]!.draws.find((d) => d.object === batch)!;
    expect(shadowDraw.batchIds).toEqual([0, 1, 2]);
    const b = internals(batch);
    // The appended rows stay in the arrays after the pass (only the counts of the prefix are restored).
    const slotOf = (id: number): number => Array.from(b._indirectTexture.image.data.subarray(0, 3)).indexOf(id);
    const geometryOf = (id: number): number => b._geometryInfo.findIndex((info) => info.count === b._multiDrawCounts[slotOf(id)]);
    expect(geometryOf(0), 'x = 0 (35 from the main camera)').toBe(g0);
    expect(geometryOf(1), 'x = 40 (51.6 from the main camera, 60.7 from the sun)').toBe(g0);
    expect(geometryOf(2), 'x = 80 (86 from the main camera)').toBe(g1);
  });

  it('puts the counts back when the tracker heals after a nested render threw', () => {
    const main = camera();
    const light = sun();
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();
    light.shadow.updateMatrices(light);
    const { batch } = rowBatch(Array.from({ length: 101 }, (_, i) => -100 + 2 * i));
    const tracker = new PassTracker();
    attachBvhCulling(batch, WebGLCoordinateSystem, { nestedPasses: 'per-pass', passes: tracker });
    const cull = (c: Camera): void => batch.onBeforeRender({} as never, new Scene(), c, batch.geometry, batch.material as never, null as never);
    const b = internals(batch);
    const info = { frame: 1 };
    tracker.begin(main, { info });
    cull(main);
    const mainCount = b._multiDrawCount;
    const mainCounts = Array.from(b._multiDrawCounts.subarray(0, mainCount));
    expect(mainCounts.every((c) => c > 0) && mainCount > 10).toBe(true);
    tracker.begin(light.shadow.camera, { info });
    cull(light.shadow.camera);
    expect(b._multiDrawCount, 'the shadow pass appended').toBeGreaterThan(mainCount);
    expect(Array.from(b._multiDrawCounts.subarray(0, mainCount)).some((c) => c === 0), 'and zeroed prefix slots').toBe(true);
    // The shadow render throws: neither end() runs. The next animation frame begins.
    info.frame = 2;
    tracker.begin(main, { info });
    expect(b._multiDrawCount).toBe(mainCount);
    expect(Array.from(b._multiDrawCounts.subarray(0, mainCount))).toEqual(mainCounts);
    tracker.end();
  });
});
