import {
  Box3,
  BoxGeometry,
  type Camera,
  Color,
  DirectionalLight,
  Frustum,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLCoordinateSystem,
} from 'three';
import { describe, expect, it } from 'vitest';
import { createCulledInstancedMesh, FORGE_HOOK } from '../../src/compiler/instancing.js';
import { PassTracker } from '../../src/compiler/passTracker.js';
import { mulberry32 } from '../../test/scenes/naive.js';

const box = new BoxGeometry(1, 1, 1);
box.computeBoundingBox();

function field(count: number, area = 2000) {
  const rng = mulberry32(5);
  const matrices: Matrix4[] = [];
  const colors: Color[] = [];
  for (let i = 0; i < count; i++) {
    matrices.push(new Matrix4().makeTranslation(rng() * area - area / 2, 1, rng() * area - area / 2));
    colors.push(new Color(i % 2 ? 0xff0000 : 0x00ff00));
  }
  const instanced = createCulledInstancedMesh(box, new MeshStandardMaterial(), matrices, colors, WebGLCoordinateSystem);
  const camera = new PerspectiveCamera(60, 1.5, 0.1, 300);
  camera.position.set(0, 2, 0);
  camera.lookAt(100, 1, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const scene = new Scene();
  const cull = (cam = camera) =>
    instanced.onBeforeRender(
      { coordinateSystem: WebGLCoordinateSystem } as never,
      scene,
      cam,
      instanced.geometry,
      instanced.material as never,
      null as never,
    );
  return { instanced, matrices, colors, camera, cull };
}

describe('createCulledInstancedMesh', () => {
  it('is an InstancedMesh sized to all instances with bounds covering every instance', () => {
    const f = field(1000);
    expect(f.instanced).toBeInstanceOf(InstancedMesh);
    expect(f.instanced.instanceMatrix.count).toBe(1000);
    expect(f.instanced.userData.forge).toEqual({ instances: 1000, lodLevel: 0 });
    expect(f.instanced.boundingSphere?.radius).toBeGreaterThan(900);
    expect((f.instanced.onBeforeRender as unknown as Record<symbol, unknown>)[FORGE_HOOK]).toBe(true);
  });

  it('compacts the visible instances to the front of the buffers and sets count', () => {
    const f = field(1000);
    f.cull();
    const drawn = f.instanced.count;
    expect(drawn).toBeGreaterThan(5);
    expect(drawn).toBeLessThan(1000);
    const ids = f.instanced.visibleIds;
    expect(ids).toHaveLength(drawn);
    const m = new Matrix4();
    const c = new Color();
    for (let k = 0; k < drawn; k++) {
      f.instanced.getMatrixAt(k, m);
      // Instance buffers are Float32; compare with tolerance.
      m.elements.forEach((e, i) => expect(e).toBeCloseTo(f.matrices[ids[k]!]!.elements[i]!, 3));
      f.instanced.getColorAt(k, c);
      expect(c.getHex()).toBe(f.colors[ids[k]!]!.getHex());
    }
  });

  it('only re-uploads when the visible set changes', () => {
    const f = field(1000);
    f.cull();
    const version = f.instanced.instanceMatrix.version;
    f.cull();
    expect(f.instanced.instanceMatrix.version).toBe(version);
    const other = f.camera.clone();
    other.rotateY(Math.PI / 2);
    other.updateMatrixWorld();
    f.cull(other);
    expect(f.instanced.instanceMatrix.version).toBeGreaterThan(version);
  });

  it('draws every instance fully inside the frustum and none fully outside', () => {
    const f = field(2000);
    f.cull();
    const ids = new Set(f.instanced.visibleIds);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(f.camera.projectionMatrix, f.camera.matrixWorldInverse),
    );
    const b = new Box3();
    let inside = 0;
    for (let i = 0; i < 2000; i++) {
      b.copy(box.boundingBox!).applyMatrix4(f.matrices[i]!);
      const corners = [b.min.x, b.max.x].flatMap((x) =>
        [b.min.y, b.max.y].flatMap((y) => [b.min.z, b.max.z].map((z) => new Vector3(x, y, z))),
      );
      const fullyInside = corners.every((c) => frustum.containsPoint(c));
      if (fullyInside) {
        inside++;
        expect(ids.has(i)).toBe(true);
      }
      if (!frustum.intersectsBox(b)) expect(ids.has(i)).toBe(false);
    }
    expect(inside).toBeGreaterThan(0);
  });

  it('maps a compacted instanceId back to the master index through visibleIds', () => {
    const f = field(500);
    f.cull();
    const k = 0;
    const master = f.instanced.visibleIds[k]!;
    const m = new Matrix4();
    f.instanced.getMatrixAt(k, m);
    m.elements.forEach((e, i) => expect(e).toBeCloseTo(f.matrices[master]!.elements[i]!, 3));
  });

  it("refreshBounds recomputes every level's box and sphere from the master matrices, not from the compacted rows", () => {
    const matrices = [0, 1, 2, 3].map((i) => new Matrix4().makeTranslation(i * 2, 0, 0));
    const mesh = createCulledInstancedMesh(box, new MeshBasicMaterial(), matrices, null, WebGLCoordinateSystem, {
      lods: [new BoxGeometry(1, 1, 1)],
      distances: [50],
    });
    const camera = new PerspectiveCamera(20, 1, 0.1, 100);
    camera.position.set(0, 5, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    mesh.onBeforeRender(
      { coordinateSystem: WebGLCoordinateSystem } as never,
      new Scene(),
      camera,
      mesh.geometry,
      mesh.material as never,
      null as never,
    );
    expect(mesh.levels[0]!.count + mesh.levels[1]!.count, 'the rows hold instance 0 only').toBe(1);
    mesh.forgeCulling.setMatrixAt(3, new Matrix4().makeTranslation(500, 0, 0));
    mesh.forgeCulling.refreshBounds();
    const expected = new Box3(new Vector3(-0.5, -0.5, -0.5), new Vector3(500.5, 0.5, 0.5));
    const sphere = expected.getBoundingSphere(new Sphere());
    for (const level of mesh.levels) {
      expect(level.boundingBox, `level ${level.lodLevel} box`).toEqual(expected);
      expect(level.boundingSphere, `level ${level.lodLevel} sphere`).toEqual(sphere);
    }
    expect(mesh.levels[0]!.boundingBox).not.toBe(mesh.levels[1]!.boundingBox);
  });
});

describe('createCulledInstancedMesh update ranges on the vertex-buffer path', () => {
  /** 2,000 instances with colours, a PassTracker, and a renderer as the hook reads it: a uniform-buffer limit the matrices exceed, and a sun. */
  function rangedField() {
    const passes = new PassTracker();
    const rng = mulberry32(5);
    const matrices: Matrix4[] = [];
    const colors: Color[] = [];
    for (let i = 0; i < 2000; i++) {
      matrices.push(new Matrix4().makeTranslation(rng() * 2000 - 1000, 1, rng() * 2000 - 1000));
      colors.push(new Color(i % 2 ? 0xff0000 : 0x00ff00));
    }
    const mesh = createCulledInstancedMesh(box, new MeshStandardMaterial(), matrices, colors, WebGLCoordinateSystem, {
      passes,
    });
    const sun = new DirectionalLight();
    sun.castShadow = true;
    sun.position.set(0, 100, 0);
    Object.assign(sun.shadow.camera, {
      left: -400,
      right: 400,
      top: 400,
      bottom: -400,
      near: 1,
      far: 300,
    }).updateProjectionMatrix();
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);
    // 2,000 x 64 bytes of matrices exceed 65,536: three keeps them in the shared vertex buffer.
    const renderer = {
      coordinateSystem: WebGLCoordinateSystem,
      backend: { capabilities: { getUniformBufferLimit: () => 65536 } },
      lighting: { getNode: () => ({ getLights: () => [sun] }) },
    };
    const camera = new PerspectiveCamera(60, 1.5, 0.1, 300);
    camera.position.set(0, 2, 0);
    camera.lookAt(100, 1, 0);
    camera.updateMatrixWorld();
    const scene = new Scene();
    const shadowScene = new Scene();
    shadowScene.overrideMaterial = Object.assign(new MeshBasicMaterial(), { isShadowPassMaterial: true });
    const run = (c: Camera, s: Scene): void =>
      mesh.onBeforeRender(renderer as never, s, c, mesh.geometry, mesh.material as never, null as never);
    return { passes, mesh, sun, camera, scene, shadowScene, run };
  }

  /** The first and last row whose 16 matrix floats differ between two copies of the buffer. */
  function changedRows(before: ArrayLike<number>, after: ArrayLike<number>): [number, number] | null {
    let first = -1;
    let last = -1;
    for (let row = 0; row < before.length / 16; row++) {
      for (let e = 0; e < 16; e++) {
        if (before[row * 16 + e] === after[row * 16 + e]) continue;
        if (first < 0) first = row;
        last = row;
        break;
      }
    }
    return first < 0 ? null : [first, last];
  }

  it('marks exactly the rows an outermost compaction changed, and both whole buffers when a nested pass writes rows', () => {
    const f = rangedField();
    const before = Float32Array.from(f.mesh.instanceMatrix.array);
    f.passes.begin(f.camera);
    f.run(f.camera, f.scene);
    const span = changedRows(before, f.mesh.instanceMatrix.array);
    expect(span).not.toBeNull();
    const [first, last] = span!;
    expect(f.mesh.instanceMatrix.updateRanges, 'matrix rows of the outermost compaction').toEqual([
      { start: first * 16, count: (last - first + 1) * 16 },
    ]);
    expect(f.mesh.instanceColor!.updateRanges, 'colour rows of the outermost compaction').toEqual([
      { start: first * 3, count: (last - first + 1) * 3 },
    ]);
    const mainCount = f.mesh.count;
    f.passes.begin(f.sun.shadow.camera);
    f.run(f.sun.shadow.camera, f.shadowScene);
    expect(f.mesh.count, 'the shadow pass appended casters').toBeGreaterThan(mainCount);
    // A sync by the shadow pass's render object replaces the ranges the main render object synced but has not uploaded.
    expect(f.mesh.instanceMatrix.updateRanges.at(-1), 'a nested write marks the whole matrix buffer').toEqual({
      start: 0,
      count: 2000 * 16,
    });
    expect(f.mesh.instanceColor!.updateRanges.at(-1), 'and the whole colour buffer').toEqual({
      start: 0,
      count: 2000 * 3,
    });
    f.passes.end();
    f.passes.end();
    expect(f.mesh.count).toBe(mainCount);
  });

  it('replaces more pending ranges than it keeps with one range over the whole buffer', () => {
    const f = rangedField();
    const other = f.camera.clone();
    other.rotateY(Math.PI);
    other.updateMatrixWorld();
    // Nothing syncs here, so every outermost compaction that changes rows adds a range.
    for (let i = 0; i < 40; i++) {
      const c = i % 2 ? other : f.camera;
      f.passes.begin(c);
      f.run(c, f.scene);
      f.passes.end();
    }
    for (const [attribute, itemSize] of [
      [f.mesh.instanceMatrix, 16],
      [f.mesh.instanceColor!, 3],
    ] as const) {
      expect(attribute.updateRanges.length).toBeLessThanOrEqual(32);
      expect(attribute.updateRanges.some((r) => r.start === 0 && r.count === 2000 * itemSize)).toBe(true);
    }
  });
});
