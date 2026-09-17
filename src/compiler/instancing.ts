import type { BVHNode } from 'bvh.js';
import {
  Box3,
  type BufferGeometry,
  type Camera,
  type Color,
  type CoordinateSystem,
  InstancedBufferAttribute,
  InstancedMesh,
  type Material,
  Matrix4,
  type Object3D,
  type Scene,
  Sphere,
  Vector3,
} from 'three';
import { InstanceBvh, viewProjection } from './instanceBvh.js';
import { CasterPool, type RendererLike } from './instancing/casterPool.js';
import { InstanceRows, MARK_ALL, MARK_ROWS, MARK_WHOLE } from './instancing/rows.js';
import { levelFor } from './lodLevel.js';
import { PassLayers } from './passLayers.js';
import type { PassTracker } from './passTracker.js';
import { FORGE_HOOK, markForgeHook } from './renderHooks.js';

export { FORGE_HOOK };

export interface InstanceCullingHandle {
  /**
   * Update one instance's master matrix, in the space of the mesh's parent (`World` passes scene space), and its BVH
   * leaf; the next cull rewrites every row through the usual update marking. The bounds are left as they are: call
   * `refreshBounds()` once after a batch of moves.
   */
  setMatrixAt(id: number, matrix: Matrix4): void;
  /**
   * Recompute the bounding box and sphere of every level from the master matrices (every instance, drawn or not; not
   * the compacted rows), so three's whole-object frustum test keeps a moved instance.
   */
  refreshBounds(): void;
  setVisibleAt(id: number, visible: boolean): void;
  getVisibleAt(id: number): boolean;
  /** Restore an uncompacted mesh drawing every instance. */
  detach(): void;
}

/** An InstancedMesh whose visible instances are compacted to the front of its buffers every frame. */
export interface CulledInstancedMesh extends InstancedMesh {
  /** Compacted index -> master index: row k of the instance buffers holds instance `visibleIds[k]`; its length is `count`. */
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
  /**
   * The tracker installed on the scene the mesh renders in (`new PassTracker().install(scene)`; `World` does this).
   * Without it every call counts as an outermost render and compacts for its camera.
   */
  passes?: PassTracker;
}

const _box = new Box3();
const _matrix = new Matrix4();
const _inverse = new Matrix4();
const _position = new Vector3();

