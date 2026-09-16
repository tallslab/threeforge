import { describe, expect, it } from 'vitest';
import { BatchedMesh, Box3, BoxGeometry, Frustum, Matrix4, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3, WebGLCoordinateSystem } from 'three';
import { attachBvhCulling, FORGE_HOOK } from '../../src/compiler/culling.js';
import { mulberry32 } from '../../test/scenes/naive.js';

const box = new BoxGeometry(1, 1, 1);

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
  const drawn = () => {
    const b = batch as unknown as { _multiDrawCount: number; _indirectTexture: { image: { data: Uint32Array } } };
    return Array.from(b._indirectTexture.image.data.subarray(0, b._multiDrawCount)).sort((x, y) => x - y);
  };
  return { batch, camera, cull, drawn };
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
    const outside = before.length > 0 ? -1 : 0;
    expect(outside).toBe(-1);
    // Move the first drawn instance far behind the camera and re-cull: it must disappear.
    const id = before[0]!;
    f.batch.setMatrixAt(id, new Matrix4().makeTranslation(-5000, 1, 0));
    handle.move(id);
    f.cull();
    expect(f.drawn()).not.toContain(id);
  });

  it('is at least twice as fast as the linear scan at 20k instances when few are visible', () => {
    const f = field(20_000);
    // Best of several trials: other vitest workers share the CPU, so single averages are noisy.
    const best = () => {
      let min = Infinity;
      for (let trial = 0; trial < 7; trial++) {
        const start = performance.now();
        for (let i = 0; i < 5; i++) f.cull();
        min = Math.min(min, (performance.now() - start) / 5);
      }
      return min;
    };
    f.cull();
    const linear = best();
    attachBvhCulling(f.batch, WebGLCoordinateSystem);
    f.cull();
    const bvh = best();
    console.log(`culling 20k instances: linear ${linear.toFixed(3)} ms, bvh ${bvh.toFixed(3)} ms`);
    expect(bvh).toBeLessThan(linear / 2);
  });

  it('detaches cleanly, restoring the prototype behaviour', () => {
    const f = field(5000);
    f.cull();
    const linear = f.drawn();
    const handle = attachBvhCulling(f.batch, WebGLCoordinateSystem);
    handle.detach();
    expect(Object.prototype.hasOwnProperty.call(f.batch, 'onBeforeRender')).toBe(false);
    f.cull();
    expect(f.drawn()).toEqual(linear);
  });
});

describe('attachBvhCulling margin', () => {
  it('only adds candidates: the drawn set is exactly the one a marginless tree gives', () => {
    const none = field(4000);
    attachBvhCulling(none.batch, WebGLCoordinateSystem);
    none.cull();
    const expected = none.drawn();
    expect(expected.length).toBeGreaterThan(10);
    expect(expected.length).toBeLessThan(4000);
    const margined = field(4000); // the same seed, so the same instances
    attachBvhCulling(margined.batch, WebGLCoordinateSystem, { margin: 25 });
    margined.cull();
    expect(margined.drawn()).toEqual(expected);
  });
});

describe('attachBvhCulling margin: draw order', () => {
  /** The indirect rows in slot order, not sorted: the order a sorted batch blends its instances in. */
  const rows = (batch: BatchedMesh): number[] => {
    const b = batch as unknown as { _multiDrawCount: number; _indirectTexture: { image: { data: Uint32Array } } };
    return Array.from(b._indirectTexture.image.data.subarray(0, b._multiDrawCount));
  };

  /** Instances on eight planes perpendicular to the view, so forty of them share a sort key exactly. */
  function tied(perPlane = 40, planes = 8) {
    const count = perPlane * planes;
    const batch = new BatchedMesh(count, box.attributes.position!.count, box.index!.count, new MeshStandardMaterial());
    const id = batch.addGeometry(box);
    const m = new Matrix4();
    for (let p = 0; p < planes; p++) {
      for (let i = 0; i < perPlane; i++) {
        const instance = batch.addInstance(id);
        m.makeTranslation((i - perPlane / 2) * 1.5, 1, -(20 + p * 20));
        batch.setMatrixAt(instance, m);
      }
    }
    batch.computeBoundingSphere();
    const camera = new PerspectiveCamera(70, 1.5, 0.1, 400);
    camera.position.set(0, 1, 0);
    camera.lookAt(0, 1, -1);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const scene = new Scene();
    const cull = () => batch.onBeforeRender({ coordinateSystem: WebGLCoordinateSystem } as never, scene, camera, batch.geometry, batch.material as never, null as never);
    return { batch, cull };
  }

  it('leaves the row order of a sorted batch alone, tie-breaks included', () => {
    const none = tied();
    expect(none.batch.sortObjects, 'three sorts a BatchedMesh by default').toBe(true);
    attachBvhCulling(none.batch, WebGLCoordinateSystem);
    none.cull();
    const expected = rows(none.batch);
    expect(expected.length).toBeGreaterThan(100);
    const margined = tied(); // the same instances
    attachBvhCulling(margined.batch, WebGLCoordinateSystem, { margin: 25 });
    margined.cull();
    expect(rows(margined.batch)).toEqual(expected);
  });

  it('leaves the row order of the scattered field alone too', () => {
    const none = field(4000);
    attachBvhCulling(none.batch, WebGLCoordinateSystem);
    none.cull();
    const expected = rows(none.batch);
    const margined = field(4000);
    attachBvhCulling(margined.batch, WebGLCoordinateSystem, { margin: 25 });
    margined.cull();
    expect(rows(margined.batch)).toEqual(expected);
  });
});
