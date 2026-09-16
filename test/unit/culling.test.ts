import { describe, expect, it } from 'vitest';
import { BatchedMesh, Box3, BoxGeometry, Frustum, Matrix4, MeshStandardMaterial, PerspectiveCamera, Scene, Sphere, Vector3, WebGLCoordinateSystem } from 'three';
import { attachBvhCulling, FORGE_HOOK } from '../../src/compiler/culling.js';
import { mulberry32 } from '../../test/scenes/naive.js';

const box = new BoxGeometry(1, 1, 1);
const _scratch = new Matrix4();

/** A batch of `count` instances scattered over `area`, plus a camera at ground level seeing a small slice. */
function field(count: number, area = 2000) {
  const rng = mulberry32(3);
  const batch = new BatchedMesh(count, box.attributes.position!.count, box.index!.count, new MeshStandardMaterial());
  const id = batch.addGeometry(box);
  const m = new Matrix4();
  for (let i = 0; i < count; i++) {
    const instance = batch.addInstance(id);
    m.makeTranslation(rng() * area - area / 2, 1, rng() * area - area / 2);
    batch.setMatrixAt(instance, m);
  }
  batch.computeBoundingSphere();
  const camera = new PerspectiveCamera(60, 1.5, 0.1, 300);
  camera.position.set(0, 2, 0);
  camera.lookAt(100, 1, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const renderer = { coordinateSystem: WebGLCoordinateSystem };
  const scene = new Scene();
  const cull = () => batch.onBeforeRender(renderer as never, scene, camera, batch.geometry, batch.material as never, null as never);
  /**
   * The instance ids of the multi-draw list, **in draw order**.
   *
   * This helper used to `.sort()` them before returning, which is the pattern `bossfight-attribution-report.md` §5.2
   * flags: every assertion built on it read as "the same instances were drawn" while proving only "the same set", and
   * draw order is a real part of what a cull produces — a batch with `sortObjects` (three's default, and this one
   * keeps it) must write its slots near-to-far. Returning them unsorted makes the order assertable; the two places
   * that genuinely mean set membership now say so at the call site.
   */
  const drawn = () => {
    const b = batch as unknown as { _multiDrawCount: number; _indirectTexture: { image: { data: Uint32Array } } };
    return Array.from(b._indirectTexture.image.data.subarray(0, b._multiDrawCount));
  };
  /** The sort key three uses for an instance: its bounding-sphere centre along the camera's forward axis. */
  const eye = new Vector3().setFromMatrixPosition(camera.matrixWorld);
  const forward = new Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
  const depthOf = (id: number): number => {
    batch.getMatrixAt(id, _scratch);
    return batch.getBoundingSphereAt(0, new Sphere())!.applyMatrix4(_scratch).center.sub(eye).dot(forward);
  };
  return { batch, camera, cull, drawn, depthOf };
}

/**
 * How many per-instance bounding-sphere tests `run` costs. This is the work a BVH cull exists to avoid and the exact
 * work a cull that stops using its tree multiplies: three's own scan reads one sphere for every instance in the batch,
 * the BVH reads one per candidate leaf its frustum query reaches. Counting it replaces a `performance.now()` guard
 * ("at least twice as fast as the linear scan") whose failure mode was another vitest worker holding the CPU, and
 * which on a fast enough machine would have passed a cull that had quietly become linear (Ruling R97).
 */
function sphereTests(batch: BatchedMesh, run: () => void): number {
  let tests = 0;
  const original = BatchedMesh.prototype.getBoundingSphereAt;
  const own = batch as { getBoundingSphereAt?: BatchedMesh['getBoundingSphereAt'] };
  own.getBoundingSphereAt = function (this: BatchedMesh, ...args: Parameters<BatchedMesh['getBoundingSphereAt']>) {
    tests++;
    return original.apply(this, args);
  };
  try {
    run();
  } finally {
    delete own.getBoundingSphereAt;
  }
  return tests;
}

describe('attachBvhCulling', () => {
  it('draws a subset of what the linear sphere scan draws and never drops an instance fully inside the frustum', () => {
    const f = field(5000);
    f.cull();
    const linear = f.drawn();
    expect(linear.length).toBeGreaterThan(10);
    expect(linear.length).toBeLessThan(5000);
    attachBvhCulling(f.batch, WebGLCoordinateSystem);
    f.cull();
    const bvh = f.drawn();
    // Membership, deliberately: this cell is about *which* instances survive each cull, and the BVH may legitimately
    // draw fewer. The order both lists are written in is the next cell's subject.
    const linearSet = new Set(linear);
    expect(bvh.every((id) => linearSet.has(id))).toBe(true);
    expect(bvh.length).toBeGreaterThanOrEqual(linear.length * 0.98);
    // Ground truth: instances whose world box is entirely inside the frustum must all be drawn.
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(f.camera.projectionMatrix, f.camera.matrixWorldInverse));
    const bvhSet = new Set(bvh);
    const m = new Matrix4();
    const b = new Box3();
    let inside = 0;
    for (let i = 0; i < 5000; i++) {
      f.batch.getMatrixAt(i, m);
      f.batch.getBoundingBoxAt(0, b)!.applyMatrix4(m);
      const corners = [b.min, b.max].flatMap((v) => [v]);
      const fullyInside = [
        [b.min.x, b.min.y, b.min.z], [b.max.x, b.min.y, b.min.z], [b.min.x, b.max.y, b.min.z], [b.max.x, b.max.y, b.min.z],
        [b.min.x, b.min.y, b.max.z], [b.max.x, b.min.y, b.max.z], [b.min.x, b.max.y, b.max.z], [b.max.x, b.max.y, b.max.z],
      ].every(([x, y, z]) => frustum.containsPoint(new Vector3(x, y, z)));
      void corners;
      if (fullyInside) {
        inside++;
        expect(bvhSet.has(i)).toBe(true);
      }
    }
    expect(inside).toBeGreaterThan(0);
  });

  it("writes its slots in three's draw order, not the order its tree visits them", () => {
    const f = field(5000);
    f.cull();
    const linear = f.drawn();
    attachBvhCulling(f.batch, WebGLCoordinateSystem);
    f.cull();
    const bvh = f.drawn();
    // `sortObjects` is three's default and this batch keeps it, so a cull owes the renderer a near-to-far list. The
    // BVH hands its candidates back in tree order, so `cullPlain` has to run three's own depth sort over them before
    // writing the slots. Nothing else in this file could see that: every other assertion compares ids as a set, and
    // until the `drawn()` helper stopped sorting, none of them *could*. A batch drawn out of depth order loses
    // early-z on opaque materials and draws transparent instances in the wrong order -- a picture defect, not a
    // count one, so no submission or instance total moves when it happens.
    for (const [label, ids] of [
      ['three', linear],
      ['bvh', bvh],
    ] as const) {
      const depths = ids.map(f.depthOf);
      const ascending = depths.every((z, i) => i === 0 || depths[i - 1]! <= z);
      expect(ascending, `${label}: drawn near-to-far, first depths ${depths.slice(0, 6).map((z) => z.toFixed(2)).join(', ')}`).toBe(true);
    }
    // And the same order instance for instance over the ids both draw: the BVH rejects a few the linear scan keeps
    // (its exact boxes are tighter than three's spheres), but it may not reshuffle the rest.
    const bvhSet = new Set(bvh);
    expect(linear.filter((id) => bvhSet.has(id))).toEqual(bvh);
  });

  it('marks its hook so the ledger does not report it as a custom hook', () => {
    const f = field(10);
    attachBvhCulling(f.batch, WebGLCoordinateSystem);
    expect(Object.prototype.hasOwnProperty.call(f.batch, 'onBeforeRender')).toBe(true);
    expect((f.batch.onBeforeRender as unknown as Record<symbol, unknown>)[FORGE_HOOK]).toBe(true);
  });

  it('follows instances moved through the handle', () => {
    const f = field(200);
    const handle = attachBvhCulling(f.batch, WebGLCoordinateSystem);
    f.cull();
    const before = f.drawn();
    expect(before.length, 'nothing to move if the cull drew nothing').toBeGreaterThan(0);
    // Move the first drawn instance far behind the camera and re-cull: it must disappear. `drawn()` is in draw order,
    // so this really is the first one drawn -- while the helper sorted, it was whichever had the lowest id.
    const id = before[0]!;
    f.batch.setMatrixAt(id, new Matrix4().makeTranslation(-5000, 1, 0));
    handle.move(id);
    f.cull();
    expect(f.drawn()).not.toContain(id);
  });

  it('tests a small fraction of the 20k instance spheres the linear scan tests, for the same picture', () => {
    const f = field(20_000);
    const linearTests = sphereTests(f.batch, f.cull);
    const linear = f.drawn();
    attachBvhCulling(f.batch, WebGLCoordinateSystem);
    const bvhTests = sphereTests(f.batch, f.cull);
    const bvh = f.drawn();
    console.log(`culling 20k instances: linear ${linearTests} sphere tests, bvh ${bvhTests}`);
    // three's scan reads one sphere per instance, always. That is the cost the tree exists to remove, and the number
    // a cull that stopped using its tree -- a frustum query that visits every leaf, an `attachBvhCulling` that fell
    // back to the prototype hook, a tree built so wide that nothing prunes -- would go straight back to.
    expect(linearTests, "three's scan tests every instance").toBe(20_000);
    expect(bvhTests, `${bvhTests} sphere tests against ${linearTests}`).toBeLessThan(linearTests / 10);
    // Fewer tests only counts if the picture is the same one: a tree that pruned everything would test nothing at
    // all and score best of all.
    const linearSet = new Set(linear);
    expect(bvh.every((id) => linearSet.has(id)), 'drew an instance the linear scan culled').toBe(true);
    expect(bvh.length, `${bvh.length} drawn against ${linear.length}`).toBeGreaterThanOrEqual(linear.length * 0.98);
  });

  it('detaches cleanly, restoring the prototype behaviour', () => {
    const f = field(5000);
    f.cull();
    const linear = f.drawn();
    const handle = attachBvhCulling(f.batch, WebGLCoordinateSystem);
    handle.detach();
    expect(Object.prototype.hasOwnProperty.call(f.batch, 'onBeforeRender')).toBe(false);
    f.cull();
    // Order included, now that `drawn()` keeps it: "restores the prototype behaviour" means the same list, not the
    // same set of ids in some order the BVH left behind.
    expect(f.drawn()).toEqual(linear);
  });
});

