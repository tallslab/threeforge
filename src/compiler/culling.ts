import { BVH, HybridBuilder, WebGLCoordinateSystem as BvhWebGL, WebGPUCoordinateSystem as BvhWebGPU, type BVHNode } from 'bvh.js';
import { Box3, Frustum, FrustumArray, Matrix4, Sphere, Vector3, WebGLCoordinateSystem, type ArrayCamera, type BatchedMesh, type BufferGeometry, type Camera, type CoordinateSystem, type Material, type Object3D, type Scene } from 'three';
import type { PassTracker } from './passTracker.js';

/** Functions threeforge installs as own-property hooks carry this marker so the ledger does not flag them. */
export const FORGE_HOOK: unique symbol = Symbol.for('threeforge.hook');

export interface CullingLod {
  /** Distance thresholds; level i is used from distances[i-1] onward. */
  distances: number[];
  /** Base geometryId -> geometryIds per level (level 0 = base). Geometries not listed always draw at level 0. */
  geometryIds: Map<number, number[]>;
}

/**
 * How a render pass nested in another render of the scene (a shadow map, a reflection, a portal) culls a batch that no
 * enclosing open pass has culled yet: `per-pass` culls it for the nested camera; `reuse-main` keeps the rows of the
 * batch's last outermost-render cull and appends what the nested camera needs, so its index rows are rewritten only
 * by outermost renders. A batch an enclosing pass has already culled is served from a stable prefix under both
 * policies (see `attachBvhCulling`).
 */
export type NestedPassPolicy = 'per-pass' | 'reuse-main';

