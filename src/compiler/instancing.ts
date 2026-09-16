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
  type BufferAttribute,
  type BufferGeometry,
  type Camera,
  type Color,
  type CoordinateSystem,
  type Light,
  type Material,
  type Object3D,
  type Scene,
} from 'three';
import { FORGE_HOOK, levelFor, PassLayers, type NestedPassPolicy } from './culling.js';
import type { PassTracker } from './passTracker.js';

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
   * @deprecated Ignored. A compacted instanced mesh behaves the same under both policies: a nested pass that reaches it
   * before the outermost render did compacts it for the main camera first (see `createCulledInstancedMesh`).
   */
  nestedPasses?: NestedPassPolicy;
  /**
   * The tracker installed on the scene the mesh renders in (`new PassTracker().install(scene)`; `World` does this).
   * Without it every call counts as an outermost render and compacts for its camera.
   */
  passes?: PassTracker;
}

/** Past this many pending update ranges an attribute's list is replaced by one range over the whole buffer. */
const MAX_UPDATE_RANGES = 32;

/** How a write marks an instance attribute for upload. */
const MARK_ALL = 0; // needsUpdate without ranges: a uniform buffer per render object is written whole anyway
const MARK_ROWS = 1; // a range over the rows written
const MARK_WHOLE = 2; // a range over the whole buffer

const _box = new Box3();
const _nodeBox = new Box3();
const _matrix = new Matrix4();
const _inverse = new Matrix4();
const _frustum = new Frustum();
const _position = new Vector3();
const _cube = new Float32Array(6);
const _instanceBox = new Float32Array(6);

type CameraLike = Camera & { isArrayCamera?: boolean; reversedDepth?: boolean; far?: number };
type ShadowLight = Light & {
  isPointLight?: boolean;
  distance?: number;
  shadow?: { camera: CameraLike; autoUpdate: boolean; needsUpdate: boolean; updateMatrices(light: Light): void } | null;
};
/** What the hook reads from three r186's renderer: `lighting` (Lighting.getNode) and the backend's uniform-buffer limit. */
type RendererLike = {
  lighting?: { getNode?(scene: Object3D): { getLights?(): Light[] } };
  backend?: { capabilities?: { getUniformBufferLimit?(): number } };
} | null;

function same16(a: Float64Array, b: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Marks an instance attribute for upload (`mode`: MARK_ALL, MARK_ROWS or MARK_WHOLE). A whole-buffer range stays in the
 * list until three's frame event consumes it, so a later sync never uploads less than every row written before it.
 */
function markRows(attribute: BufferAttribute, start: number, count: number, mode: number): void {
  if (mode !== MARK_ALL) {
    const ranges = attribute.updateRanges;
    const whole = attribute.array.length;
    const last = ranges.length > 0 ? ranges[ranges.length - 1]! : null;
    if (ranges.length >= MAX_UPDATE_RANGES) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, whole);
    } else if (mode === MARK_WHOLE) {
      if (last === null || last.start !== 0 || last.count !== whole) attribute.addUpdateRange(0, whole);
    } else {
      attribute.addUpdateRange(start, count);
    }
  }
  attribute.needsUpdate = true;
}

