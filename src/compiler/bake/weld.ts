import { BufferAttribute, BufferGeometry } from 'three';
import type { Gathered } from './gather.js';

/** Per-vertex attributes a comparator reads: three normal components, four tangent ones, two per uv set, three colour ones. */
export interface VertexAttributes {
  normal: ArrayLike<number>;
  tangent: ArrayLike<number> | null;
  uvs: readonly ArrayLike<number>[];
  color: ArrayLike<number> | null;
}

/** Whether vertex `i` of `a` and vertex `j` of `b` draw the same. */
export type VertexComparator = (a: VertexAttributes, i: number, b: VertexAttributes, j: number) => boolean;

/**
 * The weld's rule for "draws the same": normal and tangent direction within `normalAngle` degrees, identical tangent w
 * and uv (1e-5), colour within `colorTolerance`. The duplicate rule judges copies by the same comparator.
 */
export function vertexComparator(normalAngle: number, colorTolerance: number): VertexComparator {
  const cosTol = Math.cos((normalAngle * Math.PI) / 180);
  return (a, i, b, j) => {
    const dot =
      a.normal[i * 3]! * b.normal[j * 3]! +
      a.normal[i * 3 + 1]! * b.normal[j * 3 + 1]! +
      a.normal[i * 3 + 2]! * b.normal[j * 3 + 2]!;
    if (dot < cosTol) return false;
    if (a.tangent && b.tangent) {
      const o = i * 4;
      const p = j * 4;
      if (a.tangent[o + 3] !== b.tangent[p + 3]) return false;
      const x = a.tangent[o]!,
        y = a.tangent[o + 1]!,
        z = a.tangent[o + 2]!;
      const ox = b.tangent[p]!,
        oy = b.tangent[p + 1]!,
        oz = b.tangent[p + 2]!;
      // Exactly equal directions weld even when degenerate (a zero tangent).
      if (x * ox + y * oy + z * oz < cosTol && (x !== ox || y !== oy || z !== oz)) return false;
    }
    for (let k = 0; k < a.uvs.length; k++) {
      const set = a.uvs[k]!;
      const other = b.uvs[k]!;
      if (Math.abs(set[i * 2]! - other[j * 2]!) > 1e-5 || Math.abs(set[i * 2 + 1]! - other[j * 2 + 1]!) > 1e-5)
        return false;
    }
    if (a.color && b.color)
      for (let k = 0; k < 3; k++)
        if (Math.abs(a.color[i * 3 + k]! - b.color[j * 3 + k]!) > colorTolerance) return false;
    return true;
  };
}

interface OutputAttributes extends VertexAttributes {
  normal: number[];
  tangent: number[] | null;
  uvs: number[][];
  color: number[] | null;
}

export interface Welded {
  geometry: BufferGeometry;
  /** The removed triangles (positions only). */
  removed: BufferGeometry;
  /** Entry index per output triangle. */
  triangleOrigins: Uint32Array;
  vertices: number;
  triangles: number;
  weldedVertices: number;
}

/**
 * Weld: the surviving triangles re-indexed over one output vertex per posId and distinct look (`same`), locked vertices
 * kept as they are; the removed triangles as their own geometry.
 */
export function weld(g: Gathered, posIds: Uint32Array, removedTriangle: Uint8Array, same: VertexComparator): Welded {
  const vertexCount = g.vertexEntry.length;
  const remap = new Int32Array(vertexCount).fill(-1);
  const buckets = new Map<number, number[]>(); // posId -> output vertex ids
  const outPosition: number[] = [];
  const out: OutputAttributes = {
    normal: [],
    tangent: g.tangent ? [] : null,
    uvs: g.uvSets.map(() => []),
    color: g.color ? [] : null,
  };
  const emit = (i: number): number => {
    const id = outPosition.length / 3;
    outPosition.push(g.position[i * 3]!, g.position[i * 3 + 1]!, g.position[i * 3 + 2]!);
    out.normal.push(g.normal[i * 3]!, g.normal[i * 3 + 1]!, g.normal[i * 3 + 2]!);
    if (g.tangent)
      out.tangent!.push(g.tangent[i * 4]!, g.tangent[i * 4 + 1]!, g.tangent[i * 4 + 2]!, g.tangent[i * 4 + 3]!);
    for (let k = 0; k < g.uvs.length; k++) out.uvs[k]!.push(g.uvs[k]![i * 2]!, g.uvs[k]![i * 2 + 1]!);
    if (g.color) out.color!.push(g.color[i * 3]!, g.color[i * 3 + 1]!, g.color[i * 3 + 2]!);
    return id;
  };
  const vertexOf = (i: number): number => {
    if (remap[i]! >= 0) return remap[i]!;
    if (g.locked[i]) return (remap[i] = emit(i));
    const bucket = buckets.get(posIds[i]!);
    if (bucket) {
      for (const id of bucket) if (same(g, i, out, id)) return (remap[i] = id);
    }
    const id = emit(i);
    if (bucket) bucket.push(id);
    else buckets.set(posIds[i]!, [id]);
    return (remap[i] = id);
  };
  const outIndex: number[] = [];
  const origins: number[] = [];
  const removedPositions: number[] = [];
  for (let t = 0; t < g.triangleEntry.length; t++) {
    if (removedTriangle[t]) {
      for (let k = 0; k < 3; k++) {
        const i = g.index[t * 3 + k]!;
        removedPositions.push(g.position[i * 3]!, g.position[i * 3 + 1]!, g.position[i * 3 + 2]!);
      }
      continue;
    }
    outIndex.push(vertexOf(g.index[t * 3]!), vertexOf(g.index[t * 3 + 1]!), vertexOf(g.index[t * 3 + 2]!));
    origins.push(g.triangleEntry[t]!);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(outPosition), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(out.normal), 3));
  if (out.tangent) geometry.setAttribute('tangent', new BufferAttribute(new Float32Array(out.tangent), 4));
  g.uvSets.forEach((name, k) => geometry.setAttribute(name, new BufferAttribute(new Float32Array(out.uvs[k]!), 2)));
  if (out.color) geometry.setAttribute('color', new BufferAttribute(new Float32Array(out.color), 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array(outIndex), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const removed = new BufferGeometry();
  removed.setAttribute('position', new BufferAttribute(new Float32Array(removedPositions), 3));
  removed.setIndex(
    new BufferAttribute(
      new Uint32Array(removedPositions.length / 3).map((_, i) => i),
      1,
    ),
  );
  const vertices = outPosition.length / 3;
  // Vertices referenced only by removed triangles never get emitted, which is the right outcome; count them as welded away too.
  return {
    geometry,
    removed,
    triangleOrigins: new Uint32Array(origins),
    vertices,
    triangles: outIndex.length / 3,
    weldedVertices: vertexCount - vertices - removedOnlyVertices(g, removedTriangle, remap),
  };
}

/** Vertices that only removed triangles referenced: gone, but not "welded". */
function removedOnlyVertices(g: Gathered, removedTriangle: Uint8Array, remap: Int32Array): number {
  const referenced = new Uint8Array(g.vertexEntry.length);
  for (let t = 0; t < g.triangleEntry.length; t++) {
    if (removedTriangle[t]) continue;
    referenced[g.index[t * 3]!] = 1;
    referenced[g.index[t * 3 + 1]!] = 1;
    referenced[g.index[t * 3 + 2]!] = 1;
  }
  let n = 0;
  for (let i = 0; i < referenced.length; i++) if (!referenced[i] && remap[i]! < 0) n++;
  return n;
}
