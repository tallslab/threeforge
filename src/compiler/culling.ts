import { BVH, HybridBuilder, WebGLCoordinateSystem as BvhWebGL, WebGPUCoordinateSystem as BvhWebGPU, type BVHNode } from 'bvh.js';
import { Box3, Frustum, Matrix4, Sphere, Vector3, WebGLCoordinateSystem, type BatchedMesh, type BufferGeometry, type Camera, type CoordinateSystem, type Material, type Object3D, type Scene } from 'three';

/** Functions threeforge installs as own-property hooks carry this marker so the ledger does not flag them. */
export const FORGE_HOOK: unique symbol = Symbol.for('threeforge.hook');

export interface CullingLod {
  /** Distance thresholds; level i is used from distances[i-1] onward. */
  distances: number[];
  /** Base geometryId -> geometryIds per level (level 0 = base). Geometries not listed always draw at level 0. */
  geometryIds: Map<number, number[]>;
}

/**
 * How nested render passes (reflections, portals, picking) are culled. `per-pass` culls for every camera.
 * `reuse-main` culls only for the main camera and lets nested passes draw that list (one frame old): on the
 * WebGPU backend a second change of the instance list within one frame is not picked up by the main pass when
 * the nested pass reuses the same material, so this keeps the GPU data changing once per frame.
 */
export type NestedPassPolicy = 'per-pass' | 'reuse-main';

export interface CullingOptions {
  /** Box margin for instances that move; 0 (default) is fastest for statics. */
  margin?: number;
  /** Pick a coarser geometry range for distant instances (batches only). */
  lod?: CullingLod;
  nestedPasses?: NestedPassPolicy;
  /** The camera of the outermost render this frame; required for `reuse-main`. */
  mainCamera?: () => Camera | null;
}

/** Index of the LOD level for a camera distance. */
export function levelFor(distance: number, distances: number[]): number {
  let level = 0;
  while (level < distances.length && distance >= distances[level]!) level++;
  return level;
}

export interface CullingHandle {
  bvh: BVH<object, number>;
  /** Re-read an instance's matrix and update its leaf. */
  move(id: number): void;
  insert(id: number): void;
  remove(id: number): void;
  /** Restore BatchedMesh's own linear culling. */
  detach(): void;
}

type Internals = BatchedMesh & {
  _visibilityChanged: boolean;
  _instanceInfo: { visible: boolean; active: boolean; geometryIndex: number }[];
  _geometryInfo: { start: number; count: number }[];
  _multiDrawStarts: Int32Array;
  _multiDrawCounts: Int32Array;
  _multiDrawCount: number;
  _multiDrawBytesPerElement: number;
  _indirectTexture: { image: { data: Uint32Array }; needsUpdate: boolean };
};

interface RenderItem {
  start: number;
  count: number;
  z: number;
  index: number;
}

const _box = new Box3();
const _sphere = new Sphere();
const _matrix = new Matrix4();
const _instanceMatrix = new Matrix4();
const _frustum = new Frustum();
const _cameraPos = new Vector3();
const _forward = new Vector3();
const _temp = new Vector3();
const _list: RenderItem[] = [];

function sortOpaque(a: RenderItem, b: RenderItem): number {
  return a.z - b.z;
}
function sortTransparent(a: RenderItem, b: RenderItem): number {
  return b.z - a.z;
}

/**
 * Replaces a BatchedMesh's linear per-instance frustum scan with a BVH query (O(log n + visible)).
 * Mirrors three r186's `BatchedMesh.onBeforeRender` byte for byte in what it writes: `_multiDrawStarts`,
 * `_multiDrawCounts`, `_multiDrawCount`, the indirect texture and `_multiDrawBytesPerElement`.
 * Candidates from the BVH still pass three's own bounding-sphere test, so the result is a subset of what
 * the linear scan would draw, never a superset. Array cameras and reversed depth fall back to the linear scan.
 */
