import {
  BatchedMesh,
  type BufferGeometry,
  Color,
  type CoordinateSystem,
  type InstancedMesh,
  type Material,
  Matrix4,
  type Mesh,
  type Scene,
  WebGLCoordinateSystem,
} from 'three';
import { lodsOf } from '../lod/generateLods.js';
import type { MaterialRegistry } from '../registry/MaterialRegistry.js';
import { type BakeOptions, type BakeReport, unbakeableAttribute } from './bake.js';
import { type BakedGroup, bakeGroup, bakeProvesReads, cloneMaterial } from './bakeGate.js';
import { attributeSignature, ensureIndexed } from './geometryCompat.js';
import { createCulledInstancedMesh } from './instancing.js';
import type { PassTracker } from './passTracker.js';
import { SceneSpace } from './space.js';

export { type BakedGroup, bakeEntriesOf, rebake } from './bakeGate.js';

/** Where an original mesh went: a BatchedMesh instance id, an InstancedMesh master index, or a baked mesh's entry index. */
export interface Slot {
  batch: BatchedMesh | InstancedMesh | Mesh;
  instanceId: number;
}

export interface BatchOptions {
  /** A geometry repeated at least this many times inside one opaque group becomes an InstancedMesh. */
  instanceThreshold?: number;
  coordinateSystem?: CoordinateSystem;
  /** World-space cell size; when set, each material group is split into one batch per cell (tight bounds, streamable). */
  chunkSize?: number;
  /** Distance thresholds for LOD levels; geometries carry their levels via `prepareLods` / `generateLods`. */
  lodDistances?: number[];
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

export interface Group {
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
export function batchStatics(
  statics: Mesh[],
  registry: MaterialRegistry,
  scene: Scene,
  options: BatchOptions = {},
): BatchResult {
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
    if (!group)
      groups.set(
        key,
        (group = { canonical, meshes: [], castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow, chunk }),
      );
    group.meshes.push(mesh);
  }

  const result: BatchResult = {
    batches: [],
    instanced: [],
    baked: [],
    groups: [],
    slots: new Map(),
    originals: new Map(),
    singletons: [],
    transparentKept: [],
    lodGeometryIds: new Map(),
    unbakeable: 0,
  };
  const perProgramBaked = new Map<string, number>();
  const perProgram = new Map<string, number>();
  const perProgramInstanced = new Map<string, number>();
  const nextIndex = (counter: Map<string, number>, key: string): number => {
    const index = counter.get(key) ?? 0;
    counter.set(key, index + 1);
    return index;
  };
  const isWhite = (m: Material) => {
    const c = (m as Material & { color?: Color }).color;
    return c === undefined || (c.r === 1 && c.g === 1 && c.b === 1);
  };

  for (const group of groups.values()) {
    const { programHash, variantHash } = registry.describe(group.canonical);
    const report = (
      fields: Omit<GroupReport, 'chunk' | 'programHash' | 'variantHash' | 'castShadow' | 'receiveShadow'>,
    ): GroupReport => ({
      ...fields,
      chunk: group.chunk,
      programHash,
      variantHash,
      castShadow: group.castShadow,
      receiveShadow: group.receiveShadow,
    });
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
        if (material !== group.canonical)
          material.name = `${group.canonical.name || group.canonical.type} (forge instanced)`;
        // The level meshes are children of the scene: scene-space masters (an untransformed scene passes the world matrices).
        const matrices = space.update()
          ? meshes.map((m) => m.matrixWorld)
          : meshes.map((m) => space.toLocal(m.matrixWorld, new Matrix4()));
        const colors = perInstanceColor ? meshes.map((m) => (m.material as Material & { color: Color }).color) : null;
        const lods = lodDistances ? lodsOf(geometry) : [];
        const instanced = createCulledInstancedMesh(geometry, material, matrices, colors, coordinateSystem, {
          ...(lodDistances ? { lods, distances: lodDistances } : {}),
          ...(options.passes ? { passes: options.passes } : {}),
        });
        const index = nextIndex(perProgramInstanced, programHash);
        instanced.levels.forEach((level, L) => {
          level.name =
            L === 0 ? `forge:instanced:${programHash}:${index}` : `forge:instanced:${programHash}:${index}:lod${L}`;
          level.userData.forgeChunk = group.chunk;
          level.castShadow = group.castShadow;
          level.receiveShadow = group.receiveShadow;
          scene.add(level);
          result.instanced.push(level);
          result.originals.set(level, meshes.slice());
        });
        meshes.forEach((mesh, i) => result.slots.set(mesh, { batch: instanced, instanceId: i }));
        result.groups.push(
          report({
            name: instanced.name,
            kind: 'instanced',
            instances: meshes.length,
            geometries: 1,
            lods: instanced.levels.length - 1,
            transparent: false,
          }),
        );
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
    const bakeable =
      provenReads &&
      !group.meshes.some((m) => unbakeableAttribute(m.geometry, group.canonical.vertexColors, provenReads) !== null);
    const bake = group.meshes.some((m) => options.noBake?.has(m)) ? undefined : options.bake;
    if (bake && !bakeable) result.unbakeable += group.meshes.length;
    if (bake && bakeable) {
      const index = nextIndex(perProgramBaked, programHash);
      const baked = bakeGroup(group, bake, shareCanonical, `forge:bake:${programHash}:${index}`, space);
      scene.add(baked.mesh);
      result.baked.push(baked);
      group.meshes.forEach((mesh, i) => result.slots.set(mesh, { batch: baked.mesh, instanceId: i }));
      result.originals.set(baked.mesh as never, group.meshes);
      result.groups.push(
        report({
          name: baked.mesh.name,
          kind: 'baked',
          bake: baked.report,
          lods: 0,
          instances: group.meshes.length,
          geometries: new Set(group.meshes.map((m) => m.geometry)).size,
          transparent: (baked.mesh.material as Material).transparent,
        }),
      );
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

    const index = nextIndex(perProgram, programHash);

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
    result.groups.push(
      report({
        name: batch.name,
        kind: 'batched',
        lods: lodLevels,
        instances: group.meshes.length,
        geometries: unique.size,
        transparent: material.transparent,
      }),
    );
  }
  return result;
}
