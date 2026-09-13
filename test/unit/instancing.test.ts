import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Color, Frustum, InstancedMesh, Matrix4, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3, WebGLCoordinateSystem } from 'three';
import { createCulledInstancedMesh, FORGE_HOOK } from '../../src/compiler/instancing.js';
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
  const cull = (cam = camera) => instanced.onBeforeRender({ coordinateSystem: WebGLCoordinateSystem } as never, scene, cam, instanced.geometry, instanced.material as never, null as never);
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
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(f.camera.projectionMatrix, f.camera.matrixWorldInverse));
    const b = new Box3();
    let inside = 0;
    for (let i = 0; i < 2000; i++) {
      b.copy(box.boundingBox!).applyMatrix4(f.matrices[i]!);
      const corners = [b.min.x, b.max.x].flatMap((x) => [b.min.y, b.max.y].flatMap((y) => [b.min.z, b.max.z].map((z) => new Vector3(x, y, z))));
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
});
