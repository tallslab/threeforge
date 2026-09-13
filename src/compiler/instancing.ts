import { BVH, HybridBuilder, WebGLCoordinateSystem as BvhWebGL, WebGPUCoordinateSystem as BvhWebGPU, type BVHNode } from 'bvh.js';
import {
  Box3,
  Frustum,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Sphere,
  WebGLCoordinateSystem,
  type BufferGeometry,
  type Camera,
  type Color,
  type CoordinateSystem,
  type Material,
  type Scene,
} from 'three';
import { FORGE_HOOK } from './culling.js';

export { FORGE_HOOK };

export interface InstanceCullingHandle {
  /** Update one instance's master matrix and its BVH leaf; the next cull re-uploads. */
  setMatrixAt(id: number, matrix: Matrix4): void;
  /** Restore an uncompacted mesh drawing every instance. */
  detach(): void;
}

/** An InstancedMesh whose visible instances are compacted to the front of its buffers every frame. */
export interface CulledInstancedMesh extends InstancedMesh {
  /** Compacted index -> master index, valid after the last cull. */
  visibleIds: number[];
  forgeCulling: InstanceCullingHandle;
}

const _box = new Box3();
const _matrix = new Matrix4();
const _frustum = new Frustum();

/**
 * Hardware instancing for geometry repeated many times, with per-instance frustum culling that
 * `InstancedMesh` lacks: a BVH over instance boxes selects the visible set, which is copied to the front
 * of `instanceMatrix` / `instanceColor` and `count` is set. Uploads happen only when the visible set changes.
 */
export function createCulledInstancedMesh(
  geometry: BufferGeometry,
  material: Material,
  matrices: Matrix4[],
  colors: Color[] | null,
  coordinateSystem: CoordinateSystem,
): CulledInstancedMesh {
  const n = matrices.length;
  const mesh = new InstancedMesh(geometry, material, n) as CulledInstancedMesh;
  const masterMatrices = new Float32Array(n * 16);
  const masterColors = colors ? new Float32Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    matrices[i]!.toArray(masterMatrices, i * 16);
    if (masterColors && colors) colors[i]!.toArray(masterColors, i * 3);
  }
  mesh.instanceMatrix.array.set(masterMatrices);
  mesh.instanceMatrix.needsUpdate = true;
  if (masterColors) {
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
    mesh.instanceColor.array.set(masterColors);
    mesh.instanceColor.needsUpdate = true;
  }
  mesh.userData.forge = { instances: n };

  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  const geometryBox = geometry.boundingBox!;
  const bounds = new Box3();
  const bvh = new BVH<object, number>(new HybridBuilder(), coordinateSystem === WebGLCoordinateSystem ? BvhWebGL : BvhWebGPU);
  const nodes = new Map<number, BVHNode<object, number>>();
  const boxOf = (id: number, out: Float32Array): Float32Array => {
    _matrix.fromArray(masterMatrices, id * 16);
    _box.copy(geometryBox).applyMatrix4(_matrix);
    out[0] = _box.min.x;
    out[1] = _box.max.x;
    out[2] = _box.min.y;
    out[3] = _box.max.y;
    out[4] = _box.min.z;
    out[5] = _box.max.z;
    return out;
  };
  const ids: number[] = [];
  const boxes: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(i);
    boxes.push(boxOf(i, new Float32Array(6)));
    bounds.union(_box);
  }
  bvh.createFromArray(ids, boxes, (node) => nodes.set(node.object!, node), 0);
  mesh.boundingBox = bounds.clone();
  mesh.boundingSphere = bounds.getBoundingSphere(new Sphere());

  let visibleIds: number[] = ids.slice();
  let dirty = false;
  mesh.visibleIds = visibleIds;
  const candidates: number[] = [];

  const hook = function (this: CulledInstancedMesh, _renderer: unknown, _scene: Scene, camera: Camera): void {
    _matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.matrixWorld);
    candidates.length = 0;
    if ((camera as Camera & { isArrayCamera?: boolean }).isArrayCamera) {
      for (let i = 0; i < n; i++) candidates.push(i);
    } else {
      _frustum.setFromProjectionMatrix(_matrix, coordinateSystem);
      bvh.frustumCulling(_matrix.elements, (node) => {
        candidates.push(node.object!);
      });
    }
    let same = !dirty && candidates.length === visibleIds.length;
    if (same) {
      for (let k = 0; k < candidates.length; k++) {
        if (candidates[k] !== visibleIds[k]) {
          same = false;
          break;
        }
      }
    }
    if (same) return;
    visibleIds = candidates.slice();
    this.visibleIds = visibleIds;
    dirty = false;
    const matrixArray = this.instanceMatrix.array;
    const colorArray = this.instanceColor?.array;
    for (let k = 0; k < visibleIds.length; k++) {
      const id = visibleIds[k]!;
      matrixArray.set(masterMatrices.subarray(id * 16, id * 16 + 16), k * 16);
      if (colorArray && masterColors) colorArray.set(masterColors.subarray(id * 3, id * 3 + 3), k * 3);
    }
    this.count = visibleIds.length;
    this.instanceMatrix.needsUpdate = true;
    if (this.instanceColor) this.instanceColor.needsUpdate = true;
  };
  (hook as unknown as Record<symbol, boolean>)[FORGE_HOOK] = true;
  mesh.onBeforeRender = hook as unknown as InstancedMesh['onBeforeRender'];

  mesh.forgeCulling = {
    setMatrixAt(id, matrix) {
      matrix.toArray(masterMatrices, id * 16);
      const node = nodes.get(id);
      if (node) {
        boxOf(id, node.box as Float32Array);
        bvh.move(node, 0);
      }
      dirty = true;
    },
    detach() {
      if (Object.prototype.hasOwnProperty.call(mesh, 'onBeforeRender')) delete (mesh as { onBeforeRender?: unknown }).onBeforeRender;
      mesh.instanceMatrix.array.set(masterMatrices);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor && masterColors) {
        mesh.instanceColor.array.set(masterColors);
        mesh.instanceColor.needsUpdate = true;
      }
      mesh.count = n;
      mesh.visibleIds = ids.slice();
      bvh.clear();
      nodes.clear();
    },
  };
  return mesh;
}
