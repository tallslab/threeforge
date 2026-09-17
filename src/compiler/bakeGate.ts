import {
  type BufferGeometry,
  Color,
  DoubleSide,
  LessEqualDepth,
  Material,
  Matrix4,
  Mesh,
  NoBlending,
  NormalBlending,
} from 'three';
import { NodeMaterial } from 'three/webgpu';
import { isBuiltInMaterial } from '../registry/builtInMaterials.js';
import { type BakeEntry, type BakeOptions, type BakeReport, bakeGeometries } from './bake.js';
import type { Group } from './batchStatics.js';
import { hasNoNodes, hasOwnFunctions, MATERIAL_DEFINES } from './materialCode.js';
import type { SceneSpace } from './space.js';

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

const _white = new Color(0xffffff);

/**
 * Whether the bake can prove a material draws its merged, scene-space geometry as it drew each module: an allowlist of
 * what reads the geometry. Three's own code alone: one of three's material classes (`isBuiltInMaterial`; a subclass can
 * override any `setup*`), no function on the instance (`hasOwnFunctions`) and no node in any slot (`hasNoNodes`; a
 * `Fn` closure can read `positionLocal` or `color` where nothing can inspect it). And reads the move into scene space
 * keeps: three r186's node-free mesh materials read position and normals through the model-view and normal matrices,
 * except `displacementMap`, which `setupPosition` applies along the local normal in local units (NodeMaterial.js:788),
 * so a scaled module's displacement changes size once baked. `alphaHash` (`positionLocal`, NodeMaterial.js:893) and an
 * object-space normal map (NormalMapNode.js:120-122) are not in the list: batching changes them the same way, so
 * leaving the bake would not restore a pixel (`test/e2e/local-space.spec.ts` measures it; the ledger's
 * `batch-local-space` hint names such draws). Only then does `vertexColors: false` prove the `color` attribute unread
 * (`unbakeableAttribute`'s `builtInReads`).
 */
export function bakeProvesReads(material: Material): boolean {
  const displacementMap = (material as Material & { displacementMap?: unknown }).displacementMap ?? null;
  return isBuiltInMaterial(material) && !hasOwnFunctions(material) && hasNoNodes(material) && displacementMap === null;
}

/**
 * `material.clone()` plus what `clone()` drops and still changes how the material draws, so a tinted group's clone
 * renders like its source. `Material.copy` (`Material.js:1119-1199`) copies a fixed field list and the subclass `copy`
 * methods reset `defines` (`MeshStandardMaterial.js:412`, `MeshPhysicalMaterial.js:552`); `NodeMaterial.copy`
 * (`NodeMaterial.js:1321-1376`) copies the prototype setters and the properties a fresh instance has, losing `alphaTest`
 * (an accessor backed by `_alphaTest`); neither copies an own function or a user-added property a hook reads through
 * `this`; and both deep-copy `userData` (`Material.js:1195`, `NodeMaterial.js:1372`), which throws on a circular value
 * and turns a uniform kept there into a plain object. So `userData` is swapped out around `clone()` and shared by
 * reference (no threeforge code writes it), and the copy gets every own function, a copy of `defines`, every primitive
 * accessor value it lost, and by reference every own enumerable property it leaves undefined. `_listeners` is skipped:
 * the renderers register `dispose` listeners per material (`WebGLRenderer.js:2216`, `RenderObject.js:359`), so a shared
 * list would run the source's listeners when the clone is disposed.
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
  if (Object.hasOwn(source, 'defines')) {
    const defines = from.defines;
    to.defines =
      defines !== null && typeof defines === 'object' ? { ...(defines as Record<string, unknown>) } : defines;
  }
  for (
    let proto = Object.getPrototypeOf(source) as object | null;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (!descriptor.get || !descriptor.set || key === 'type') continue;
      const value = from[key];
      if ((typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') && to[key] !== value)
        to[key] = value;
    }
  }
  for (const key of Object.keys(source)) {
    if (key === '_listeners' || to[key] !== undefined || from[key] === undefined) continue;
    to[key] = from[key];
  }
  return copy;
}

/**
 * Whether the bake may treat a material as opaque: an allowlist of three's default material hooks, so an unknown hook
 * keeps faces. Three's own code (`isBuiltInMaterial`, `hasOwnFunctions`, `hasNoNodes`, not a `ShaderMaterial`,
 * `Material`'s own `onBeforeCompile` and `customProgramCacheKey`, only three's material `defines`); no blending (not
 * transparent, normal or no blending, no transmission); nothing discarded (no `alphaTest`, `alphaHash`,
 * `alphaToCoverage`, material `clippingPlanes` or `stencilWrite`); triangles at their own depth (no `displacementMap`,
 * `polygonOffset` or `wireframe`; depth write and test on with `LessEqualDepth`). Side and shadow casting are judged by
 * `BakeEntry.side` and `BakeEntry.castShadow`; renderer-level clipping planes are outside what a material shows.
 */
