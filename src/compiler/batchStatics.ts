import { BatchedMesh, Color, DoubleSide, Mesh, WebGLCoordinateSystem, type BufferGeometry, type CoordinateSystem, type InstancedMesh, type Material, type Scene } from 'three';
import { bakeGeometries, type BakeEntry, type BakeOptions, type BakeReport } from './bake.js';
import { createCulledInstancedMesh } from './instancing.js';
import type { NestedPassPolicy } from './culling.js';
import type { PassTracker } from './passTracker.js';
import { lodsOf } from '../lod/generateLods.js';
import type { MaterialRegistry } from '../registry/MaterialRegistry.js';
import { attributeSignature, ensureIndexed } from './geometryCompat.js';

/** Where an original mesh went: a BatchedMesh instance id, an InstancedMesh master index, or a baked mesh's entry index. */
export interface Slot {
  batch: BatchedMesh | InstancedMesh | Mesh;
  instanceId: number;
}

/** A finished group baked into one world-space mesh; rebaked when a module is hidden or shown. */
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
}

interface Group {
  canonical: Material;
  meshes: Mesh[];
  castShadow: boolean;
  receiveShadow: boolean;
  chunk: [number, number, number] | null;
}

const _white = new Color(0xffffff);

/**
 * One BatchedMesh per (material variant, geometry attribute signature, shadow flags). Colour is per instance,
 * so materials that differ only by `color` share a batch. Originals are not modified here.
 */
export function batchStatics(statics: Mesh[], registry: MaterialRegistry, scene: Scene, options: BatchOptions = {}): BatchResult {
  const instanceThreshold = options.instanceThreshold ?? 64;
  const coordinateSystem = options.coordinateSystem ?? WebGLCoordinateSystem;
  const chunkSize = options.chunkSize;
  const lodDistances = options.lodDistances;
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

  const result: BatchResult = { batches: [], instanced: [], baked: [], groups: [], slots: new Map(), originals: new Map(), singletons: [], transparentKept: [], lodGeometryIds: new Map() };
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
      const material = group.canonical.clone();
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
        const matrices = meshes.map((m) => m.matrixWorld);
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
    if (options.bake && !group.meshes.some((m) => options.noBake?.has(m))) {
      const index = perProgramBaked.get(programHash) ?? 0;
      perProgramBaked.set(programHash, index + 1);
      const baked = bakeGroup(group, options.bake, shareCanonical, `forge:bake:${programHash}:${index}`);
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
      batch.setMatrixAt(instanceId, mesh.matrixWorld);
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

/** Bake entries for a group's modules: world matrices, instance tints, per-module opt-out, material sidedness. */
export function bakeEntriesOf(meshes: Mesh[], hidden: Set<Mesh>, material: Material): BakeEntry[] {
  return meshes
    .filter((m) => !hidden.has(m))
    .map((m) => ({
      geometry: m.geometry,
      matrix: m.matrixWorld,
      color: (m.material as Material & { color?: Color }).color ?? null,
      bake: m.userData.forgeBake !== false,
      doubleSided: material.side === DoubleSide,
    }));
}

function bakeGroup(group: Group, options: BakeOptions, shareCanonical: boolean, name: string): BakedGroup {
  const canonical = group.canonical;
  const entries = bakeEntriesOf(group.meshes, new Set(), canonical);
  const result = bakeGeometries(entries, options);
  // Instance tints become vertex colours: the material then needs vertexColors and a white base colour.
  let material: Material = canonical;
  let ownsMaterial = false;
  if (result.hasColor && !shareCanonical) {
    material = canonical.clone();
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
  const baked: BakedGroup = { mesh, entries: group.meshes, hidden: new Set(), options, ownsMaterial, report: result.report, triangleOrigins: result.triangleOrigins, removed: result.removed };
  mesh.userData.forge = { kind: 'bake', report: result.report, triangleOrigins: result.triangleOrigins };
  return baked;
}

/** Rebuild a baked group's geometry after modules were hidden or shown. */
export function rebake(group: BakedGroup): void {
  const material = group.mesh.material as Material;
  const entriesVisible = group.entries.filter((m) => !group.hidden.has(m));
  const entries = bakeEntriesOf(entriesVisible, new Set(), material);
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