/**
 * Hardware instancing for geometry repeated many times, with per-instance frustum culling that `InstancedMesh` lacks:
 * a BVH over instance boxes selects the visible set, which is copied to the front of `instanceMatrix` /
 * `instanceColor` and `count` is set. A row is written only when the instance it holds changes.
 *
 * **Nested passes keep a stable prefix.** Shadow maps and reflections render from inside a pass that has already
 * drawn the mesh (a shadow map from the first `receiveShadow` object's draw). In three r186:
 * - Above the uniform-buffer limit (`count * 64 > getUniformBufferLimit()`) the matrices live in one
 *   `InstancedInterleavedBuffer` shared by every render object of the mesh, and colours always in one attribute;
 *   their version and update ranges are copied by an `OnBeforeFrameUpdate` event once per frame per node builder
 *   (`nodes/accessors/Instance.js` ~41-69, ~175-199). A queued WebGPU write lands at once while a pass is submitted
 *   when it ends, so a nested pass that rewrote the rows an open pass drew would corrupt that pass.
 * - `Geometries.updateAttribute` (`renderers/common/Geometries.js` ~300-334) checks such a buffer for upload at most
 *   once per `info.render.calls`, which every `render()` advances, nested ones included, and nothing restores: a draw
 *   in the enclosing pass after a nested render that checked the buffer cannot upload rows written since.
 * So, per call at `PassTracker` depth d:
 * - d <= 1 (an outermost render, or no tracker): compact for the camera, skipped while the camera and the rows are
 *   unchanged (the main key, kept apart from the nested passes' key).
 * - d >= 2, the outermost render has not compacted the mesh yet: compact it for the main camera first (under either
 *   `nestedPasses` policy), so no later write in this frame rewrites rows a pass has uploaded.
 * - A shadow pass (`scene.overrideMaterial.isShadowPassMaterial`) keeps the enclosing pass's rows `[0, n)` and appends
 *   the instances **its own light** reaches: a directional or spot light's frustum after `shadow.updateMatrices(light)`,
 *   a point light's cube of half-size `light.distance || shadow.camera.far` (the six faces of `PointShadowNode`; its
 *   filter shadows up to that distance along the dominant axis). Every light of the frame is queried once, at the
 *   first shadow pass (rebuilt only when a light, its view or the instances changed: the nested key), into one
 *   deduplicated list in which each entry records the lights that reach it (`casterLightBits`, one bit per shadow camera of
 *   the frame; a camera past the 32nd carries no bit and its pass appends the whole list, a correct superset).
 *   A pass then appends its own light's entries **in that list's order**, so a light whose casters are the rows the
 *   tail already holds writes nothing — a point light's six faces always do, and so does any light whose set is a
 *   prefix of the pass before it. `writeRows` marks only rows that change, so the upload cost is one bounded write
 *   per shadow pass whose casters differ from the tail, and none otherwise.
 *   Per-light selection has to rewrite the tail because an `InstancedMesh` draws one contiguous range `[0, count)`:
 *   three r186's `RenderObject.getDrawParameters` takes `instanceCount` from `object.count` and leaves `firstInstance`
 *   at 0, which nothing else ever writes (`renderers/common/RenderObject.js` ~603-626), and neither backend offers a
 *   base instance. So a pass cannot skip an interior appended row the way a BatchedMesh zeroes a multi-draw slot.
 * - Update ranges. An outermost compaction (with a tracker) marks only the rows it changed (`addUpdateRange`). A write
 *   in a nested pass marks the whole matrix and colour buffers. A receiver's render object runs the instance
 *   `OnBeforeFrameUpdate` event before its `ShadowNode`: the event sits in the position stack, which
 *   `NodeBuilder.build` flows before its fragment/vertex loop (`NodeBuilder.js` ~3193), and `Node.build` registers
 *   update nodes in its setup branch. So the main pass's ranges are already synced into the shared buffer when the
 *   shadow render object's event replaces them with its own and uploads (`Instance.js:180-196`); back in the main pass
 *   the buffer is not checked again in that render call, and rows `[0, count)` would stay stale on the GPU. Colours
 *   always use a shared attribute synced the same way; matrices on the uniform-buffer path carry no ranges.
 * - Any other nested pass (a reflection) draws the enclosing pass's rows and appends nothing: instances outside the
 *   main camera's frustum are missing from reflections.
 * - `count` and `visibleIds` go back to the enclosing length when the nested render ends (a `PassTracker.atEnd`
 *   callback, or the tracker's reset after a render that threw), never in the mesh's own `onAfterRender`, which three
 *   calls before the ledger reads the draw.
 * `matrices` are in the space of the parent the level meshes are added to (`World` adds them to the scene and passes
 * scene-space matrices). The bounds cover every instance; `handle.refreshBounds()` recomputes them after moves.
 * The culling hook is the level meshes' own `onBeforeRender` (marked `FORGE_HOOK`; `InstancedMesh` has none to compose).
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

  // ---- rows: what the instance buffers hold ----
  /** Per level: the instance row k holds, -1 when unknown (level 0 starts with every instance in order). */
  const rowIds = levels.map((_, L) => {
    const rows = new Int32Array(n).fill(-1);
    if (L === 0) for (let i = 0; i < n; i++) rows[i] = i;
    return rows;
  });
  /** A master matrix changed: every row is rewritten at its next write. */
  let rowsStale = false;
  /** How this call's writes mark the matrices and the colours (see `markRows`), set at the start of every hook call. */
  let matrixMark = MARK_ALL;
  let colorMark = MARK_WHOLE;
  /** Per level: the instances of the running cull or append, and how many. */
  const lists = levels.map(() => new Int32Array(n));
  const listLength = new Int32Array(levelCount);

  const setCount = (L: number, count: number): void => {
    const mesh = levels[L]!;
    mesh.count = count;
    mesh.visibleIds.length = count;
  };

  /** Writes `lists[L]` into rows `[at, at + length)` of level L and sets its count; marks only the rows that changed. */
  const writeRows = (L: number, at: number): void => {
    const mesh = levels[L]!;
    const rows = rowIds[L]!;
    const list = lists[L]!;
    const length = listLength[L]!;
    const matrixArray = mesh.instanceMatrix.array as Float32Array;
    const colorArray = mesh.instanceColor ? (mesh.instanceColor.array as Float32Array) : null;
    const visible = mesh.visibleIds;
    visible.length = at + length;
    let first = -1;
    let last = -1;
    for (let k = 0; k < length; k++) {
      const id = list[k]!;
      const row = at + k;
      visible[row] = id;
      if (rows[row] === id) continue;
      rows[row] = id;
      for (let e = 0; e < 16; e++) matrixArray[row * 16 + e] = masterMatrices[id * 16 + e]!;
      if (colorArray !== null && masterColors !== null) for (let e = 0; e < 3; e++) colorArray[row * 3 + e] = masterColors[id * 3 + e]!;
      if (first < 0) first = row;
      last = row;
    }
    mesh.count = at + length;
    if (first < 0) return;
    markRows(mesh.instanceMatrix, first * 16, (last - first + 1) * 16, matrixMark);
    if (mesh.instanceColor) markRows(mesh.instanceColor, first * 3, (last - first + 1) * 3, colorMark);
  };

  // ---- compaction for a camera ----
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
    _matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(group.matrixWorld);
    if (!mainDirty && hasMainKey && same16(mainKey, _matrix.elements)) {
      for (let L = 0; L < levelCount; L++) setCount(L, mainCount[L]!);
      return;
    }
    mainKey.set(_matrix.elements);
    hasMainKey = true;
    mainDirty = false;
    listLength.fill(0);
    useLod = levelCount > 1;
    if (useLod) {
      setEye(group, camera);
      mainEye.copy(eye);
      hasMainEye = true;
    }
    if ((camera as CameraLike).isArrayCamera) {
      for (let i = 0; i < n; i++) place(i);
    } else {
      bvh.frustumCulling(_matrix.elements, visitPlace);
    }
    for (let L = 0; L < levelCount; L++) {
      writeRows(L, 0);
      mainCount[L] = listLength[L]!;
    }
  };

  // ---- the frame's shadow casters ----
  // The caster pool: every instance any shadow-casting light of the frame reaches, deduplicated, built once per frame
  // at the first shadow pass. It is not a draw list -- no pass draws the pool itself. Each pass appends only the
  // entries its own light reaches, which `casterLightBits` records as one bit per shadow camera (see `appendCasters`).
  // These names were `union*` while every pass did append the whole set; they are the caster pool and its per-light
  // bits now.
  /** Every instance a shadow-casting light of the frame reaches, each once, in query order. */
  const casterIds = new Int32Array(n);
  let casterCount = 0;
  const casterMarks = new Uint32Array(n);
  let casterMark = 0;
  /** Per instance in the list: a bit per shadow camera of the frame that reaches it (bit i = `shadowCameras[i]`). */
  const casterLightBits = new Uint32Array(n);
  /** The bit the running query sets; 0 for a camera past the 32nd, whose pass appends the whole list instead. */
  let queryBit = 0;
  /** The tracker frame the caster pool was checked for. */
  let casterFrame = -1;
  /** The shadow cameras the caster pool covers this frame (a point light's one camera covers its six faces). */
  const shadowCameras: Camera[] = [];
  /** The nested key: the lights the caster pool was built from, and 16 numbers per light after the group's matrix. */
  const poolLights: Light[] = [];
  let casterKey = new Float64Array(16);
  let nextKey = new Float64Array(16);
  const nextLights: Light[] = [];
  /** Visibility, a matrix or an extra camera changed the caster pool since it was built. */
  let castersDirty = true;

  /** The bit of the `i`th shadow camera of the frame; 0 past the 32nd (see `casterLightBits`). */
  const bitFor = (i: number): number => (i < 32 ? (1 << i) >>> 0 : 0);

  const addCaster = (id: number): void => {
    if (!visibleMask[id]) return;
    if (casterMarks[id] === casterMark) {
      casterLightBits[id] = casterLightBits[id]! | queryBit;
      return;
    }
    casterMarks[id] = casterMark;
    casterLightBits[id] = queryBit;
    casterIds[casterCount++] = id;
  };
  const visitIntersecting = (id: number): boolean => {
    addCaster(id);
    return false;
  };
  /** `bvh.traverse` visitor: skips the subtrees whose box misses `_frustum`. */
  const visitFrustum = (node: BVHNode<object, number>): boolean => {
    const b = node.box;
    _nodeBox.min.set(b[0]!, b[2]!, b[4]!);
    _nodeBox.max.set(b[1]!, b[3]!, b[5]!);
    if (!_frustum.intersectsBox(_nodeBox)) return true;
    if (node.object !== undefined) addCaster(node.object);
    return false;
  };
  /** What `camera` sees, with three's frustum in the camera's own coordinate system and depth convention. */
  const addFrustum = (group: Object3D, camera: Camera): void => {
    _matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(group.matrixWorld);
    _frustum.setFromProjectionMatrix(_matrix, camera.coordinateSystem, (camera as CameraLike).reversedDepth);
    bvh.traverse(visitFrustum);
  };
  /** What a point light's faces can see: the cube of half-size `reach` around (x, y, z), in the group's frame. */
  const addCube = (group: Object3D, x: number, y: number, z: number, reach: number): void => {
    _box.min.set(x - reach, y - reach, z - reach);
    _box.max.set(x + reach, y + reach, z + reach);
    _box.applyMatrix4(_inverse.copy(group.matrixWorld).invert());
    _cube[0] = _box.min.x;
    _cube[1] = _box.max.x;
    _cube[2] = _box.min.y;
    _cube[3] = _box.max.y;
    _cube[4] = _box.min.z;
    _cube[5] = _box.max.z;
    bvh.intersectsBox(_cube, visitIntersecting);
  };

  /**
   * Brings the frame's caster list up to date at its first shadow pass, and covers `camera` if no listed light does.
   * Returns the index of `camera` among the frame's shadow cameras, whose bit its casters carry in `casterLightBits`.
   */
  const ensureCasterPool = (renderer: RendererLike, scene: Scene, camera: Camera, group: Object3D): number => {
    if (casterFrame !== passes!.frame) {
      casterFrame = passes!.frame;
      // The lights of this render (Lighting.getNode(scene).getLights(): what the shadow render projected), filtered by
      // ShadowNode.updateBefore's own gate.
      const lights = renderer?.lighting?.getNode?.(scene)?.getLights?.() ?? [];
      if (nextKey.length < 16 * (lights.length + 1)) nextKey = new Float64Array(16 * (lights.length + 1));
      for (let e = 0; e < 16; e++) nextKey[e] = group.matrixWorld.elements[e]!;
      let used = 0;
      for (const candidate of lights) {
        const light = candidate as ShadowLight;
        const shadow = light.shadow;
        if (!light.castShadow || !shadow || !(shadow.autoUpdate || shadow.needsUpdate)) continue;
        const offset = 16 * (used + 1);
        if (light.isPointLight) {
          _position.setFromMatrixPosition(light.matrixWorld);
          nextKey[offset] = _position.x;
          nextKey[offset + 1] = _position.y;
          nextKey[offset + 2] = _position.z;
          nextKey[offset + 3] = light.distance || (shadow.camera.far ?? 0); // PointShadowNode: far = light.distance || camera.far
          for (let e = 4; e < 16; e++) nextKey[offset + e] = 0;
        } else {
          shadow.updateMatrices(light); // what ShadowNode.renderShadow does before this light's map
          _matrix.multiplyMatrices(shadow.camera.projectionMatrix, shadow.camera.matrixWorldInverse);
          for (let e = 0; e < 16; e++) nextKey[offset + e] = _matrix.elements[e]!;
        }
        nextLights[used++] = light;
      }
      let same = !castersDirty && used === poolLights.length && casterKey.length >= 16 * (used + 1);
      for (let i = 0; same && i < used; i++) same = nextLights[i] === poolLights[i];
      for (let e = 0; same && e < 16 * (used + 1); e++) same = nextKey[e] === casterKey[e];
      if (!same) {
        if (casterMark >= 0xfffffffe) {
          casterMarks.fill(0);
          casterMark = 0;
        }
        casterMark++;
        casterCount = 0;
        for (let i = 0; i < used; i++) {
          const light = nextLights[i] as ShadowLight;
          const offset = 16 * (i + 1);
          queryBit = bitFor(i);
          if (light.isPointLight) addCube(group, nextKey[offset]!, nextKey[offset + 1]!, nextKey[offset + 2]!, nextKey[offset + 3]!);
          else addFrustum(group, light.shadow!.camera);
          poolLights[i] = light;
        }
        poolLights.length = used;
        const key = casterKey;
        casterKey = nextKey;
        nextKey = key;
        castersDirty = false;
      }
      shadowCameras.length = 0;
      for (let i = 0; i < used; i++) shadowCameras.push((poolLights[i] as ShadowLight).shadow!.camera);
    }
    // Identity, not equality: two lights sharing one `LightShadow.camera` object would give the second the first's
    // bit and lose its own casters. three's own API never shares a shadow camera (`Light.copy` clones the shadow), so
    // this is theoretical -- but it was harmless before each pass appended only its own light's entries, and is not now.
    let index = shadowCameras.indexOf(camera);
    if (index < 0) {
      // A shadow camera no listed light owns (or a renderer without `lighting`): cover it too, and rebuild next frame.
      index = shadowCameras.length;
      queryBit = bitFor(index);
      addFrustum(group, camera);
      shadowCameras.push(camera);
      castersDirty = true;
    }
    return index;
  };

  const marks = new Uint32Array(n);
  let mark = 0;

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
    const bit = bitFor(index);
    for (let j = 0; j < casterCount; j++) {
      const id = casterIds[j]!;
      if (bit !== 0 && (casterLightBits[id]! & bit) === 0) continue; // a caster this shadow camera does not reach
      if (marks[id] !== mark) place(id);
    }
    for (let L = 0; L < levelCount; L++) writeRows(L, layerBase[at + L]!);
  };

  // ---- open passes ----
  /** Per layer and level: the length the layer kept (-1 on level 0 for a compaction) and the length it left. */
  const layerBase: number[] = [];
  const layerCount: number[] = [];
  const layers = new PassLayers(passes, (layer) => {
    const at = layer * levelCount;
    if (layerBase[at]! < 0) return;
    for (let L = 0; L < levelCount; L++) setCount(L, layerBase[at + L]!);
  });
  const pushCompaction = (depth: number, pass: number): void => {
    const at = layers.push(depth, pass) * levelCount;
    for (let L = 0; L < levelCount; L++) {
      layerBase[at + L] = -1;
      layerCount[at + L] = levels[L]!.count;
    }
  };

  const hook = function (this: CulledInstancedMesh, renderer: unknown, scene: Scene | null, camera: Camera): void {
    const depth = passes === undefined ? 0 : passes.depth;
    // Only an outermost render with a tracker marks rows; anywhere else a later sync could replace ranges not yet
    // uploaded, so writes mark the whole buffers (see the doc comment). Matrices within the uniform-buffer limit are
    // written whole per render object and carry no ranges.
    const outermost = passes !== undefined && depth === 1;
    const limit = (renderer as RendererLike)?.backend?.capabilities?.getUniformBufferLimit?.();
    matrixMark = typeof limit === 'number' && n * 64 > limit ? (outermost ? MARK_ROWS : MARK_WHOLE) : MARK_ALL;
    colorMark = outermost ? MARK_ROWS : MARK_WHOLE;
    if (rowsStale) {
      for (const rows of rowIds) rows.fill(-1);
      rowsStale = false;
    }
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
    if (scene !== null && (scene.overrideMaterial as { isShadowPassMaterial?: boolean } | null)?.isShadowPassMaterial === true) {
      // `ensureCasterPool` brings the pool up to date and must run before `appendCasters` reads it; hoisted so the
      // order is visible instead of resting on arguments being evaluated first.
      const index = ensureCasterPool(renderer as RendererLike, scene, camera, this);
      appendCasters(at, this, camera, index);
    } else {
      for (let L = 0; L < levelCount; L++) setCount(L, layerBase[at + L]!);
    }
    for (let L = 0; L < levelCount; L++) layerCount[at + L] = levels[L]!.count;
    layers.restoreAtEnd(depth);
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
      rowsStale = true;
      mainDirty = true;
      castersDirty = true;
    },
    refreshBounds() {
      bounds.makeEmpty();
      for (let i = 0; i < n; i++) {
        boxOf(i, _instanceBox);
        bounds.union(_box);
      }
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
      castersDirty = true;
    },
    getVisibleAt(id) {
      return visibleMask[id] === 1;
    },
    detach() {
      if (detached) return;
      detached = true;
      layers.clear();
      for (const mesh of levels) {
        if (Object.prototype.hasOwnProperty.call(mesh, 'onBeforeRender')) delete (mesh as { onBeforeRender?: unknown }).onBeforeRender;
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
      bvh.clear();
      nodes.clear();
    },
  };
  for (const mesh of levels) mesh.forgeCulling = handle;
  return levels[0]!;
}
