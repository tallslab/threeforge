import { BatchedMesh, Color, type BufferGeometry, type Material, type Mesh, type Scene } from 'three';
import type { MaterialRegistry } from '../registry/MaterialRegistry.js';
import { attributeSignature, ensureIndexed } from './geometryCompat.js';

export interface Slot {
  batch: BatchedMesh;
  instanceId: number;
}

export interface GroupReport {
  name: string;
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
  groups: GroupReport[];
  slots: Map<Mesh, Slot>;
  originals: Map<BatchedMesh, Mesh[]>;
  /** Statics that had nothing to share a batch with. */
  singletons: Mesh[];
}

interface Group {
  canonical: Material;
  meshes: Mesh[];
  castShadow: boolean;
  receiveShadow: boolean;
}

const _white = new Color(0xffffff);

/**
 * One BatchedMesh per (material variant, geometry attribute signature, shadow flags). Colour is per instance,
 * so materials that differ only by `color` share a batch. Originals are not modified here.
 */
export function batchStatics(statics: Mesh[], registry: MaterialRegistry, scene: Scene): BatchResult {
  const groups = new Map<string, Group>();
  for (const mesh of statics) {
    if (Array.isArray(mesh.material)) continue;
    const canonical = registry.register(mesh.material);
    const keys = registry.keys(canonical);
    const key = `${keys.variantKey}|${attributeSignature(mesh.geometry)}|${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { canonical, meshes: [], castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow }));
    group.meshes.push(mesh);
  }

  const result: BatchResult = { batches: [], groups: [], slots: new Map(), originals: new Map(), singletons: [] };
  const perProgram = new Map<string, number>();

  for (const group of groups.values()) {
    if (group.meshes.length < 2) {
      result.singletons.push(...group.meshes);
      continue;
    }
    const unique = new Map<BufferGeometry, BufferGeometry>();
    for (const mesh of group.meshes) {
      if (!unique.has(mesh.geometry)) unique.set(mesh.geometry, ensureIndexed(mesh.geometry));
    }
    let maxVertexCount = 0;
    let maxIndexCount = 0;
    for (const geometry of unique.values()) {
      maxVertexCount += geometry.attributes.position?.count ?? 0;
      maxIndexCount += geometry.index?.count ?? 0;
    }

    const material = group.canonical.clone();
    const hasColor = (material as Material & { color?: Color }).color !== undefined;
    if (hasColor) (material as Material & { color: Color }).color.copy(_white);
    material.name = `${group.canonical.name || group.canonical.type} (forge batch)`;

    const { programHash, variantHash } = registry.describe(group.canonical);
    const index = perProgram.get(programHash) ?? 0;
    perProgram.set(programHash, index + 1);

    const batch = new BatchedMesh(group.meshes.length, maxVertexCount, maxIndexCount, material);
    batch.name = `forge:batch:${programHash}:${index}`;
    batch.sortObjects = material.transparent;
    batch.perObjectFrustumCulled = true;
    batch.castShadow = group.castShadow;
    batch.receiveShadow = group.receiveShadow;

    const geometryIds = new Map<BufferGeometry, number>();
    const originals: Mesh[] = [];
    for (const mesh of group.meshes) {
      let geometryId = geometryIds.get(mesh.geometry);
      if (geometryId === undefined) {
        geometryId = batch.addGeometry(unique.get(mesh.geometry)!);
        geometryIds.set(mesh.geometry, geometryId);
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
    result.groups.push({
      name: batch.name,
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
