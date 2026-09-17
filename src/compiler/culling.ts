import type { BVH, BVHNode } from 'bvh.js';
import {
  type ArrayCamera,
  type BatchedMesh,
  Box3,
  type BufferGeometry,
  type Camera,
  type CoordinateSystem,
  type Frustum,
  FrustumArray,
  type Material,
  Matrix4,
  type Scene,
  Sphere,
  Vector3,
} from 'three';
import { cameraView, frustumFor, InstanceBvh } from './instanceBvh.js';
import { type CullingLod, levelFor } from './lodLevel.js';
import { PassLayers } from './passLayers.js';
import type { PassTracker } from './passTracker.js';
import { FORGE_HOOK, markForgeHook, prependAfterRenderHook, prependRenderHook } from './renderHooks.js';

export { type CullingLod, FORGE_HOOK, levelFor, prependAfterRenderHook, prependRenderHook };

/**
 * How a render pass nested in another render of the scene (a shadow map, a reflection, a portal) culls a batch that no
 * enclosing open pass has culled yet: `per-pass` culls it for the nested camera; `reuse-main` keeps the rows of the
 * batch's last outermost-render cull and appends what the nested camera needs, so its index rows are rewritten only
 * by outermost renders. A batch an enclosing pass has already culled is served from a stable prefix under both
 * policies (see `attachBvhCulling`).
 */
export type NestedPassPolicy = 'per-pass' | 'reuse-main';

