import {
  BatchedMesh,
  Color,
  DoubleSide,
  LessEqualDepth,
  Material,
  Matrix4,
  Mesh,
  NoBlending,
  NormalBlending,
  WebGLCoordinateSystem,
  type BufferGeometry,
  type CoordinateSystem,
  type InstancedMesh,
  type Scene,
} from 'three';
import { NodeMaterial } from 'three/webgpu';
import { bakeGeometries, unbakeableAttribute, type BakeEntry, type BakeOptions, type BakeReport } from './bake.js';
import { createCulledInstancedMesh } from './instancing.js';
import type { NestedPassPolicy } from './culling.js';
import type { PassTracker } from './passTracker.js';
import { lodsOf } from '../lod/generateLods.js';
import type { MaterialRegistry } from '../registry/MaterialRegistry.js';
import { isBuiltInMaterial } from '../registry/builtInMaterials.js';
import { attributeSignature, ensureIndexed } from './geometryCompat.js';
import { SceneSpace } from './space.js';

/** Where an original mesh went: a BatchedMesh instance id, an InstancedMesh master index, or a baked mesh's entry index. */
export interface Slot {
  batch: BatchedMesh | InstancedMesh | Mesh;
  instanceId: number;
}

/** A finished group baked into one mesh in the scene's space; rebaked when a module is hidden or shown. */
export interface BakedGroup {
  mesh: Mesh;
  /** The modules, in entry order (`triangleOrigins` indexes this). */
  entries: Mesh[];
  hidden: Set<Mesh>;
  options: BakeOptions;
  /** True when the material is a clone made for vertex colours (disposed on decompile). */
  ownsMaterial: boolean;
  report: BakeReport;
  triangleOrigins: Uint32Array;
  /** The removed triangles, for inspection. */
  removed: BufferGeometry;
  /** The space the modules are baked in: the scene's, which the baked mesh is a child of. */
  space: SceneSpace;
  /**
   * The original material's `vertexColors` at bake time. The baked mesh's material may be a clone with vertex colours
   * forced on (for the tints), so a rebake passes this to `bakeEntriesOf` instead of reading that clone.
   */
  vertexColors: boolean;
  /**
   * Whether the original material passed the bake's opacity allowlist at bake time. A rebake requires this as well as
   * the current material passing, so a material changed after compile, or a clone that does not match its source,
   * never lets a rebake remove more than the bake did.
   */
  opaque: boolean;
}

export interface BatchOptions {
  /** A geometry repeated at least this many times inside one opaque group becomes an InstancedMesh. */
  instanceThreshold?: number;
  coordinateSystem?: CoordinateSystem;
  /** World-space cell size; when set, each material group is split into one batch per cell (tight bounds, streamable). */
  chunkSize?: number;
  /** Distance thresholds for LOD levels; geometries carry their levels via `prepareLods` / `generateLods`. */
  lodDistances?: number[];
  nestedPasses?: NestedPassPolicy;
  /** The scene's pass tracker, handed to compacted instanced meshes (`InstancingOptions.passes`). */
  passes?: PassTracker;
  /** Bake finished groups into one mesh each (seams and duplicates removed, vertices welded) instead of batching them. */
  bake?: BakeOptions;
  /** Meshes that must stay in a BatchedMesh (matrix-synced dynamics): a group containing one is batched, not baked. */
  noBake?: Set<Mesh>;
  /** `batch` (default): transparent groups batch/bake like any other. `keep` routes them aside, unbatched. */
  transparent?: 'batch' | 'keep';
  /**
   * The space of `scene`, which every batch, instanced mesh and baked mesh is added to: instance matrices and baked
   * vertices are written in it (`inverse(scene.matrixWorld) * original.matrixWorld`). Pass the caller's to share its
   * cache; a new one by default.
   */
  space?: SceneSpace;
}