export function attachBvhCulling(batch: BatchedMesh, coordinateSystem: CoordinateSystem, options: CullingOptions = {}): CullingHandle {
  const target = batch as Internals;
  const margin = options.margin ?? 0;
  const lod = options.lod;
  const reuseMain = options.nestedPasses === 'reuse-main';
  const mainCamera = options.mainCamera;
  let hasMainCull = false;
  const bvh = new BVH<object, number>(new HybridBuilder(), coordinateSystem === WebGLCoordinateSystem ? BvhWebGL : BvhWebGPU);
  const nodes = new Map<number, BVHNode<object, number>>();

  const boxOf = (id: number, out: Float32Array): Float32Array => {
    const info = target._instanceInfo[id]!;
    batch.getBoundingBoxAt(info.geometryIndex, _box);
    batch.getMatrixAt(id, _instanceMatrix);
    _box.applyMatrix4(_instanceMatrix);
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
  for (let i = 0; i < target._instanceInfo.length; i++) {
    if (!target._instanceInfo[i]!.active) continue;
    ids.push(i);
    boxes.push(boxOf(i, new Float32Array(6)));
  }
  bvh.createFromArray(ids, boxes, (node) => nodes.set(node.object!, node), margin);

  const prototypeHook = Object.getPrototypeOf(batch).onBeforeRender as BatchedMesh['onBeforeRender'];

  const hook = function (this: Internals, renderer: unknown, scene: Scene, camera: Camera, geometry: BufferGeometry, material: Material, group: unknown): void {
    if (reuseMain) {
      const main = mainCamera?.() ?? null;
      if (main && camera !== main) {
        // Nested pass: keep the main camera's list (arrays and indirect texture untouched); nothing before the first main cull.
        if (!hasMainCull) this._multiDrawCount = 0;
        return;
      }
      hasMainCull = true;
    }
    const cam = camera as Camera & { isArrayCamera?: boolean; reversedDepth?: boolean };
    if (!this.perObjectFrustumCulled || cam.isArrayCamera || cam.reversedDepth) {
      prototypeHook.call(this, renderer as never, scene, camera, geometry, material, group as never);
      return;
    }
    const index = geometry.getIndex();
    let bytesPerElement = index === null ? 1 : index.array.BYTES_PER_ELEMENT;
    let multiDrawMultiplier = 1;
    if ((material as Material & { wireframe?: boolean }).wireframe) {
      multiDrawMultiplier = 2;
      bytesPerElement = geometry.attributes.position!.count > 65535 ? 4 : 2;
    }
    const instanceInfo = this._instanceInfo;
    const geometryInfoList = this._geometryInfo;
    const multiDrawStarts = this._multiDrawStarts;
    const multiDrawCounts = this._multiDrawCounts;
    const indirectArray = this._indirectTexture.image.data;

    _matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.matrixWorld);
    _frustum.setFromProjectionMatrix(_matrix, coordinateSystem);
    let count = 0;
    if (lod || this.sortObjects) {
      _instanceMatrix.copy(this.matrixWorld).invert();
      _cameraPos.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_instanceMatrix);
      _forward.set(0, 0, -1).transformDirection(camera.matrixWorld).transformDirection(_instanceMatrix);
    }
    const rangeFor = (geometryIndex: number): { start: number; count: number } => {
      let gid = geometryIndex;
      if (lod) {
        const levels = lod.geometryIds.get(geometryIndex);
        if (levels) gid = levels[Math.min(levelFor(_sphere.center.distanceTo(_cameraPos), lod.distances), levels.length - 1)]!;
      }
      return geometryInfoList[gid]!;
    };

    if (this.sortObjects) {
      _list.length = 0;
      bvh.frustumCulling(_matrix.elements, (node) => {
        const i = node.object!;
        const info = instanceInfo[i]!;
        if (!info.visible || !info.active) return;
        this.getMatrixAt(i, _instanceMatrix);
        this.getBoundingSphereAt(info.geometryIndex, _sphere)!.applyMatrix4(_instanceMatrix);
        if (!_frustum.intersectsSphere(_sphere)) return;
        const g = rangeFor(info.geometryIndex);
        _list.push({ start: g.start, count: g.count, z: _temp.subVectors(_sphere.center, _cameraPos).dot(_forward), index: i });
      });
      const customSort = this.customSort as ((list: RenderItem[], camera: Camera) => void) | null;
      if (customSort === null) _list.sort(material.transparent ? sortTransparent : sortOpaque);
      else customSort.call(this, _list, camera);
      for (const item of _list) {
        multiDrawStarts[count] = item.start * bytesPerElement * multiDrawMultiplier;
        multiDrawCounts[count] = item.count * multiDrawMultiplier;
        indirectArray[count] = item.index;
        count++;
      }
      _list.length = 0;
    } else {
      bvh.frustumCulling(_matrix.elements, (node) => {
        const i = node.object!;
        const info = instanceInfo[i]!;
        if (!info.visible || !info.active) return;
        this.getMatrixAt(i, _instanceMatrix);
        this.getBoundingSphereAt(info.geometryIndex, _sphere)!.applyMatrix4(_instanceMatrix);
        if (!_frustum.intersectsSphere(_sphere)) return;
        const g = rangeFor(info.geometryIndex);
        multiDrawStarts[count] = g.start * bytesPerElement * multiDrawMultiplier;
        multiDrawCounts[count] = g.count * multiDrawMultiplier;
        indirectArray[count] = i;
        count++;
      });
    }

    this._indirectTexture.needsUpdate = true;
    this._multiDrawCount = count;
    this._multiDrawBytesPerElement = bytesPerElement;
    this._visibilityChanged = false;
  };
  (hook as unknown as Record<symbol, boolean>)[FORGE_HOOK] = true;
  batch.onBeforeRender = hook as unknown as BatchedMesh['onBeforeRender'];

  return {
    bvh,
    move(id) {
      const node = nodes.get(id);
      if (!node) return;
      boxOf(id, node.box as Float32Array);
      bvh.move(node, margin);
    },
    insert(id) {
      nodes.set(id, bvh.insert(id, boxOf(id, new Float32Array(6)), margin));
    },
    remove(id) {
      const node = nodes.get(id);
      if (!node) return;
      bvh.delete(node);
      nodes.delete(id);
    },
    detach() {
      if (Object.prototype.hasOwnProperty.call(batch, 'onBeforeRender')) delete (batch as { onBeforeRender?: unknown }).onBeforeRender;
      bvh.clear();
      nodes.clear();
    },
  };
}