export interface CullingOptions {
  /**
   * Box margin for instances that move (default 0, and `World` always uses 0): leaves are built and refitted this much
   * larger, so `move` can leave one alone while the new box still fits. It changes what is drawn: the BVH's exact-box
   * prefilter is tighter than three's sphere test after it, so a looser box admits instances the exact box rejects.
   * Measured on the bossfight bench: +2 draw calls, +24 triangles in a point light's shadow pass, 1-4 pixels of 480000.
   */
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

export interface CullingHandle {
  bvh: BVH<object, number>;
  /** The box margin the tree was built with, and that `move`/`insert` refit by; 0 for every batch `World` compiles. */
  readonly margin: number;
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
const _instanceMatrix = new Matrix4();
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
 * Replaces a BatchedMesh's linear per-instance frustum scan with a BVH query (O(log n + visible)), writing what three
 * r186's `BatchedMesh.onBeforeRender` writes: `_multiDrawStarts`, `_multiDrawCounts`, `_multiDrawCount`, the indirect
 * texture and `_multiDrawBytesPerElement`. Candidates still pass three's bounding-sphere test, so the result is a
 * subset of the linear scan's (a strict one at `margin` 0, see `CullingOptions.margin`). Array cameras, reversed depth
 * and `perObjectFrustumCulled = false` use three's own scan.
 *
 * Nested passes keep a stable prefix. Every material of a batch reads the same `_indirectTexture` (`Batch.js:130`), a
 * shadow map renders from inside the first `receiveShadow` object's draw (`AnalyticLightNode.js:261`), and a WebGPU
 * texture upload (`WebGPUTextureUtils.js:1106`) lands while the enclosing pass is still being recorded
 * (`WebGPUBackend.js` ~1396): rewriting rows an open pass recorded would corrupt it. So while a pass that culled this
 * batch is open, a nested pass keeps its rows `[0, n)`, zeroes the counts its camera does not need, appends what they
 * lack (texture marked only when an appended row changed) and restores the counts when the nested render ends
 * (`PassTracker.atEnd`; the batch's own `onAfterRender` runs before the ledger reads `_multiDrawCount`). The cost: a
 * nested pass issues `n + k` draw commands on WebGPU, zero-count ones included.
 * The hook is the batch's own `onBeforeRender`: it replaces three's scan, so it cannot compose with it.
 */
export function attachBvhCulling(
  batch: BatchedMesh,
  coordinateSystem: CoordinateSystem,
  options: CullingOptions = {},
): CullingHandle {
  const target = batch as Internals;
  const lod = options.lod;
  const reuseMain = options.nestedPasses === 'reuse-main';
  const passes = options.passes;

  /** The instance's box in the batch's frame. */
  const boxOf = (id: number): Box3 => {
    batch.getBoundingBoxAt(target._instanceInfo[id]!.geometryIndex, _box);
    batch.getMatrixAt(id, _instanceMatrix);
    return _box.applyMatrix4(_instanceMatrix);
  };
  const tree = new InstanceBvh(coordinateSystem, boxOf, options.margin ?? 0);
  const ids: number[] = [];
  for (let i = 0; i < target._instanceInfo.length; i++) if (target._instanceInfo[i]!.active) ids.push(i);
  tree.build(ids);
  const bvh = tree.bvh;

  const prototypeHook = Object.getPrototypeOf(batch).onBeforeRender as BatchedMesh['onBeforeRender'];

  // Scratch of the running cull; the visitors below are created once per batch, so a cull allocates nothing.
  /** The next slot a plain cull or an append writes. */
  let slot = 0;
  let bytesPerElement = 1;
  let multiplier = 1;
  let sorted = false;
  /** A slot's texture row changed since the running append started. */
  let changed = false;
  /** Where LOD distances are measured from, in the batch's frame. */
  let eye = _cameraPos;

  // Nested-pass state, sized to `_multiDrawCounts.length` (also the id bound) by `ensureCapacity`.
  let capacity = 0;
  /** Per slot: the index count the slot draws when a nested pass has not zeroed it. */
  let fullCounts = new Int32Array(0);
  /** Per instance id: `mark` when the nested camera needs it, `mark + 1` once a slot draws it. */
  let marks = new Uint32Array(0);
  let mark = 0;
  /** The ids the nested camera needs, in query order. */
  let needed = new Int32Array(0);
  let neededCount = 0;
  /** The prefix length an append layer kept, per layer; -1 for a plain cull. */
  const layerBase: number[] = [];
  /** The list length the layer left: the prefix of anything nested inside that pass. */
  const layerCount: number[] = [];
  /** `_multiDrawCounts[0, base)` as an append layer found them. */
  const saved: Int32Array[] = [];
  /**
   * One layer per open pass that culled the batch (a plain cull) or appended to its list; popping an append layer puts
   * back the counts and the list length it found.
   */
  const layers = new PassLayers(passes, (layer) => {
    const base = layerBase[layer]!;
    if (base < 0) return;
    const snapshot = saved[layer]!;
    const counts = target._multiDrawCounts;
    for (let i = 0; i < base; i++) counts[i] = snapshot[i]!;
    target._multiDrawCount = base;
  });
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

  /** Loads the instance's bounding sphere, in the batch's frame, into `_sphere`. */
  const loadSphere = (id: number): void => {
    batch.getMatrixAt(id, _instanceMatrix);
    batch.getBoundingSphereAt(target._instanceInfo[id]!.geometryIndex, _sphere)!.applyMatrix4(_instanceMatrix);
  };

  /** Loads the instance's bounding sphere into `_sphere` and runs three's sphere test against `frustum`. */
  const sphereMeets = (id: number, frustum: Frustum | FrustumArray): boolean => {
    const info = target._instanceInfo[id]!;
    if (!info.visible || !info.active) return false;
    loadSphere(id);
    return frustum.intersectsSphere(_sphere);
  };

  /** Writes a slot, noting whether its texture row changes. */
  const writeSlot = (at: number, start: number, indexCount: number, id: number): void => {
    target._multiDrawStarts[at] = start * bytesPerElement * multiplier;
    target._multiDrawCounts[at] = fullCounts[at] = indexCount * multiplier;
    const rows = target._indirectTexture.image.data;
    if (rows[at] !== id) {
      rows[at] = id;
      changed = true;
    }
  };

  /** Lists an instance whose sphere is in `_sphere` (when `sorted` or `lod` need it): the sort list, or the next slot. */
  const emit = (id: number): void => {
    const range = rangeFor(target._instanceInfo[id]!.geometryIndex);
    if (sorted) pushItem(range.start, range.count, _temp.subVectors(_sphere.center, _cameraPos).dot(_forward), id);
    else writeSlot(slot++, range.start, range.count, id);
  };

  /** Sorts the list as three would and writes it to the slots from `slot` on. */
  const drainSorted = (material: Material, camera: Camera): void => {
    const customSort = batch.customSort as ((list: RenderItem[], camera: Camera) => void) | null;
    if (customSort === null) _list.sort(material.transparent ? sortTransparent : sortOpaque);
    else customSort.call(batch, _list, camera);
    for (let k = 0; k < _list.length; k++) {
      const item = _list[k]!;
      writeSlot(slot++, item.start, item.count, item.index);
    }
    _list.length = 0;
  };

  const visitPlain = (node: BVHNode<object, number>): void => {
    const id = node.object!;
    if (sphereMeets(id, cameraView.frustum)) emit(id);
  };

  const visitNeeded = (node: BVHNode<object, number>): void => {
    const id = node.object!;
    if (sphereMeets(id, cameraView.frustum)) needed[neededCount++] = id;
  };

  /** A fresh list for the camera: three's algorithm over BVH candidates, or three's own scan for the cameras it handles differently. */
  const cullPlain = (
    renderer: unknown,
    scene: Scene,
    camera: Camera,
    geometry: BufferGeometry,
    material: Material,
    group: unknown,
  ): void => {
    const cam = camera as CullCamera;
    if (!target.perObjectFrustumCulled || cam.isArrayCamera || cam.reversedDepth) {
      prototypeHook.call(target, renderer as never, scene, camera, geometry, material, group as never);
      const counts = target._multiDrawCounts;
      for (let i = 0, n = target._multiDrawCount; i < n; i++) fullCounts[i] = counts[i]!;
      return;
    }
    setUnits(geometry, material);
    sorted = target.sortObjects;
    frustumFor(camera, target, coordinateSystem);
    if (lod || sorted) cameraInBatchFrame(camera);
    eye = _cameraPos;
    slot = 0;
    _list.length = 0;
    bvh.frustumCulling(cameraView.matrix.elements, visitPlain);
    if (sorted) drainSorted(material, camera);
    target._indirectTexture.needsUpdate = true;
    target._multiDrawCount = slot;
    target._multiDrawBytesPerElement = bytesPerElement;
    target._visibilityChanged = false;
  };

  /** The nested cull on top of the rows `[0, base)` (see the doc comment above); returns the new list length. */
  const appendFor = (
    camera: Camera,
    geometry: BufferGeometry,
    material: Material,
    base: number,
    layer: number,
  ): number => {
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

    // The ids the camera needs, by the rules of three's BatchedMesh.onBeforeRender: every visible instance without
    // perObjectFrustumCulled; three's frustum and scan for an ArrayCamera (FrustumArray, spheres in the batch's frame,
    // as three tests them) or reversed depth; the BVH otherwise.
    neededCount = 0;
    if (!target.perObjectFrustumCulled) {
      for (let id = 0; id < info.length; id++) if (info[id]!.visible && info[id]!.active) needed[neededCount++] = id;
    } else if (cam.isArrayCamera || cam.reversedDepth) {
      const frustum = cam.isArrayCamera
        ? _frustumArray.setFromArrayCamera(camera as ArrayCamera)
        : frustumFor(camera, target, camera.coordinateSystem, cam.reversedDepth);
      for (let id = 0; id < info.length; id++) if (sphereMeets(id, frustum)) needed[neededCount++] = id;
    } else {
      frustumFor(camera, target, coordinateSystem);
      bvh.frustumCulling(cameraView.matrix.elements, visitNeeded);
    }
    for (let j = 0; j < neededCount; j++) marks[needed[j]!] = mark;

    // The kept rows: a slot the camera needs draws its full count (an enclosing nested pass may have zeroed it), the
    // rest draw nothing. The counts are saved first; the end of this pass puts them back.
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

    // Append what the kept rows lack.
    setUnits(geometry, material);
    sorted = target.sortObjects;
    if (lod || sorted) cameraInBatchFrame(camera);
    eye = hasMainPos ? mainPos : _cameraPos;
    changed = false;
    slot = base;
    _list.length = 0;
    for (let j = 0; j < neededCount; j++) {
      const id = needed[j]!;
      if (marks[id] === covered) continue;
      if (sorted || lod) loadSphere(id);
      emit(id);
    }
    if (sorted) drainSorted(material, camera);
    if (changed) target._indirectTexture.needsUpdate = true;
    target._multiDrawCount = slot;
    target._multiDrawBytesPerElement = bytesPerElement;
    return slot;
  };

  const hook = markForgeHook(
    (
      renderer: unknown,
      scene: Scene,
      camera: Camera,
      geometry: BufferGeometry,
      material: Material,
      group: unknown,
    ): void => {
      ensureCapacity();
      const depth = passes === undefined ? 0 : passes.depth;
      // Drop the layers of passes that are over (their end already restored them, unless a render threw) and this
      // pass's own layer when three culls the batch twice in one pass (onBeforeShadow, then onBeforeRender).
      layers.popClosed(depth);
      if (layers.size > 0 && layers.topDepth === depth) layers.pop();
      const base = layers.size > 0 ? layerCount[layers.size - 1]! : reuseMain && depth > 1 ? mainCount : -1;
      if (base >= 0) {
        const layer = layers.size;
        const length = appendFor(camera, geometry, material, base, layer);
        layers.push(depth);
        layerBase[layer] = base;
        layerCount[layer] = length;
        layers.restoreAtEnd(depth);
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
      if (depth >= 1) {
        const layer = layers.push(depth);
        layerBase[layer] = -1;
        layerCount[layer] = target._multiDrawCount;
      }
    },
  );
  batch.onBeforeRender = hook as unknown as BatchedMesh['onBeforeRender'];

  return {
    bvh,
    margin: tree.margin,
    move(id) {
      tree.move(id);
    },
    insert(id) {
      tree.insert(id);
    },
    remove(id) {
      tree.remove(id);
    },
    detach() {
      layers.clear();
      if (Object.hasOwn(batch, 'onBeforeRender')) delete (batch as { onBeforeRender?: unknown }).onBeforeRender;
      tree.clear();
    },
  };
}