export interface CullingOptions {
  /** Box margin for instances that move; 0 (default) is fastest for statics. */
  margin?: number;
  /** Pick a coarser geometry range for distant instances (batches only). */
  lod?: CullingLod;
  nestedPasses?: NestedPassPolicy;
  /**
   * The tracker installed on the scene the batch renders in (`new PassTracker().install(scene)`; `World` does this).
   * It tells the hook how deep the current render is nested and which passes are still open. Without it every call
   * counts as an outermost render and culls for its camera, which is only right when nothing renders the batch from
   * inside another render (no shadow-casting light, no reflection).
   */
  passes?: PassTracker;
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

type CullCamera = Camera & { isArrayCamera?: boolean; reversedDepth?: boolean };

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
const _frustumArray = new FrustumArray();
const _cameraPos = new Vector3();
const _forward = new Vector3();
const _temp = new Vector3();
/** The sort list, filled from `_items`, a pool that only grows, so a sorted cull allocates no items. */
const _list: RenderItem[] = [];
const _items: RenderItem[] = [];

function sortOpaque(a: RenderItem, b: RenderItem): number {
  return a.z - b.z;
}
function sortTransparent(a: RenderItem, b: RenderItem): number {
  return b.z - a.z;
}

function pushItem(start: number, count: number, z: number, index: number): void {
  let item = _items[_list.length];
  if (item === undefined) {
    item = { start, count, z, index };
    _items[_list.length] = item;
  } else {
    item.start = start;
    item.count = count;
    item.z = z;
    item.index = index;
  }
  _list.push(item);
}

/**
 * Replaces a BatchedMesh's linear per-instance frustum scan with a BVH query (O(log n + visible)).
 * Mirrors three r186's `BatchedMesh.onBeforeRender` in what it writes: `_multiDrawStarts`, `_multiDrawCounts`,
 * `_multiDrawCount`, the indirect texture and `_multiDrawBytesPerElement`. Candidates from the BVH still pass three's
 * own bounding-sphere test, so the result is a subset of what the linear scan would draw, never a superset. Array
 * cameras, reversed depth and `perObjectFrustumCulled = false` use three's own scan.
 *
 * **Nested passes keep a stable prefix.** Every material of a batch reads the same `_indirectTexture` (three r186
 * `nodes/accessors/Batch.js:130`). Renders nest: a shadow map renders from inside the first `receiveShadow` object's
 * draw (`AnalyticLightNode.js:261`, via `Renderer._renderObjectDirect` -> `NodeManager.updateBefore`, after
 * `object.onBeforeRender`), a reflector from inside its own. On WebGPU a texture upload (`queue.writeTexture`,
 * `WebGPUTextureUtils.js:1106`) lands at once while a pass's commands are submitted in `finishRender`
 * (`WebGPUBackend.js` ~1396), so rewriting rows an enclosing pass has recorded corrupts that pass; on WebGL the
 * receiving batch whose draw triggered the shadow render draws right after it returns, with whatever the arrays hold.
 * So while a pass that culled this batch is still open (`options.passes` knows), a nested pass:
 * - leaves the rows `[0, n)` that enclosing pass left untouched, and zeroes the counts of those its camera does not need;
 * - appends the ids its camera needs that those rows lack (LOD level by the main camera's distance; sorted for the
 *   nested camera when the batch sorts, the kept rows keep their order);
 * - sets `_multiDrawCount = n + k` and marks the texture for upload only when an appended row differs from what the
 *   texture holds (never for k = 0);
 * - puts the counts and `_multiDrawCount` back when the nested render ends (a `PassTracker.atEnd` callback, run from the
 *   scene's marked `onAfterRender` hook, or when the tracker heals after a render that threw). Not in the batch's own
 *   `onAfterRender`: the ledger reads `_multiDrawCount` after `renderObject` returns, which is after that hook.
 * The WebGPU multi-draw loop reads `_multiDrawCounts` and `_multiDrawCount` when the draw is recorded
 * (`WebGPUBackend.js` ~2127-2135), WebGL when it draws, so each pass draws its own list from rows that stay valid until
 * its submission. The cost: a nested pass issues `n + k` draw commands on WebGPU (zero-count ones included).
 *
 * The culling hook is the batch's own `onBeforeRender` (it replaces three's linear scan, so it cannot compose with it).
 */
export function attachBvhCulling(batch: BatchedMesh, coordinateSystem: CoordinateSystem, options: CullingOptions = {}): CullingHandle {
  const target = batch as Internals;
  const margin = options.margin ?? 0;
  const lod = options.lod;
  const reuseMain = options.nestedPasses === 'reuse-main';
  const passes = options.passes;
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

  // ---- scratch of the running cull, read by visitors created once per batch (a cull allocates nothing) ----
  let count = 0;
  let bytesPerElement = 1;
  let multiplier = 1;
  let sorted = false;
  let changed = false;
  /** Where LOD distances are measured from, in the batch's frame. */
  let eye = _cameraPos;

  // ---- nested-pass state, sized by the slot capacity (`_multiDrawCounts.length`, which is also the id bound) ----
  let capacity = 0;
  /** Per slot: the index count the slot draws when a nested pass has not zeroed it. */
  let fullCounts = new Int32Array(0);
  /** Per instance id: `mark` when the nested camera needs it, `mark + 1` once a slot draws it. */
  let marks = new Uint32Array(0);
  let mark = 0;
  /** The ids the nested camera needs, in query order. */
  let needed = new Int32Array(0);
  let neededCount = 0;
  /**
   * One layer per open pass that culled the batch (a plain cull) or appended to its list, innermost last, with
   * strictly increasing depths. An append layer saved `_multiDrawCounts[0, base)` as it found them.
   */
  const layerDepth: number[] = [];
  const layerPass: number[] = [];
  /** The prefix length an append layer kept; -1 for a plain cull. */
  const layerBase: number[] = [];
  /** The list length the layer left: the prefix of anything nested inside that pass. */
  const layerCount: number[] = [];
  const saved: Int32Array[] = [];
  let layers = 0;
  /** Per depth: the pass whose end is already set to restore this batch. */
  const endRegistered: number[] = [];
  /** The list length of the last outermost-render cull: `reuse-main`'s prefix when no pass is open. */
  let mainCount = 0;
  /** The main camera's position in the batch's frame, for the LOD level of appended ids. */
  const mainPos = new Vector3();
  let hasMainPos = false;

  const ensureCapacity = (): void => {
    const n = target._multiDrawCounts.length;
    if (n === capacity) return;
    const full = new Int32Array(n);
    for (let i = 0, l = Math.min(n, fullCounts.length); i < l; i++) full[i] = fullCounts[i]!;
    fullCounts = full;
    marks = new Uint32Array(n);
    mark = 0;
    needed = new Int32Array(n);
    capacity = n;
  };

  const pushLayer = (depth: number, pass: number, base: number, length: number): void => {
    layerDepth[layers] = depth;
    layerPass[layers] = pass;
    layerBase[layers] = base;
    layerCount[layers] = length;
    layers++;
  };

  /** Drops the innermost layer; an append layer puts back the counts and the list length it found. */
  const popLayer = (): void => {
    layers--;
    const base = layerBase[layers]!;
    if (base < 0) return;
    const snapshot = saved[layers]!;
    const counts = target._multiDrawCounts;
    for (let i = 0; i < base; i++) counts[i] = snapshot[i]!;
    target._multiDrawCount = base;
  };

  /** PassTracker end callback: the render at `depth` is over. */
  const endPass = (depth: number): void => {
    while (layers > 0 && layerDepth[layers - 1]! >= depth) popLayer();
  };

  const setUnits = (geometry: BufferGeometry, material: Material): void => {
    const index = geometry.getIndex();
    bytesPerElement = index === null ? 1 : index.array.BYTES_PER_ELEMENT;
    multiplier = 1;
    // three: wireframe draws lines, twice the indices, with an implied index byte size.
    if ((material as Material & { wireframe?: boolean }).wireframe) {
      multiplier = 2;
      bytesPerElement = geometry.attributes.position!.count > 65535 ? 4 : 2;
    }
  };

  /** `_cameraPos` and `_forward`: the camera in the batch's frame. */
  const cameraInBatchFrame = (camera: Camera): void => {
    _instanceMatrix.copy(target.matrixWorld).invert();
    _cameraPos.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_instanceMatrix);
    _forward.set(0, 0, -1).transformDirection(camera.matrixWorld).transformDirection(_instanceMatrix);
  };