const OWN = Object.prototype.hasOwnProperty;

/**
 * Runs `fn` before whatever `onBeforeRender` the object currently has (three's prototype method or a
 * threeforge hook), as a marked own-property hook. Returns a function that restores the previous state.
 */
export function prependRenderHook(object: Object3D, fn: (...args: Parameters<Object3D['onBeforeRender']>) => void): () => void {
  return prependHook(object, 'onBeforeRender', fn);
}

/** Same as `prependRenderHook` for `onAfterRender`; `fn` receives the renderer, scene and camera. */
export function prependAfterRenderHook(object: Object3D, fn: (...args: Parameters<Object3D['onAfterRender']>) => void): () => void {
  return prependHook(object, 'onAfterRender', fn);
}

function prependHook<K extends 'onBeforeRender' | 'onAfterRender'>(object: Object3D, name: K, fn: (...args: Parameters<Object3D[K]>) => void): () => void {
  const hadOwn = OWN.call(object, name);
  const previous = object[name] as (...args: Parameters<Object3D[K]>) => void;
  const hook = function (this: Object3D, ...args: Parameters<Object3D[K]>): void {
    fn(...args);
    previous.apply(this, args);
  };
  (hook as unknown as Record<symbol, boolean>)[FORGE_HOOK] = true;
  (object as unknown as Record<K, unknown>)[name] = hook;
  return () => {
    if ((object as unknown as Record<K, unknown>)[name] !== hook) return;
    if (hadOwn) (object as unknown as Record<K, unknown>)[name] = previous;
    else delete (object as unknown as Record<K, unknown>)[name];
  };
}