function isOpaque(material: Material): boolean {
  const m = material as Material & {
    transmission?: number;
    displacementMap?: unknown;
    wireframe?: boolean;
    isShaderMaterial?: boolean;
    isNodeMaterial?: boolean;
    defines?: Record<string, unknown> | null;
  };
  if (!isBuiltInMaterial(m) || hasOwnFunctions(m)) return false;
  if (m.transparent || !(m.blending === NormalBlending || m.blending === NoBlending) || (m.transmission ?? 0) > 0)
    return false;
  if (m.alphaTest > 0 || m.alphaHash || m.alphaToCoverage || m.isShaderMaterial === true || !hasNoNodes(m))
    return false;
  if ((m.clippingPlanes?.length ?? 0) > 0 || m.stencilWrite) return false;
  if (m.onBeforeCompile !== Material.prototype.onBeforeCompile) return false;
  const ownCacheKey =
    m.isNodeMaterial === true ? NodeMaterial.prototype.customProgramCacheKey : Material.prototype.customProgramCacheKey;
  if (m.customProgramCacheKey !== ownCacheKey) return false;
  if (m.defines && Object.keys(m.defines).some((key) => !MATERIAL_DEFINES.has(key))) return false;
  if ((m.displacementMap ?? null) !== null || m.polygonOffset || m.wireframe === true) return false;
  return m.depthWrite && m.depthTest && m.depthFunc === LessEqualDepth;
}

interface BakeEntriesOptions {
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
export function bakeEntriesOf(meshes: Mesh[], material: Material, options: BakeEntriesOptions = {}): BakeEntry[] {
  const { space, vertexColors = material.vertexColors, opaqueAtBake = true, alsoCasts = false } = options;
  const local = space !== undefined && !space.update();
  const opaque = opaqueAtBake && isOpaque(material);
  return meshes.map((m) => ({
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

export function bakeGroup(
  group: Group,
  options: BakeOptions,
  shareCanonical: boolean,
  name: string,
  space: SceneSpace,
): BakedGroup {
  const canonical = group.canonical;
  const vertexColors = canonical.vertexColors;
  const opaque = isOpaque(canonical);
  const entries = bakeEntriesOf(group.meshes, canonical, {
    space,
    vertexColors,
    opaqueAtBake: opaque,
    alsoCasts: group.castShadow,
  });
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
  const baked: BakedGroup = {
    mesh,
    entries: group.meshes,
    hidden: new Set(),
    options,
    ownsMaterial,
    report: result.report,
    triangleOrigins: result.triangleOrigins,
    removed: result.removed,
    space,
    vertexColors,
    opaque,
  };
  mesh.userData.forge = { kind: 'bake', report: result.report, triangleOrigins: result.triangleOrigins };
  return baked;
}

/** Rebuild a baked group's geometry after modules were hidden or shown. */
export function rebake(group: BakedGroup): void {
  const material = group.mesh.material as Material;
  const entriesVisible = group.entries.filter((m) => !group.hidden.has(m));
  const entries = bakeEntriesOf(entriesVisible, material, {
    space: group.space,
    vertexColors: group.vertexColors,
    opaqueAtBake: group.opaque,
    alsoCasts: group.mesh.castShadow,
  });
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