  /** The geometry range to draw for an instance whose bounding sphere is in `_sphere`. */
  const rangeFor = (geometryIndex: number): { start: number; count: number } => {
    let gid = geometryIndex;
    if (lod) {
      const levels = lod.geometryIds.get(geometryIndex);
      if (levels) gid = levels[Math.min(levelFor(_sphere.center.distanceTo(eye), lod.distances), levels.length - 1)]!;
    }
    return target._geometryInfo[gid]!;
  };

  /** Loads the instance's bounding sphere into `_sphere` and runs three's sphere test against `_frustum`. */
  const sphereMeets = (id: number): boolean => {
    const info = target._instanceInfo[id]!;
    if (!info.visible || !info.active) return false;
    batch.getMatrixAt(id, _instanceMatrix);
    batch.getBoundingSphereAt(info.geometryIndex, _sphere)!.applyMatrix4(_instanceMatrix);
    return _frustum.intersectsSphere(_sphere);
  };

  const sortList = (material: Material, camera: Camera): void => {
    const customSort = batch.customSort as ((list: RenderItem[], camera: Camera) => void) | null;
    if (customSort === null) _list.sort(material.transparent ? sortTransparent : sortOpaque);
    else customSort.call(batch, _list, camera);
  };

  /** Writes a slot of a plain cull. */
  const writeSlot = (slot: number, start: number, indexCount: number, id: number): void => {
    target._multiDrawStarts[slot] = start * bytesPerElement * multiplier;
    target._multiDrawCounts[slot] = fullCounts[slot] = indexCount * multiplier;
    target._indirectTexture.image.data[slot] = id;
  };

  /** Writes an appended slot, noting whether its texture row changes. */
  const appendSlot = (slot: number, start: number, indexCount: number, id: number): number => {
    target._multiDrawStarts[slot] = start * bytesPerElement * multiplier;
    target._multiDrawCounts[slot] = fullCounts[slot] = indexCount * multiplier;
    const rows = target._indirectTexture.image.data;
    if (rows[slot] !== id) {
      rows[slot] = id;
      changed = true;
    }
    return slot + 1;
  };

