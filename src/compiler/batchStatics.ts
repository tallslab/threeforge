import { BatchedMesh, Color, WebGLCoordinateSystem, type BufferGeometry, type CoordinateSystem, type InstancedMesh, type Material, type Mesh, type Scene } from 'three';
import { createCulledInstancedMesh } from './instancing.js';
import { lodsOf } from '../lod/generateLods.js';
import type { MaterialRegistry } from '../registry/MaterialRegistry.js';
import { attributeSignature, ensureIndexed } from './geometryCompat.js';

/** Where an original mesh went: a BatchedMesh instance id, or an InstancedMesh master index. */
export interface Slot {
  batch: BatchedMesh | InstancedMesh;
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
}

export interface GroupReport {
  name: string;
  kind: 'batched' | 'instanced';
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
  groups: GroupReport[];
  slots: Map<Mesh, Slot>;
  originals: Map<BatchedMesh | InstancedMesh, Mesh[]>;
  /** Statics that had nothing to share a batch with. */
  singletons: Mesh[];
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

  const result: BatchResult = { batches: [], instanced: [], groups: [], slots: new Map(), originals: new Map(), singletons: [], lodGeometryIds: new Map() };
  const perProgram = new Map<string, number>();
  const perProgramInstanced = new Map<string, number>();

  for (const group of groups.values()) {
    const { programHash, variantHash } = registry.describe(group.canonical);
    const canonicalHasColor = (group.canonical as Material & { color?: Color }).color !== undefined;

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
        const material = group.canonical.clone();
        if (canonicalHasColor) (material as Material & { color: Color }).color.copy(_white);
        material.name = `${group.canonical.name || group.canonical.type} (forge instanced)`;
        const matrices = meshes.map((m) => m.matrixWorld);
        const colors = canonicalHasColor ? meshes.map((m) => (m.material as Material & { color: Color }).color) : null;
        const lods = lodDistances ? lodsOf(geometry) : [];
        const instanced = createCulledInstancedMesh(geometry, material, matrices, colors, coordinateSystem, lodDistances ? { lods, distances: lodDistances } : {});
        const index = perProgramInstanced.get(programHash) ?? 0;
        perProgramInstanced.set(programHash, index + 1);
        instanced.levels.forEach((level, L) => {
          level.name = L === 0 ? `forge:instanced:${programHash}:${index}` : `forge:instanced:${programHash}:${index}:lod${L}`;
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

    if (group.meshes.length < 2) {
      result.singletons.push(...group.meshes);
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

    const material = group.canonical.clone();
    const hasColor = canonicalHasColor;
    if (hasColor) (material as Material & { color: Color }).color.copy(_white);
    material.name = `${group.canonical.name || group.canonical.type} (forge batch)`;

    const index = perProgram.get(programHash) ?? 0;
    perProgram.set(programHash, index + 1);

    const batch = new BatchedMesh(group.meshes.length, maxVertexCount, maxIndexCount, material);
    batch.name = `forge:batch:${programHash}:${index}`;
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