function same16(a: Float64Array, b: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Hardware instancing for geometry repeated many times, with the per-instance frustum culling `InstancedMesh` lacks:
 * a BVH over instance boxes selects the visible set, which is copied to the front of `instanceMatrix` /
 * `instanceColor` and `count` is set. A row is written only when the instance it holds changes.
 *
 * Nested passes keep a stable prefix. In three r186 the matrices above the uniform-buffer limit and the colours live
 * in buffers shared by every render object of the mesh, synced once per frame (`nodes/accessors/Instance.js` ~41-69,
 * ~175-199) and checked for upload at most once per `info.render.calls` (`renderers/common/Geometries.js` ~300-334),
 * and a queued WebGPU write lands while an open pass is still being submitted. So rows a pass has drawn are never
 * rewritten while it is open. Per call at `PassTracker` depth d:
 * - d <= 1 (an outermost render, or no tracker): compact rows `[0, n)` for the camera, skipped while the camera and
 *   the rows are unchanged. Only these calls mark update ranges; a nested write marks the whole buffers, because a
 *   nested render object's sync replaces the ranges the main pass has not uploaded yet (`Instance.js:180-196`).
 * - d >= 2 before the outermost render compacted the mesh: compact for the main camera first, under either policy.
 * - A shadow pass (`scene.overrideMaterial.isShadowPassMaterial`) keeps the enclosing rows and appends the casters
 *   its own light reaches, from the frame's caster pool (see `CasterPool`), in the pool's order so a tail that
 *   already holds them is left alone. The tail has to hold exactly that light's casters: an `InstancedMesh` draws one
 *   range `[0, count)` and nothing sets `firstInstance` (`renderers/common/RenderObject.js` ~603-626).
 * - Any other nested pass (a reflection) draws the enclosing rows and appends nothing: instances outside the main
 *   camera's frustum are missing from reflections.
 * - `count` and `visibleIds` go back to the enclosing length when the nested render ends (`PassTracker.atEnd`), never
 *   in the mesh's own `onAfterRender`, which three calls before the ledger reads the draw.
 * `matrices` are in the space of the parent the level meshes are added to (`World`: the scene). The bounds cover every
 * instance; `handle.refreshBounds()` recomputes them after moves. The culling hook is the level meshes' own
 * `onBeforeRender` (marked `FORGE_HOOK`; `InstancedMesh` has none to compose).
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
  const passes = options.passes;

  const masterMatrices = new Float32Array(n * 16);
  const masterColors = colors ? new Float32Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    matrices[i]!.toArray(masterMatrices, i * 16);
    if (masterColors && colors) colors[i]!.toArray(masterColors, i * 3);
  }

  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  const geometryBox = geometry.boundingBox!;
  /** The instance's box in the group's frame. */
  const boxOf = (id: number): Box3 => {
    _matrix.fromArray(masterMatrices, id * 16);
    return _box.copy(geometryBox).applyMatrix4(_matrix);
  };
  const bounds = new Box3();
  const tree = new InstanceBvh(coordinateSystem, boxOf);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(i);
  tree.build(ids, bounds);
  const bvh = tree.bvh;
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
  const rows = new InstanceRows(levels, masterMatrices, masterColors);
  const { lists, listLength } = rows;

  let useLod = false;
  /** Where LOD distances are measured from, in the group's frame. */
  const eye = new Vector3();
  const place = (id: number): void => {
    if (!visibleMask[id]) return;
    let level = 0;
    if (useLod) {
      _position.set(masterMatrices[id * 16 + 12]!, masterMatrices[id * 16 + 13]!, masterMatrices[id * 16 + 14]!);
      level = Math.min(levelFor(_position.distanceTo(eye), distances), levelCount - 1);
    }
    lists[level]![listLength[level]!++] = id;
  };
  const visitPlace = (node: BVHNode<object, number>): void => place(node.object!);

  const setEye = (group: Object3D, camera: Camera): void => {
    _inverse.copy(group.matrixWorld).invert();
    eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inverse);
  };

  const mainKey = new Float64Array(16);
  let hasMainKey = false;
  /** Visibility or a matrix changed since the last outermost compaction. */
  let mainDirty = false;
  const mainCount = new Int32Array(levelCount);
  /** The main camera's position in the group's frame, for the LOD level of appended instances. */
  const mainEye = new Vector3();
  let hasMainEye = false;

  /** The outermost compaction: rows `[0, n)` for `camera`, skipped while its view and the rows are unchanged. */
  const compactForMain = (group: Object3D, camera: Camera): void => {
    const projection = viewProjection(camera, group);
    if (!mainDirty && hasMainKey && same16(mainKey, projection.elements)) {
      for (let L = 0; L < levelCount; L++) rows.setCount(L, mainCount[L]!);
      return;
    }
    mainKey.set(projection.elements);
    hasMainKey = true;
    mainDirty = false;
    listLength.fill(0);
    useLod = levelCount > 1;
    if (useLod) {
      setEye(group, camera);
      mainEye.copy(eye);
      hasMainEye = true;
    }
    if ((camera as Camera & { isArrayCamera?: boolean }).isArrayCamera) {
      for (let i = 0; i < n; i++) place(i);
    } else {
      bvh.frustumCulling(projection.elements, visitPlace);
    }
    for (let L = 0; L < levelCount; L++) {
      rows.writeRows(L, 0);
      mainCount[L] = listLength[L]!;
    }
  };

  const casters = new CasterPool(n, bvh, visibleMask);
  const marks = new Uint32Array(n);
  let mark = 0;

  /** `place` for a caster no kept row holds. */
  const placeUnheld = (id: number): void => {
    if (marks[id] !== mark) place(id);
  };

  /**
   * Appends the casters the frame's shadow camera `index` reaches that rows `[0, base)` of no level hold, after each
   * level's base (`layerBase` at `at`), in the caster list's own order so a tail that already holds them is left alone.
   */
  const appendCasters = (at: number, group: Object3D, camera: Camera, index: number): void => {
    if (mark >= 0xfffffffe) {
      marks.fill(0);
      mark = 0;
    }
    mark++;
    for (let L = 0; L < levelCount; L++) {
      const held = levels[L]!.visibleIds;
      for (let k = 0, base = layerBase[at + L]!; k < base; k++) marks[held[k]!] = mark;
    }
    listLength.fill(0);
    useLod = levelCount > 1;
    if (useLod) {
      if (hasMainEye) eye.copy(mainEye);
      else setEye(group, camera);
    }
    casters.each(index, placeUnheld);
    for (let L = 0; L < levelCount; L++) rows.writeRows(L, layerBase[at + L]!);
  };

  /** Per layer and level: the length the layer kept (-1 on level 0 for a compaction) and the length it left. */
  const layerBase: number[] = [];
  const layerCount: number[] = [];
  const layers = new PassLayers(passes, (layer) => {
    const at = layer * levelCount;
    if (layerBase[at]! < 0) return;
    for (let L = 0; L < levelCount; L++) rows.setCount(L, layerBase[at + L]!);
  });
  const pushCompaction = (depth: number, pass: number): void => {
    const at = layers.push(depth, pass) * levelCount;
    for (let L = 0; L < levelCount; L++) {
      layerBase[at + L] = -1;
      layerCount[at + L] = levels[L]!.count;
    }
  };

  const hook = markForgeHook(function (
    this: CulledInstancedMesh,
    renderer: unknown,
    scene: Scene | null,
    camera: Camera,
  ): void {
    const depth = passes === undefined ? 0 : passes.depth;
    // Only an outermost render with a tracker marks rows; anywhere else a later sync could replace ranges not yet
    // uploaded, so writes mark the whole buffers (see the doc comment). Matrices within the uniform-buffer limit are
    // written whole per render object and carry no ranges.
    const outermost = passes !== undefined && depth === 1;
    const limit = (renderer as RendererLike)?.backend?.capabilities?.getUniformBufferLimit?.();
    rows.begin(
      typeof limit === 'number' && n * 64 > limit ? (outermost ? MARK_ROWS : MARK_WHOLE) : MARK_ALL,
      outermost ? MARK_ROWS : MARK_WHOLE,
    );
    layers.popClosed(depth);
    if (depth <= 1) {
      // An outermost render. At depth 1 a remaining layer means it compacted the group already: another level, or a
      // nested pass that reached the group first.
      if (depth === 1 && layers.size > 0) return;
      compactForMain(this, camera);
      if (depth === 1) pushCompaction(1, passes!.pass);
      return;
    }
    if (layers.topDepth === depth) return; // this pass served the group already (another level)
    if (layers.size === 0) {
      compactForMain(this, passes!.mainCamera ?? camera);
      pushCompaction(1, passes!.passAt(1));
    }
    const from = (layers.size - 1) * levelCount;
    const at = layers.push(depth) * levelCount;
    for (let L = 0; L < levelCount; L++) layerBase[at + L] = layerCount[from + L]!;
    if (
      scene !== null &&
      (scene.overrideMaterial as { isShadowPassMaterial?: boolean } | null)?.isShadowPassMaterial === true
    ) {
      // The pool must be up to date before `appendCasters` reads it.
      const index = casters.ensure(passes!.frame, renderer as RendererLike, scene, camera, this);
      appendCasters(at, this, camera, index);
    } else {
      for (let L = 0; L < levelCount; L++) rows.setCount(L, layerBase[at + L]!);
    }
    for (let L = 0; L < levelCount; L++) layerCount[at + L] = levels[L]!.count;
    layers.restoreAtEnd(depth);
  });
  for (const mesh of levels) mesh.onBeforeRender = hook as unknown as InstancedMesh['onBeforeRender'];

  let detached = false;
  const handle: InstanceCullingHandle = {
    setMatrixAt(id, matrix) {
      matrix.toArray(masterMatrices, id * 16);
      tree.move(id);
      rows.invalidate();
      mainDirty = true;
      casters.invalidate();
    },
    refreshBounds() {
      bounds.makeEmpty();
      for (let i = 0; i < n; i++) bounds.union(boxOf(i));
      bounds.getBoundingSphere(sphere);
      for (const mesh of levels) {
        if (mesh.boundingBox === null) mesh.boundingBox = new Box3();
        if (mesh.boundingSphere === null) mesh.boundingSphere = new Sphere();
        mesh.boundingBox.copy(bounds);
        mesh.boundingSphere.copy(sphere);
      }
    },
    setVisibleAt(id, visible) {
      const value = visible ? 1 : 0;
      if (visibleMask[id] === value) return;
      visibleMask[id] = value;
      mainDirty = true;
      casters.invalidate();
    },
    getVisibleAt(id) {
      return visibleMask[id] === 1;
    },
    detach() {
      if (detached) return;
      detached = true;
      layers.clear();
      for (const mesh of levels) {
        if (Object.hasOwn(mesh, 'onBeforeRender')) delete (mesh as { onBeforeRender?: unknown }).onBeforeRender;
      }
      const base = levels[0]!;
      base.instanceMatrix.array.set(masterMatrices);
      base.instanceMatrix.clearUpdateRanges();
      base.instanceMatrix.needsUpdate = true;
      if (base.instanceColor && masterColors) {
        base.instanceColor.array.set(masterColors);
        base.instanceColor.clearUpdateRanges();
        base.instanceColor.needsUpdate = true;
      }
      base.count = n;
      base.visibleIds = ids.slice();
      for (const mesh of levels.slice(1)) {
        mesh.count = 0;
        mesh.visibleIds = [];
      }
      tree.clear();
    },
  };
  for (const mesh of levels) mesh.forgeCulling = handle;
  return levels[0]!;
}