  const visitPlain = (node: BVHNode<object, number>): void => {
    const id = node.object!;
    if (!sphereMeets(id)) return;
    const range = rangeFor(target._instanceInfo[id]!.geometryIndex);
    if (sorted) pushItem(range.start, range.count, _temp.subVectors(_sphere.center, _cameraPos).dot(_forward), id);
    else writeSlot(count++, range.start, range.count, id);
  };

  const visitNeeded = (node: BVHNode<object, number>): void => {
    const id = node.object!;
    if (sphereMeets(id)) needed[neededCount++] = id;
  };

  /** A fresh list for the camera: three's algorithm over BVH candidates, or three's own scan for the cameras it handles differently. */
  const cullPlain = (renderer: unknown, scene: Scene, camera: Camera, geometry: BufferGeometry, material: Material, group: unknown): void => {
    const cam = camera as CullCamera;
    if (!target.perObjectFrustumCulled || cam.isArrayCamera || cam.reversedDepth) {
      prototypeHook.call(target, renderer as never, scene, camera, geometry, material, group as never);
      const counts = target._multiDrawCounts;
      for (let i = 0, n = target._multiDrawCount; i < n; i++) fullCounts[i] = counts[i]!;
      return;
    }
    setUnits(geometry, material);
    sorted = target.sortObjects;
    _matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(target.matrixWorld);
    _frustum.setFromProjectionMatrix(_matrix, coordinateSystem);
    if (lod || sorted) cameraInBatchFrame(camera);
    eye = _cameraPos;
    count = 0;
    _list.length = 0;
    bvh.frustumCulling(_matrix.elements, visitPlain);
    if (sorted) {
      sortList(material, camera);
      for (let k = 0; k < _list.length; k++) {
        const item = _list[k]!;
        writeSlot(count++, item.start, item.count, item.index);
      }
      _list.length = 0;
    }
    target._indirectTexture.needsUpdate = true;
    target._multiDrawCount = count;
    target._multiDrawBytesPerElement = bytesPerElement;
    target._visibilityChanged = false;
  };