export interface GroupReport {
  name: string;
  kind: 'batched' | 'instanced' | 'baked';
  /** Present for baked groups. */
  bake?: BakeReport;
  /** Cell coordinates when `chunkSize` is set, else null. */
  chunk: [number, number, number] | null;
  /** LOD levels beyond the base geometry that this group can switch to. */
  lods: number;
  programHash: string;
  variantHash: string;
  instances: number;
  geometries: number;
  transparent: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
}

export interface BatchResult {
  batches: BatchedMesh[];
  instanced: InstancedMesh[];
  baked: BakedGroup[];
  groups: GroupReport[];
  slots: Map<Mesh, Slot>;
  originals: Map<BatchedMesh | InstancedMesh, Mesh[]>;
  /** Statics that had nothing to share a batch with. */
  singletons: Mesh[];
  /** Transparent statics routed aside unbatched by `transparent: 'keep'`. */
  transparentKept: Mesh[];
  /** Per batch: base geometryId -> geometryIds per LOD level (present only when lodDistances is set). */
  lodGeometryIds: Map<BatchedMesh, Map<number, number[]>>;
  /**
   * Statics of groups `bake` left to batching: the material may read the geometry in a way the bake cannot prove it keeps
   * (`bakeProvesReads`), or a geometry carries an attribute the bake drops and the material may read (`unbakeableAttribute`).
   */
  unbakeable: number;
}

interface Group {
  canonical: Material;
  meshes: Mesh[];
  castShadow: boolean;
  receiveShadow: boolean;
  chunk: [number, number, number] | null;
}

const _white = new Color(0xffffff);
const _local = new Matrix4();

/**
 * One BatchedMesh per (material variant, geometry attribute signature, shadow flags). Colour is per instance,
 * so materials that differ only by `color` share a batch. Originals are not modified here.
 */
