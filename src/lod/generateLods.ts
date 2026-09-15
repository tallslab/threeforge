import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { BufferAttribute, BufferGeometry, type Object3D, type Mesh } from 'three';
import { ensureIndexed } from '../compiler/geometryCompat.js';

export interface LodOptions {
  /** Target share of the original triangle count per level, descending, e.g. [0.5, 0.2]. */
  ratios?: number[];
  /** Simplification error budget relative to the mesh extent (meshoptimizer `target_error`). */
  error?: number;
  /** Keep border edges (open meshes) fixed. */
  lockBorder?: boolean;
}

const LOD_KEY = 'forgeLods';

/** LOD geometries previously attached by `prepareLods` / `generateLods`, coarsest last. */
export function lodsOf(geometry: BufferGeometry): BufferGeometry[] {
  const lods: unknown = geometry.userData[LOD_KEY];
  return Array.isArray(lods) ? (lods as BufferGeometry[]) : [];
}

/**
 * Disposes the LOD geometries `generateLods` / `prepareLods` attached to `geometry` and removes them from it,
 * returning how many were disposed. The geometry itself is never touched — it is the caller's — and one that never
 * had levels is a no-op, so this is also the way to drop levels before attaching fresh ones with `prepareLods`.
 *
 * Only call it once nothing draws those levels. A compiled `World` with `lod` gives a geometry's levels straight to
 * the level meshes of its instanced groups (a batch copies them into its own buffers instead), so `decompile()` the
 * World first: threeforge never disposes them itself, since the same levels outlive any one compile and are shared
 * by every mesh holding that geometry.
 */
export function disposeLods(geometry: BufferGeometry): number {
  const lods = lodsOf(geometry);
  for (const lod of lods) lod.dispose();
  delete geometry.userData[LOD_KEY];
  return lods.length;
}

/**
 * Simplifies a geometry with meshoptimizer into one compacted geometry per ratio. Works in node (build scripts)
 * and in the browser. Positions drive the simplification; other attributes are carried through the vertex remap.
 * Never returns a level with more triangles than the previous one.
 */
export async function generateLods(geometry: BufferGeometry, options: LodOptions = {}): Promise<BufferGeometry[]> {
  const ratios = options.ratios ?? [0.5, 0.2];
  const error = options.error ?? 0.02;
  await MeshoptSimplifier.ready;

  const source = ensureIndexed(geometry);
  const position = source.attributes.position as BufferAttribute;
  const positions = position.array instanceof Float32Array ? position.array : Float32Array.from(position.array as ArrayLike<number>);
  const stride = position.itemSize;
  const sourceIndex = source.index!;
  const original = sourceIndex.array instanceof Uint32Array ? sourceIndex.array : Uint32Array.from(sourceIndex.array as ArrayLike<number>);
  // Weld vertices that share a position so seams and non-indexed triangle soups get real topology to collapse.
  const positionRemap = MeshoptSimplifier.generatePositionRemap(positions, stride);
  let indices: Uint32Array = new Uint32Array(original.length);
  for (let i = 0; i < original.length; i++) indices[i] = positionRemap[original[i]!]!;
  const flags = options.lockBorder ? (['LockBorder'] as const) : undefined;

  const lods: BufferGeometry[] = [];
  for (const ratio of ratios) {
    // Targets are multiples of 3, at least one triangle, and never above what the previous level still has.
    const target = Math.min(indices.length, Math.max(3, Math.floor((sourceIndex.count * ratio) / 3) * 3));
    let simplified: Uint32Array = indices;
    if (indices.length > target) {
      simplified = MeshoptSimplifier.simplify(indices, positions, stride, target, error, flags ? [...flags] : undefined)[0];
      // Low-poly meshes hit the error budget long before the target; distant LODs can trade quality for count.
      if (simplified.length > target * 1.25) {
        const sloppy = MeshoptSimplifier.simplifySloppy(indices, positions, stride, null, target, 1e30)[0];
        if (sloppy.length >= 3) simplified = sloppy;
      }
      // Never let a level lose everything or grow: fall back to the previous level's triangles.
      if (simplified.length < 3 || simplified.length > indices.length) simplified = indices;
    }
    lods.push(compact(source, simplified));
    indices = simplified;
  }
  return lods;
}

/** Builds a geometry from a simplified index buffer, dropping vertices no longer referenced. */
function compact(source: BufferGeometry, simplified: Uint32Array): BufferGeometry {
  const [remap, uniqueCount] = MeshoptSimplifier.compactMesh(simplified);
  const geometry = new BufferGeometry();
  for (const name of Object.keys(source.attributes)) {
    const attribute = source.attributes[name] as BufferAttribute;
    const itemSize = attribute.itemSize;
    const Ctor = attribute.array.constructor as new (n: number) => typeof attribute.array;
    const array = new Ctor(uniqueCount * itemSize);
    const src = attribute.array;
    for (let v = 0; v < remap.length; v++) {
      const dst = remap[v]!;
      if (dst === 0xffffffff) continue;
      for (let k = 0; k < itemSize; k++) array[dst * itemSize + k] = src[v * itemSize + k]!;
    }
    geometry.setAttribute(name, new BufferAttribute(array, itemSize, attribute.normalized));
  }
  const index = new Uint32Array(simplified.length);
  for (let i = 0; i < simplified.length; i++) index[i] = remap[simplified[i]!]!;
  geometry.setIndex(new BufferAttribute(uniqueCount > 65535 ? index : Uint16Array.from(index), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = `${source.name || 'geometry'} lod`;
  return geometry;
}

export interface PrepareLodsReport {
  /** Distinct geometries that received LODs in this call. */
  geometries: number;
  /** Geometries that already had LODs and were skipped. */
  skipped: number;
}

/** Generates and attaches LODs for every distinct mesh geometry under `root` that does not have them yet. */
export async function prepareLods(root: Object3D, options: LodOptions = {}): Promise<PrepareLodsReport> {
  const seen = new Set<BufferGeometry>();
  const report: PrepareLodsReport = { geometries: 0, skipped: 0 };
  const targets: BufferGeometry[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || seen.has(mesh.geometry)) return;
    seen.add(mesh.geometry);
    if (lodsOf(mesh.geometry).length > 0) report.skipped++;
    else targets.push(mesh.geometry);
  });
  for (const geometry of targets) {
    geometry.userData[LOD_KEY] = await generateLods(geometry, options);
    report.geometries++;
  }
  return report;
}