  /** The nested cull on top of the rows `[0, base)` (see the doc comment above); returns the new list length. */
  const appendFor = (camera: Camera, geometry: BufferGeometry, material: Material, base: number, layer: number): number => {
    const cam = camera as CullCamera;
    const info = target._instanceInfo;
    const counts = target._multiDrawCounts;
    const rows = target._indirectTexture.image.data;
    if (mark >= 0xfffffffc) {
      marks.fill(0);
      mark = 0;
    }
    mark += 2;
    const covered = mark + 1;

    // 1. The ids the camera needs, by the rules of three's BatchedMesh.onBeforeRender: every visible instance without
    //    perObjectFrustumCulled; three's frustum and scan for an ArrayCamera (FrustumArray, spheres in the batch's frame,
    //    as three tests them) or reversed depth; the BVH otherwise.
    neededCount = 0;
    if (!target.perObjectFrustumCulled) {
      for (let id = 0; id < info.length; id++) if (info[id]!.visible && info[id]!.active) needed[neededCount++] = id;
    } else if (cam.isArrayCamera || cam.reversedDepth) {
      let frustum: Frustum | FrustumArray;
      if (cam.isArrayCamera) {
        frustum = _frustumArray.setFromArrayCamera(camera as ArrayCamera);
      } else {
        _matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(target.matrixWorld);
        frustum = _frustum.setFromProjectionMatrix(_matrix, camera.coordinateSystem, cam.reversedDepth);
      }
      for (let id = 0; id < info.length; id++) {
        const instance = info[id]!;
        if (!instance.visible || !instance.active) continue;
        batch.getMatrixAt(id, _instanceMatrix);
        batch.getBoundingSphereAt(instance.geometryIndex, _sphere)!.applyMatrix4(_instanceMatrix);
        if (frustum.intersectsSphere(_sphere)) needed[neededCount++] = id;
      }
    } else {
      _matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(target.matrixWorld);
      _frustum.setFromProjectionMatrix(_matrix, coordinateSystem);
      bvh.frustumCulling(_matrix.elements, visitNeeded);
    }
    for (let j = 0; j < neededCount; j++) marks[needed[j]!] = mark;

    // 2. The kept rows: a slot the camera needs draws its full count (an enclosing nested pass may have zeroed it), the
    //    rest draw nothing. The counts are saved first; the end of this pass puts them back.
    let snapshot = saved[layer];
    if (snapshot === undefined || snapshot.length < base) saved[layer] = snapshot = new Int32Array(capacity);
    for (let i = 0; i < base; i++) {
      snapshot[i] = counts[i]!;
      const id = rows[i]!;
      if (marks[id] === mark) {
        counts[i] = fullCounts[i]!;
        marks[id] = covered;
      } else {
        counts[i] = 0;
      }
    }

    // 3. Append what the kept rows lack.
    setUnits(geometry, material);
    sorted = target.sortObjects;
    if (lod || sorted) cameraInBatchFrame(camera);
    eye = hasMainPos ? mainPos : _cameraPos;
    changed = false;
    let slot = base;
    if (sorted) {
      _list.length = 0;
      for (let j = 0; j < neededCount; j++) {
        const id = needed[j]!;
        if (marks[id] === covered) continue;
        batch.getMatrixAt(id, _instanceMatrix);
        batch.getBoundingSphereAt(info[id]!.geometryIndex, _sphere)!.applyMatrix4(_instanceMatrix);
        const range = rangeFor(info[id]!.geometryIndex);
        pushItem(range.start, range.count, _temp.subVectors(_sphere.center, _cameraPos).dot(_forward), id);
      }
      sortList(material, camera);
      for (let k = 0; k < _list.length; k++) {
        const item = _list[k]!;
        slot = appendSlot(slot, item.start, item.count, item.index);
      }
      _list.length = 0;
    } else {
      for (let j = 0; j < neededCount; j++) {
        const id = needed[j]!;
        if (marks[id] === covered) continue;
        if (lod) {
          batch.getMatrixAt(id, _instanceMatrix);
          batch.getBoundingSphereAt(info[id]!.geometryIndex, _sphere)!.applyMatrix4(_instanceMatrix);
        }
        const range = rangeFor(info[id]!.geometryIndex);
        slot = appendSlot(slot, range.start, range.count, id);
      }
    }
    if (changed) target._indirectTexture.needsUpdate = true;
    target._multiDrawCount = slot;
    target._multiDrawBytesPerElement = bytesPerElement;
    return slot;
  };

  const hook = function (renderer: unknown, scene: Scene, camera: Camera, geometry: BufferGeometry, material: Material, group: unknown): void {
    ensureCapacity();
    const depth = passes === undefined ? 0 : passes.depth;
    // Drop the layers of passes that are over (their end already restored them, unless a render threw) and this pass's
    // own layer when three culls the batch twice in one pass (onBeforeShadow, then onBeforeRender).
    while (layers > 0 && (layerDepth[layers - 1]! >= depth || passes!.passAt(layerDepth[layers - 1]!) !== layerPass[layers - 1])) popLayer();
    const base = layers > 0 ? layerCount[layers - 1]! : reuseMain && depth > 1 ? mainCount : -1;
    if (base >= 0) {
      const pass = passes!.pass;
      pushLayer(depth, pass, base, appendFor(camera, geometry, material, base, layers));
      if (endRegistered[depth] !== pass) {
        endRegistered[depth] = pass;
        passes!.atEnd(endPass);
      }
      return;
    }
    cullPlain(renderer, scene, camera, geometry, material, group);
    if (depth <= 1) {
      mainCount = target._multiDrawCount;
      if (lod) {
        cameraInBatchFrame(camera);
        mainPos.copy(_cameraPos);
        hasMainPos = true;
      }
    }
    if (depth >= 1) pushLayer(depth, passes!.pass, -1, target._multiDrawCount);
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
      while (layers > 0) popLayer();
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
