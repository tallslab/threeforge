import { BVH, HybridBuilder, WebGLCoordinateSystem as BvhWebGL, WebGPUCoordinateSystem as BvhWebGPU, type BVHNode } from 'bvh.js';
import {
  Box3,
  Frustum,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Sphere,
  Vector3,
  WebGLCoordinateSystem,
  type BufferGeometry,
  type Camera,
  type Color,
  type CoordinateSystem,
  type Material,
  type Scene,
} from 'three';
import { FORGE_HOOK, levelFor } from './culling.js';

export { FORGE_HOOK };

export interface InstanceCullingHandle {
  /** Update one instance's master matrix and its BVH leaf; the next cull re-uploads. */
  setMatrixAt(id: number, matrix: Matrix4): void;
  setVisibleAt(id: number, visible: boolean): void;
  getVisibleAt(id: number): boolean;
  /** Restore an uncompacted mesh drawing every instance. */
  detach(): void;
}

/** An InstancedMesh whose visible instances are compacted to the front of its buffers every frame. */
export interface CulledInstancedMesh extends InstancedMesh {
  /** Compacted index -> master index, valid after the last cull. */
  visibleIds: number[];
  forgeCulling: InstanceCullingHandle;
  /** All level meshes of this group, level 0 first; the same array on every level. */
  levels: CulledInstancedMesh[];
  lodLevel: number;
}

export interface InstancingOptions {
  /** Coarser geometries for distant instances, coarsest last. Ignored without `distances`. */
  lods?: BufferGeometry[];
  distances?: number[];
}

const _box = new Box3();
const _matrix = new Matrix4();
const _inverse = new Matrix4();
const _frustum = new Frustum();
const _cameraPos = new Vector3();
const _position = new Vector3();

function same16(a: Float64Array, b: number[]): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

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
  options: InstancingOptions = {},
): CulledInstancedMesh {
  const n = matrices.length;
  const distances = options.distances ?? [];
  const geometries = [geometry, ...(options.lods ?? [])].slice(0, distances.length > 0 ? distances.length + 1 : 1);
  const levelCount = geometries.length;

  const masterMatrices = new Float32Array(n * 16);
  const masterColors = colors ? new Float32Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    matrices[i]!.toArray(masterMatrices, i * 16);
    if (masterColors && colors) colors[i]!.toArray(masterColors, i * 3);
  }

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
  const sphere = bounds.getBoundingSphere(new Sphere());

  const levels: CulledInstancedMesh[] = geometries.map((g, L) => {
    const mesh = new InstancedMesh(g, material, n) as CulledInstancedMesh;
    if (masterColors) mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
    if (L === 0) {
      mesh.instanceMatrix.array.set(masterMatrices);
      if (mesh.instanceColor && masterColors) mesh.instanceColor.array.set(masterColors);
      mesh.count = n;
      mesh.visibleIds = ids.slice();
    } else {
      mesh.count = 0;
      mesh.visibleIds = [];
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData.forge = { instances: L === 0 ? n : 0, lodLevel: L };
    mesh.boundingBox = bounds.clone();
    mesh.boundingSphere = sphere.clone();
    mesh.lodLevel = L;
    return mesh;
  });
  for (const mesh of levels) mesh.levels = levels;

  const visibleMask = new Uint8Array(n).fill(1);
  const lastKey = new Float64Array(16);
  let hasKey = false;
  let dirty = false;
  const perLevel: number[][] = levels.map(() => []);

  const hook = function (this: CulledInstancedMesh, _renderer: unknown, _scene: Scene, camera: Camera): void {
    _matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.matrixWorld);
    if (!dirty && hasKey && same16(lastKey, _matrix.elements)) return;
    lastKey.set(_matrix.elements);
    hasKey = true;
    dirty = false;
    for (const list of perLevel) list.length = 0;
    const useLod = levelCount > 1;
    if (useLod) {
      _inverse.copy(this.matrixWorld).invert();
      _cameraPos.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inverse);
    }
    const place = (id: number): void => {
      if (!visibleMask[id]) return;
      let level = 0;
      if (useLod) {
        _position.set(masterMatrices[id * 16 + 12]!, masterMatrices[id * 16 + 13]!, masterMatrices[id * 16 + 14]!);
        level = Math.min(levelFor(_position.distanceTo(_cameraPos), distances), levelCount - 1);
      }
      perLevel[level]!.push(id);
    };
    if ((camera as Camera & { isArrayCamera?: boolean }).isArrayCamera) {
      for (let i = 0; i < n; i++) place(i);
    } else {
      _frustum.setFromProjectionMatrix(_matrix, coordinateSystem);
      bvh.frustumCulling(_matrix.elements, (node) => place(node.object!));
    }
    for (let L = 0; L < levelCount; L++) {
      const mesh = levels[L]!;
      const list = perLevel[L]!;
      const matrixArray = mesh.instanceMatrix.array;
      const colorArray = mesh.instanceColor?.array;
      for (let k = 0; k < list.length; k++) {
        const id = list[k]!;
        matrixArray.set(masterMatrices.subarray(id * 16, id * 16 + 16), k * 16);
        if (colorArray && masterColors) colorArray.set(masterColors.subarray(id * 3, id * 3 + 3), k * 3);
      }
      mesh.visibleIds = list.slice();
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  };
  (hook as unknown as Record<symbol, boolean>)[FORGE_HOOK] = true;
  for (const mesh of levels) mesh.onBeforeRender = hook as unknown as InstancedMesh['onBeforeRender'];

  let detached = false;
  const handle: InstanceCullingHandle = {
    setMatrixAt(id, matrix) {
      matrix.toArray(masterMatrices, id * 16);
      const node = nodes.get(id);
      if (node) {
        boxOf(id, node.box as Float32Array);
        bvh.move(node, 0);
      }
      dirty = true;
    },
    setVisibleAt(id, visible) {
      const value = visible ? 1 : 0;
      if (visibleMask[id] === value) return;
      visibleMask[id] = value;
      dirty = true;
    },
    getVisibleAt(id) {
      return visibleMask[id] === 1;
    },
    detach() {
      if (detached) return;
      detached = true;
      for (const mesh of levels) {
        if (Object.prototype.hasOwnProperty.call(mesh, 'onBeforeRender')) delete (mesh as { onBeforeRender?: unknown }).onBeforeRender;
      }
      const base = levels[0]!;
      base.instanceMatrix.array.set(masterMatrices);
      base.instanceMatrix.needsUpdate = true;
      if (base.instanceColor && masterColors) {
        base.instanceColor.array.set(masterColors);
        base.instanceColor.needsUpdate = true;
      }
      base.count = n;
      base.visibleIds = ids.slice();
      for (const mesh of levels.slice(1)) {
        mesh.count = 0;
        mesh.visibleIds = [];
      }
      bvh.clear();
      nodes.clear();
    },
  };
  for (const mesh of levels) mesh.forgeCulling = handle;
  return levels[0]!;
}