export function batchStatics(statics: Mesh[], registry: MaterialRegistry, scene: Scene, options: BatchOptions = {}): BatchResult {
  const instanceThreshold = options.instanceThreshold ?? 64;
  const coordinateSystem = options.coordinateSystem ?? WebGLCoordinateSystem;
  const chunkSize = options.chunkSize;
  const lodDistances = options.lodDistances;
  const space = options.space ?? new SceneSpace(scene);
  const groups = new Map<string, Group>();
  for (const mesh of statics) {
    if (Array.isArray(mesh.material)) continue;
    const canonical = registry.register(mesh.material);
    const keys = registry.keys(canonical);
    let chunk: [number, number, number] | null = null;
    if (chunkSize !== undefined && chunkSize > 0) {
      const e = mesh.matrixWorld.elements;
      chunk = [Math.floor(e[12]! / chunkSize), Math.floor(e[13]! / chunkSize), Math.floor(e[14]! / chunkSize)];
    }
    const key = `${keys.variantKey}|${attributeSignature(mesh.geometry)}|${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}|${chunk ? chunk.join(',') : ''}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { canonical, meshes: [], castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow, chunk }));
    group.meshes.push(mesh);
  }

  const result: BatchResult = { batches: [], instanced: [], baked: [], groups: [], slots: new Map(), originals: new Map(), singletons: [], transparentKept: [], lodGeometryIds: new Map(), unbakeable: 0 };
  const perProgramBaked = new Map<string, number>();
  const perProgram = new Map<string, number>();
  const perProgramInstanced = new Map<string, number>();
  const isWhite = (m: Material) => {
    const c = (m as Material & { color?: Color }).color;
    return c === undefined || (c.r === 1 && c.g === 1 && c.b === 1);
  };

  for (const group of groups.values()) {
    const { programHash, variantHash } = registry.describe(group.canonical);
    const canonicalHasColor = (group.canonical as Material & { color?: Color }).color !== undefined;
    // When every instance is white the canonical material itself can drive the batch: no clone, so uniform
    // changes made at runtime (emissive, opacity, texture offsets) keep propagating. Otherwise a white clone
    // carries the per-instance colours.
    const shareCanonical = group.meshes.every((m) => isWhite(m.material as Material));
    const batchMaterial = (): { material: Material; perInstanceColor: boolean } => {
      if (shareCanonical) return { material: group.canonical, perInstanceColor: false };
      const material = cloneMaterial(group.canonical);
      if (canonicalHasColor) (material as Material & { color: Color }).color.copy(_white);
      return { material, perInstanceColor: canonicalHasColor };
    };

    // Opaque geometry repeated many times gets hardware instancing; whatever is left is batched.
    if (!group.canonical.transparent && group.meshes.length >= instanceThreshold) {
      const byGeometry = new Map<BufferGeometry, Mesh[]>();
      for (const mesh of group.meshes) {
        let list = byGeometry.get(mesh.geometry);
        if (!list) byGeometry.set(mesh.geometry, (list = []));
        list.push(mesh);
      }
      const remaining: Mesh[] = [];
      for (const [geometry, meshes] of byGeometry) {
        if (meshes.length < instanceThreshold) {
          remaining.push(...meshes);
          continue;
        }
        const { material, perInstanceColor } = batchMaterial();
        if (material !== group.canonical) material.name = `${group.canonical.name || group.canonical.type} (forge instanced)`;
        // The level meshes are children of the scene: scene-space masters (an untransformed scene passes the world matrices).
        const matrices = space.update() ? meshes.map((m) => m.matrixWorld) : meshes.map((m) => space.toLocal(m.matrixWorld, new Matrix4()));
        const colors = perInstanceColor ? meshes.map((m) => (m.material as Material & { color: Color }).color) : null;
        const lods = lodDistances ? lodsOf(geometry) : [];
        const instanced = createCulledInstancedMesh(geometry, material, matrices, colors, coordinateSystem, {
          ...(lodDistances ? { lods, distances: lodDistances } : {}),
          ...(options.nestedPasses ? { nestedPasses: options.nestedPasses } : {}),
          ...(options.passes ? { passes: options.passes } : {}),
        });
        const index = perProgramInstanced.get(programHash) ?? 0;
        perProgramInstanced.set(programHash, index + 1);
        instanced.levels.forEach((level, L) => {
          level.name = L === 0 ? `forge:instanced:${programHash}:${index}` : `forge:instanced:${programHash}:${index}:lod${L}`;
          level.userData.forgeChunk = group.chunk;
          level.castShadow = group.castShadow;
          level.receiveShadow = group.receiveShadow;
          scene.add(level);
          result.instanced.push(level);
          result.originals.set(level, meshes.slice());
        });
        meshes.forEach((mesh, i) => result.slots.set(mesh, { batch: instanced, instanceId: i }));
        result.groups.push({
          name: instanced.name,
          kind: 'instanced',
          chunk: group.chunk,
          programHash,
          variantHash,
          instances: meshes.length,
          geometries: 1,
          lods: instanced.levels.length - 1,
          transparent: false,
          castShadow: group.castShadow,
          receiveShadow: group.receiveShadow,
        });
      }
      group.meshes = remaining;
    }

    // Three sorts a BatchedMesh back-to-front by its own bounding-sphere centre, not per instance, so a batch of
    // transparent objects composites in creation order relative to other transparent submissions instead of true
    // per-object depth (docs/threeforge.md §7, the `transparent-batch-order` hint). `keep` opts out: these statics
    // stay individual meshes, routed aside before either baking or batching.
    if (options.transparent === 'keep' && group.canonical.transparent) {
      result.transparentKept.push(...group.meshes);
      continue;
    }

    if (group.meshes.length < 2) {
      result.singletons.push(...group.meshes);
      continue;
    }
    // A group is baked only when the bake can prove the merged mesh draws what the modules drew (an allowlist,
    // `bakeProvesReads`): its material reads the geometry through three's own code alone, in ways the move into scene
    // space keeps, and no geometry carries data the bake would drop (a vertex colour's alpha, a custom attribute).
    // Otherwise it is batched: BatchedMesh keeps each geometry, in its own space, with every attribute. Counted, since
    // `bake` asked for it.
    const provenReads = bakeProvesReads(group.canonical);
    const bakeable = provenReads && !group.meshes.some((m) => unbakeableAttribute(m.geometry, group.canonical.vertexColors, provenReads) !== null);
    if (options.bake && !bakeable && !group.meshes.some((m) => options.noBake?.has(m))) result.unbakeable += group.meshes.length;
    if (options.bake && bakeable && !group.meshes.some((m) => options.noBake?.has(m))) {
      const index = perProgramBaked.get(programHash) ?? 0;
      perProgramBaked.set(programHash, index + 1);
      const baked = bakeGroup(group, options.bake, shareCanonical, `forge:bake:${programHash}:${index}`, space);
      scene.add(baked.mesh);
      result.baked.push(baked);
      group.meshes.forEach((mesh, i) => result.slots.set(mesh, { batch: baked.mesh, instanceId: i }));
      result.originals.set(baked.mesh as never, group.meshes);
      result.groups.push({
        name: baked.mesh.name,
        kind: 'baked',
        bake: baked.report,
        chunk: group.chunk,
        lods: 0,
        programHash,
        variantHash,
        instances: group.meshes.length,
        geometries: new Set(group.meshes.map((m) => m.geometry)).size,
        transparent: (baked.mesh.material as Material).transparent,
        castShadow: group.castShadow,
        receiveShadow: group.receiveShadow,
      });
      continue;
    }
    const unique = new Map<BufferGeometry, BufferGeometry>();
    const lodGeometries = new Map<BufferGeometry, BufferGeometry[]>();
    let lodLevels = 0;
    for (const mesh of group.meshes) {
      if (unique.has(mesh.geometry)) continue;
      unique.set(mesh.geometry, ensureIndexed(mesh.geometry));
      if (lodDistances) {
        const lods = lodsOf(mesh.geometry).slice(0, lodDistances.length).map(ensureIndexed);
        lodGeometries.set(mesh.geometry, lods);
        lodLevels = Math.max(lodLevels, lods.length);
      }
    }
    let maxVertexCount = 0;
    let maxIndexCount = 0;
    for (const geometry of [...unique.values(), ...[...lodGeometries.values()].flat()]) {
      maxVertexCount += geometry.attributes.position?.count ?? 0;
      maxIndexCount += geometry.index?.count ?? 0;
    }

    const { material, perInstanceColor: hasColor } = batchMaterial();
    if (material !== group.canonical) material.name = `${group.canonical.name || group.canonical.type} (forge batch)`;

    const index = perProgram.get(programHash) ?? 0;
    perProgram.set(programHash, index + 1);

    const batch = new BatchedMesh(group.meshes.length, maxVertexCount, maxIndexCount, material);
    batch.name = `forge:batch:${programHash}:${index}`;
    batch.userData.forgeChunk = group.chunk;
    batch.sortObjects = material.transparent;
    batch.perObjectFrustumCulled = true;
    batch.castShadow = group.castShadow;
    batch.receiveShadow = group.receiveShadow;

    const geometryIds = new Map<BufferGeometry, number>();
    const levelIds = new Map<number, number[]>();
    const originals: Mesh[] = [];
    for (const mesh of group.meshes) {
      let geometryId = geometryIds.get(mesh.geometry);
      if (geometryId === undefined) {
        geometryId = batch.addGeometry(unique.get(mesh.geometry)!);
        geometryIds.set(mesh.geometry, geometryId);
        const lods = lodGeometries.get(mesh.geometry);
        if (lods && lods.length > 0) levelIds.set(geometryId, [geometryId, ...lods.map((g) => batch.addGeometry(g))]);
      }
      const instanceId = batch.addInstance(geometryId);
      batch.setMatrixAt(instanceId, space.toLocal(mesh.matrixWorld, _local));
      if (hasColor) batch.setColorAt(instanceId, (mesh.material as Material & { color: Color }).color);
      result.slots.set(mesh, { batch, instanceId });
      originals[instanceId] = mesh;
    }
    batch.computeBoundingBox();
    batch.computeBoundingSphere();
    scene.add(batch);

    result.batches.push(batch);
    result.originals.set(batch, originals);
    if (levelIds.size > 0) result.lodGeometryIds.set(batch, levelIds);
    result.groups.push({
      name: batch.name,
      kind: 'batched',
      chunk: group.chunk,
      lods: lodLevels,
      programHash,
      variantHash,
      instances: group.meshes.length,
      geometries: unique.size,
      transparent: material.transparent,
      castShadow: group.castShadow,
      receiveShadow: group.receiveShadow,
    });
  }
  return result;
}

export { isBuiltInMaterial };

/**
 * Whether the bake can prove that a material draws its merged, scene-space geometry as it drew each module: an allowlist
 * of what reads the geometry.
 * - Three's own code alone: exactly one of three's material classes (`isBuiltInMaterial`: a subclass can override
 *   `setupPosition`, `setupDiffuseColor` or any other `setup*`), no function assigned to the instance
 *   (`hasOwnFunctions`) and no node in any slot (`hasNoNodes`). A node graph can read `positionLocal`, `normalLocal`,
 *   `positionGeometry` or `color` inside a `Fn` closure nothing can inspect before it builds: a `colorNode =
 *   vertexColor()` reads `color` whatever `vertexColors` says, and a colour or position from local coordinates changes
 *   once the bake writes them in scene space (Ruling R162).
 * - Reads the move into scene space keeps. three r186's node-free mesh materials read position through the model-view
 *   matrix and normals through the normal matrix, which the baked geometry already carries, except a `displacementMap`:
 *   `setupPosition` displaces along the local normal in local units (NodeMaterial.js:788), so a scaled module's
 *   displacement changes size once baked. A batch displaces before its own transform, and keeps it.
 * Only then does `vertexColors: false` prove the `color` attribute unread (`unbakeableAttribute`'s `builtInReads`).
 */
function bakeProvesReads(material: Material): boolean {
  const displacementMap = (material as Material & { displacementMap?: unknown }).displacementMap ?? null;
  return isBuiltInMaterial(material) && !hasOwnFunctions(material) && hasNoNodes(material) && displacementMap === null;
}

/**
 * Whether code is assigned to the material instance: any own property holding a function (an instance
 * `onBeforeCompile`, `customProgramCacheKey`, `onBeforeRender`, `setup`, `setupOutput` …). A fresh three material has
 * none.
 */
export function hasOwnFunctions(material: Material): boolean {
  const record = material as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(material).some((key) => typeof record[key] === 'function');
}

/**
 * `material.clone()` plus what `clone()` (`new constructor().copy(source)`) does not carry and still changes how the
 * material draws, so a tinted group's clone renders like its source:
 * - `Material.copy` (`Material.js:1119-1199`) copies a fixed list of fields, and the subclass `copy` methods set
 *   `defines` back to the class default (`MeshStandardMaterial.js:412`, `MeshPhysicalMaterial.js:552`,
 *   `MeshMatcapMaterial.js:235`, `MeshToonMaterial`): an instance `onBeforeCompile`, `customProgramCacheKey`,
 *   `onBeforeRender` or any other own function, and custom `defines`, are lost;
 * - `NodeMaterial.copy` (`NodeMaterial.js:1321-1376`) copies the setters of the concrete class prototype and the
 *   properties a fresh instance already has: `alphaTest` (an accessor on `Material.prototype`, backed by `_alphaTest`)
 *   and every instance function (`setup`, `setupOutput` …) are lost;
 * - neither copies an own property a user added (data a hook reads through `this`, such as `this.extra.uTint`), so a
 *   hook on the copy reads `undefined` and throws while three builds the program;
 * - both end with `this.userData = JSON.parse(JSON.stringify(source.userData))` (`Material.js:1195`,
 *   `NodeMaterial.js:1372`): it throws on a circular or BigInt value, and a uniform kept there becomes a copy that
 *   updates made through the source never reach (a node uniform becomes a plain object).
 *
 * So `source.userData` is swapped for an empty object around `clone()` (put back in `finally`), and the copy shares the
 * source's `userData` object. No threeforge code writes a batched source's or its clone's `userData`: `materialKey.ts`
 * reads `forgeKey` and `collectResources` reads `forgeTextures`. Restored on the copy: every own function-valued property
 * (the same function, as the source's meshes share it), a copy of `defines`, every accessor on the prototype chain whose
 * primitive value the copy lost (`alphaTest`), and, by reference, every own enumerable property the fresh copy leaves
 * undefined. The one exception is EventDispatcher's `_listeners`, created lazily by the first `addEventListener`
 * (`EventDispatcher.js:33`): the renderers register `dispose` listeners on every material they draw (`WebGLRenderer.js:2216`,
 * `RenderObject.js:359`), so a shared `_listeners` would run the source's listeners when the clone is disposed, and
 * WebGLRenderer's `onMaterialDispose` (`:1151-1157`) would remove its listener from the source. The registry's material
 * keys and grouping do not change.
 */
export function cloneMaterial<T extends Material>(source: T): T {
  const userData = source.userData;
  source.userData = {};
  let copy: T;
  try {
    copy = source.clone() as T;
  } finally {
    source.userData = userData;
  }
  copy.userData = userData;
  const from = source as unknown as Record<string, unknown>;
  const to = copy as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(source)) {
    if (typeof from[key] === 'function') to[key] = from[key];
  }
  if (Object.prototype.hasOwnProperty.call(source, 'defines')) {
    const defines = from.defines;
    to.defines = defines !== null && typeof defines === 'object' ? { ...(defines as Record<string, unknown>) } : defines;
  }
  for (let proto = Object.getPrototypeOf(source) as object | null; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (!descriptor.get || !descriptor.set || key === 'type') continue;
      const value = from[key];
      if ((typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') && to[key] !== value) to[key] = value;
    }
  }
  for (const key of Object.keys(source)) {
    if (key === '_listeners' || to[key] !== undefined || from[key] === undefined) continue;
    to[key] = from[key];
  }
  return copy;
}

/** The `defines` three's own mesh materials set: `MeshStandardMaterial`, `MeshPhysicalMaterial`, `MeshToonMaterial`, `MeshMatcapMaterial`. */
const MATERIAL_DEFINES = new Set(['STANDARD', 'PHYSICAL', 'TOON', 'MATCAP']);

/**
 * No node slot is set. three r186's `NodeMaterial` declares its slots as `*Node` properties (`lightsNode`, `envNode`,
 * `aoNode`, `colorNode`, `normalNode`, `opacityNode`, `backdropNode`, `backdropAlphaNode`, `alphaTestNode`, `maskNode`,
 * `maskShadowNode`, `positionNode`, `geometryNode`, `depthNode`, `receivedShadowPositionNode`, `castShadowPositionNode`,
 * `receivedShadowNode`, `castShadowNode`, `outputNode`, `mrtNode`, `fragmentNode`, `vertexNode`, `contextNode`;
 * subclasses add `emissiveNode`, `metalnessNode`, `roughnessNode` and more) and reads every own property holding a node
 * as a child (`NodeMaterial._getNodeChildren`). Any of them can carry `Discard()` (`nodes/utils/Discard.js`), so any
 * non-null `*Node` property, or any other own property holding a node, fails.
 */
function hasNoNodes(material: Material): boolean {
  for (const key of Object.getOwnPropertyNames(material)) {
    if (key.startsWith('_')) continue;
    const value = (material as unknown as Record<string, unknown>)[key];
    if (value === null || value === undefined) continue;
    if (key.endsWith('Node') || (value as { isNode?: boolean }).isNode === true) return false;
  }
  return true;
}

/**
 * Whether the bake may treat a material as opaque: an allowlist of three's default material hooks, so a hook this code
 * does not know about keeps faces instead of deleting them. The material must:
 * - be three's own code: exactly one of three's material classes (`isBuiltInMaterial`: no subclass, whose overridden
 *   methods such as a node material's `setup*` can discard) with no function assigned to the instance
 *   (`hasOwnFunctions`: no instance `onBeforeRender`, `setup`, `setupOutput` …);
 * - not blend: not transparent, normal or no blending, no transmission;
 * - discard nothing: no `alphaTest`, `alphaHash` or `alphaToCoverage`, not a `ShaderMaterial`, no node in any slot
 *   (`hasNoNodes`), no material `clippingPlanes`, no `stencilWrite` (the stencil test);
 * - run three's own shader: `onBeforeCompile` is `Material`'s, `customProgramCacheKey` is `Material`'s (`NodeMaterial`'s
 *   for a node material), `defines` holds only three's material defines;
 * - draw its triangles where the geometry puts them, at their own depth: no `displacementMap`, `polygonOffset` or
 *   `wireframe`; depth write on; the depth test on with three's default `LessEqualDepth`.
 * The side (`BakeEntry.side`) and shadow casting (`BakeEntry.castShadow`) are judged separately, and renderer-level
 * clipping planes are outside what a material shows. Node-material statics authored with custom nodes keep all faces.
 */
function isOpaque(material: Material): boolean {
  const m = material as Material & { transmission?: number; displacementMap?: unknown; wireframe?: boolean; isShaderMaterial?: boolean; isNodeMaterial?: boolean; defines?: Record<string, unknown> | null };
  if (!isBuiltInMaterial(m) || hasOwnFunctions(m)) return false;
  if (m.transparent || !(m.blending === NormalBlending || m.blending === NoBlending) || (m.transmission ?? 0) > 0) return false;
  if (m.alphaTest > 0 || m.alphaHash || m.alphaToCoverage || m.isShaderMaterial === true || !hasNoNodes(m)) return false;
  if ((m.clippingPlanes?.length ?? 0) > 0 || m.stencilWrite) return false;
  if (m.onBeforeCompile !== Material.prototype.onBeforeCompile) return false;
  const ownCacheKey = m.isNodeMaterial === true ? NodeMaterial.prototype.customProgramCacheKey : Material.prototype.customProgramCacheKey;
  if (m.customProgramCacheKey !== ownCacheKey) return false;
  if (m.defines && Object.keys(m.defines).some((key) => !MATERIAL_DEFINES.has(key))) return false;
  if ((m.displacementMap ?? null) !== null || m.polygonOffset || m.wireframe === true) return false;
  return m.depthWrite && m.depthTest && m.depthFunc === LessEqualDepth;
}

export interface BakeEntriesOptions {
  /** The space the matrices are written in (`World`: the scene's); each module's world matrix without one. */
  space?: SceneSpace;
  /** Defaults to `material.vertexColors`; a rebake passes the value recorded at bake time. */
  vertexColors?: boolean;
  /** Whether the material passed the bake's opacity allowlist at bake time (default true). */
  opaqueAtBake?: boolean;
  /** Count every module as casting shadows, whatever its own flag (a rebake passes the baked mesh's `castShadow`). */
  alsoCasts?: boolean;
}

/**
 * Bake entries for a group's modules: matrices in `space` (world matrices without one, or while its root has no
 * transform), instance tints, per-module opt-out and shadow casting, and from the material its sidedness, opacity
 * (`isOpaque`) and `vertexColors`. A rebake passes the `vertexColors` and opacity recorded at bake time, because the
 * baked mesh's material may be a clone with vertex colours forced on: an entry is opaque only when `opaqueAtBake` holds
 * and the given material passes too. A module counts as casting shadows when its original casts or `alsoCasts` holds:
 * a rebake passes the baked mesh's `castShadow`, which is what the shadow pass draws by (the hidden originals draw
 * nothing), so originals that stop casting after compile never let a rebake remove seams from a mesh that still casts.
 */
export function bakeEntriesOf(meshes: Mesh[], hidden: Set<Mesh>, material: Material, options: BakeEntriesOptions = {}): BakeEntry[] {
  const { space, vertexColors = material.vertexColors, opaqueAtBake = true, alsoCasts = false } = options;
  const local = space !== undefined && !space.update();
  const opaque = opaqueAtBake && isOpaque(material);
  return meshes
    .filter((m) => !hidden.has(m))
    .map((m) => ({
      geometry: m.geometry,
      matrix: local ? space!.toLocal(m.matrixWorld, new Matrix4()) : m.matrixWorld,
      color: (m.material as Material & { color?: Color }).color ?? null,
      bake: m.userData.forgeBake !== false,
      doubleSided: material.side === DoubleSide,
      side: material.side,
      castShadow: m.castShadow || alsoCasts,
      opaque,
      vertexColors,
    }));
}

function bakeGroup(group: Group, options: BakeOptions, shareCanonical: boolean, name: string, space: SceneSpace): BakedGroup {
  const canonical = group.canonical;
  const vertexColors = canonical.vertexColors;
  const opaque = isOpaque(canonical);
  const entries = bakeEntriesOf(group.meshes, new Set(), canonical, { space, vertexColors, opaqueAtBake: opaque, alsoCasts: group.castShadow });
  const result = bakeGeometries(entries, options);
  // Instance tints become vertex colours: the material then needs vertexColors and a white base colour.
  let material: Material = canonical;
  let ownsMaterial = false;
  if (result.hasColor && !shareCanonical) {
    material = cloneMaterial(canonical);
    (material as Material & { vertexColors: boolean }).vertexColors = true;
    const color = (material as Material & { color?: Color }).color;
    if (color) color.copy(_white);
    material.name = `${canonical.name || canonical.type} (forge bake)`;
    ownsMaterial = true;
  }
  const mesh = new Mesh(result.geometry, material);
  mesh.name = name;
  mesh.userData.forgeChunk = group.chunk;
  mesh.castShadow = group.castShadow;
  mesh.receiveShadow = group.receiveShadow;
  mesh.matrixAutoUpdate = false;
  const baked: BakedGroup = { mesh, entries: group.meshes, hidden: new Set(), options, ownsMaterial, report: result.report, triangleOrigins: result.triangleOrigins, removed: result.removed, space, vertexColors, opaque };
  mesh.userData.forge = { kind: 'bake', report: result.report, triangleOrigins: result.triangleOrigins };
  return baked;
}

/** Rebuild a baked group's geometry after modules were hidden or shown. */
export function rebake(group: BakedGroup): void {
  const material = group.mesh.material as Material;
  const entriesVisible = group.entries.filter((m) => !group.hidden.has(m));
  const entries = bakeEntriesOf(entriesVisible, new Set(), material, { space: group.space, vertexColors: group.vertexColors, opaqueAtBake: group.opaque, alsoCasts: group.mesh.castShadow });
  const result = bakeGeometries(entries, group.options);
  group.mesh.geometry.dispose();
  group.removed.dispose();
  group.mesh.geometry = result.geometry;
  group.removed = result.removed;
  group.report = result.report;
  // triangleOrigins index the visible subset; map back to entry positions in the full list.
  const map = entriesVisible.map((m) => group.entries.indexOf(m));
  group.triangleOrigins = Uint32Array.from(result.triangleOrigins, (i) => map[i]!);
  group.mesh.userData.forge = { kind: 'bake', report: result.report, triangleOrigins: group.triangleOrigins };
}