describe('attachBvhCulling margin changes what is drawn', () => {
  /**
   * One instance in plain view and one parked just outside a frustum side plane, in the gap where its circumscribing
   * sphere still reaches in but its exact box does not. The BVH prefilters by box and only then applies three's
   * sphere test, so the box prefilter is the tighter of the two: at margin 0 the parked instance is never offered,
   * and widening the boxes hands it back. This is the case a margined tree has to be tested against — a scattered
   * field is not, since there box and sphere agree on almost every instance.
   */
  function parked(margin: number) {
    const batch = new BatchedMesh(2, box.attributes.position!.count, box.index!.count, new MeshStandardMaterial());
    const id = batch.addGeometry(box);
    const inView = batch.addInstance(id);
    batch.setMatrixAt(inView, new Matrix4().makeTranslation(0, 0, -10));
    const outside = batch.addInstance(id);
    batch.setMatrixAt(outside, new Matrix4().makeTranslation(-11.1, 0, -10));
    batch.computeBoundingSphere();
    const camera = new PerspectiveCamera(90, 1, 0.1, 100);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const handle = attachBvhCulling(batch, WebGLCoordinateSystem, margin > 0 ? { margin } : {});
    batch.onBeforeRender({ coordinateSystem: WebGLCoordinateSystem } as never, new Scene(), camera, batch.geometry, batch.material as never, null as never);
    const b = batch as unknown as { _multiDrawCount: number; _indirectTexture: { image: { data: Uint32Array } } };
    return { batch, camera, handle, outside, drawn: Array.from(b._indirectTexture.image.data.subarray(0, b._multiDrawCount)) };
  }

  it('leaves out an instance whose sphere meets the frustum but whose exact box does not, and a margin draws it', () => {
    const none = parked(0);
    // The precondition, checked with three's own maths rather than assumed.
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(none.camera.projectionMatrix, none.camera.matrixWorldInverse));
    const matrix = new Matrix4();
    none.batch.getMatrixAt(none.outside, matrix);
    const sphere = none.batch.getBoundingSphereAt(0, new Sphere())!.clone().applyMatrix4(matrix);
    const exact = none.batch.getBoundingBoxAt(0, new Box3())!.clone().applyMatrix4(matrix);
    expect(frustum.intersectsSphere(sphere), "the parked instance's sphere reaches into the frustum").toBe(true);
    expect(frustum.intersectsBox(exact), 'while its exact box stays outside').toBe(false);

    expect(none.handle.margin).toBe(0);
    expect(none.drawn, 'margin 0 never offers it as a candidate').toEqual([0]);
    const margined = parked(1);
    expect(margined.handle.margin).toBe(1);
    // Membership on purpose, and the one place in this file where sorting drawn ids is the right relation: both
    // instances sit at z = -10 with the camera at the origin looking down -z, so their sort keys are equal and the
    // order between them is a stable-sort tie broken by whichever the tree visited first. The claim here is that a
    // margin hands the parked instance back at all, not where in the list it lands.
    expect(margined.drawn.slice().sort((a, b) => a - b), "a margin offers it, and three's sphere test admits it").toEqual([0, 1]);
  });
});
