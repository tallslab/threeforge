/**
 * Geometry bake for finished groups: merge into world space, drop contact seams between touching modules, drop
 * duplicated faces, optionally drop truly buried faces, then weld vertices whose position, normal, uv and colour
 * agree. A wrong deletion is visible and a missed one is invisible, so every rule is conservative and every
 * removal is counted and returned as geometry (`removed`) that an agent can render to check.
 */
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Matrix3, Matrix4, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export interface BakeEntry {
  geometry: BufferGeometry;
  /** World matrix of the module. */
  matrix: Matrix4;
  /** Per-module tint (an instance colour); white or absent means none. */
  color?: Color | null;
  /** `false` keeps this module's triangles exactly as they are: no removal, no welding. */
  bake?: boolean;
  /** The material draws both faces: a buried face then needs both hemispheres blocked. */
  doubleSided?: boolean;
}

export interface BuriedOptions {
  /** Rays per face over the front hemisphere (default 24). */
  samples?: number;
  /** A face is buried only when every ray is blocked within this many world units (default 0.1). */
  distance?: number;
}

export interface BakeOptions {
  /** Position tolerance for "the same point", in world units (default 1e-4). */
  tolerance?: number;
  /** Normals within this many degrees weld (default 0.5). */
  normalAngle?: number;
  /** Colour channels within this weld (default 1/255). */
  colorTolerance?: number;
  /** Remove pairs of coincident, opposite-winding triangles: seams between touching modules (default true). */
  removeContactFaces?: boolean;
  /** Keep one of several coincident, same-winding triangles (default true). */
  removeDuplicateFaces?: boolean;
  /** Remove faces that cannot be seen because solid geometry sits right in front of them (default false). */
  removeBuried?: boolean | BuriedOptions;
}

export interface BakeReport {
  inputVertices: number;
  inputTriangles: number;
  vertices: number;
  triangles: number;
  weldedVertices: number;
  contactFaces: number;
  duplicateFaces: number;
  buriedFaces: number;
  degenerateFaces: number;
  excludedEntries: number;
}

export interface BakeResult {
  geometry: BufferGeometry;
  /** The removed triangles (positions only): render them to see exactly what the bake took away. */
  removed: BufferGeometry;
  report: BakeReport;
  /** Entry index per output triangle, for mapping a hit back to its module. */
  triangleOrigins: Uint32Array;
  hasColor: boolean;
  hasUv: boolean;
}

const DEFAULTS = { tolerance: 1e-4, normalAngle: 0.5, colorTolerance: 1 / 255, removeContactFaces: true, removeDuplicateFaces: true };
const BURIED_DEFAULTS: Required<BuriedOptions> = { samples: 24, distance: 0.1 };
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

interface Gathered {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array | null;
  color: Float32Array | null;
  /** Entry index per vertex. */
  vertexEntry: Uint32Array;
  /** Vertex indices, three per triangle. */
  index: Uint32Array;
  triangleEntry: Uint32Array;
  locked: Uint8Array;
}

function gather(entries: BakeEntry[]): Gathered & { hasColor: boolean; hasUv: boolean } {
  const hasUv = entries.every((e) => e.geometry.attributes.uv !== undefined);
  const hasColor = entries.some((e) => e.geometry.attributes.color !== undefined || (e.color && (e.color.r !== 1 || e.color.g !== 1 || e.color.b !== 1)));
  let vertexTotal = 0;
  let triangleTotal = 0;
  for (const e of entries) {
    vertexTotal += e.geometry.attributes.position!.count;
    triangleTotal += (e.geometry.index ? e.geometry.index.count : e.geometry.attributes.position!.count) / 3;
  }
  const position = new Float32Array(vertexTotal * 3);
  const normal = new Float32Array(vertexTotal * 3);
  const uv = hasUv ? new Float32Array(vertexTotal * 2) : null;
  const color = hasColor ? new Float32Array(vertexTotal * 3) : null;
  const vertexEntry = new Uint32Array(vertexTotal);
  const index = new Uint32Array(triangleTotal * 3);
  const triangleEntry = new Uint32Array(triangleTotal);
  const locked = new Uint8Array(vertexTotal);
  const normalMatrix = new Matrix3();
  const v = new Vector3();
  let vOffset = 0;
  let tOffset = 0;
  entries.forEach((e, k) => {
    const g = e.geometry;
    const pos = g.attributes.position!;
    let nrm = g.attributes.normal;
    if (!nrm) {
      const clone = g.clone();
      clone.computeVertexNormals();
      nrm = clone.attributes.normal!;
    }
    normalMatrix.getNormalMatrix(e.matrix);
    const mirrored = e.matrix.determinant() < 0;
    const tint = e.color ?? null;
    const gColor = g.attributes.color;
    const gUv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(e.matrix);
      position.set([v.x, v.y, v.z], (vOffset + i) * 3);
      v.fromBufferAttribute(nrm, i).applyMatrix3(normalMatrix).normalize();
      normal.set([v.x, v.y, v.z], (vOffset + i) * 3);
      if (uv && gUv) uv.set([gUv.getX(i), gUv.getY(i)], (vOffset + i) * 2);
      if (color) {
        const r = (gColor ? gColor.getX(i) : 1) * (tint ? tint.r : 1);
        const gc = (gColor ? gColor.getY(i) : 1) * (tint ? tint.g : 1);
        const b = (gColor ? gColor.getZ(i) : 1) * (tint ? tint.b : 1);
        color.set([r, gc, b], (vOffset + i) * 3);
      }
      vertexEntry[vOffset + i] = k;
      locked[vOffset + i] = e.bake === false ? 1 : 0;
    }
    const count = g.index ? g.index.count : pos.count;
    for (let t = 0; t < count / 3; t++) {
      const a = g.index ? g.index.getX(t * 3) : t * 3;
      const b = g.index ? g.index.getX(t * 3 + 1) : t * 3 + 1;
      const c = g.index ? g.index.getX(t * 3 + 2) : t * 3 + 2;
      const o = (tOffset + t) * 3;
      index[o] = vOffset + a;
      index[o + 1] = vOffset + (mirrored ? c : b);
      index[o + 2] = vOffset + (mirrored ? b : c);
      triangleEntry[tOffset + t] = k;
    }
    vOffset += pos.count;
    tOffset += count / 3;
  });
  return { position, normal, uv, color, vertexEntry, index, triangleEntry, locked, hasColor, hasUv };
}

/** Parity of the permutation taking (a, b, c) to sorted order: +1 even (same winding as sorted), -1 odd. */
function parity(a: number, b: number, c: number): 1 | -1 {
  let inversions = 0;
  if (a > b) inversions++;
  if (a > c) inversions++;
  if (b > c) inversions++;
  return inversions % 2 === 0 ? 1 : -1;
}

/** Union-find over triangle ids: islands of triangles connected by shared edges. */
class Islands {
  private readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * Coplanar contact: triangles are grouped by plane, split into the two facing sides, and each side is merged into
 * islands (polygons) along shared edges. An island whose boundary edges exactly equal an island's on the other
 * side is a seam between two touching modules: both go, whatever their triangulation. Equal boundaries on the
 * same side are duplicates: one stays. Partial overlaps are left alone (invisible cost, never a visible hole).
 */
function coincidentIslands(
  g: Gathered,
  posIds: Uint32Array,
  candidates: number[],
  tolerance: number,
): { seams: number[]; duplicates: number[] } {
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();
  const inv = 1 / tolerance;
  // Plane key (sign-canonical) and side per triangle.
  const planes = new Map<string, { plus: number[]; minus: number[] }>();
  const triangleSide = new Map<number, 1 | -1>();
  for (const t of candidates) {
    a.fromArray(g.position, g.index[t * 3]! * 3);
    b.fromArray(g.position, g.index[t * 3 + 1]! * 3);
    c.fromArray(g.position, g.index[t * 3 + 2]! * 3);
    n.copy(b).sub(a).cross(c.sub(a));
    if (n.lengthSq() < 1e-20) continue;
    n.normalize();
    let side: 1 | -1 = 1;
    const first = Math.abs(n.x) > 1e-6 ? n.x : Math.abs(n.y) > 1e-6 ? n.y : n.z;
    if (first < 0) {
      n.negate();
      side = -1;
    }
    const d = n.dot(a);
    const key = `${Math.round(n.x * 1000)},${Math.round(n.y * 1000)},${Math.round(n.z * 1000)}|${Math.round(d * inv)}`;
    let plane = planes.get(key);
    if (!plane) planes.set(key, (plane = { plus: [], minus: [] }));
    (side === 1 ? plane.plus : plane.minus).push(t);
    triangleSide.set(t, side);
  }
  const seams: number[] = [];
  const duplicates: number[] = [];
  const edgeKey = (x: number, y: number): string => (x < y ? `${x}-${y}` : `${y}-${x}`);
  const islandsOf = (tris: number[]): Map<string, number[]> => {
    const local = new Map<number, number>();
    tris.forEach((t, i) => local.set(t, i));
    const uf = new Islands(tris.length);
    const byEdge = new Map<string, number>();
    for (const t of tris) {
      const ids = [posIds[g.index[t * 3]!]!, posIds[g.index[t * 3 + 1]!]!, posIds[g.index[t * 3 + 2]!]!];
      for (let k = 0; k < 3; k++) {
        const key = edgeKey(ids[k]!, ids[(k + 1) % 3]!);
        const other = byEdge.get(key);
        if (other !== undefined) uf.union(local.get(t)!, local.get(other)!);
        else byEdge.set(key, t);
      }
    }
    const groups = new Map<number, number[]>();
    for (const t of tris) {
      const root = uf.find(local.get(t)!);
      const list = groups.get(root);
      if (list) list.push(t);
      else groups.set(root, [t]);
    }
    // Boundary signature: edges used exactly once inside the island, sorted.
    const out = new Map<string, number[]>();
    for (const island of groups.values()) {
      const counts = new Map<string, number>();
      for (const t of island) {
        const ids = [posIds[g.index[t * 3]!]!, posIds[g.index[t * 3 + 1]!]!, posIds[g.index[t * 3 + 2]!]!];
        for (let k = 0; k < 3; k++) {
          const key = edgeKey(ids[k]!, ids[(k + 1) % 3]!);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      const boundary = [...counts.entries()].filter(([, c]) => c === 1).map(([k]) => k).sort().join(';');
      const existing = out.get(boundary);
      if (existing) duplicates.push(...island); // same side, same outline: keep the first island only
      else out.set(boundary, island);
    }
    return out;
  };
  for (const plane of planes.values()) {
    const plus = islandsOf(plane.plus);
    const minus = islandsOf(plane.minus);
    for (const [boundary, island] of plus) {
      const facing = minus.get(boundary);
      if (facing && boundary.length > 0) seams.push(...island, ...facing);
    }
  }
  return { seams, duplicates };
}

/** Merge modules into one world-space geometry with the removals and welds described by `options`. */
export function bakeGeometries(entries: BakeEntry[], options: BakeOptions = {}): BakeResult {
  const opts = { ...DEFAULTS, ...options };
  const buried: Required<BuriedOptions> | null = options.removeBuried ? { ...BURIED_DEFAULTS, ...(typeof options.removeBuried === 'object' ? options.removeBuried : {}) } : null;
  const g = gather(entries);
  const vertexCount = g.vertexEntry.length;
  const triangleCount = g.triangleEntry.length;
  const report: BakeReport = {
    inputVertices: vertexCount,
    inputTriangles: triangleCount,
    vertices: 0,
    triangles: 0,
    weldedVertices: 0,
    contactFaces: 0,
    duplicateFaces: 0,
    buriedFaces: 0,
    degenerateFaces: 0,
    excludedEntries: entries.filter((e) => e.bake === false).length,
  };

  // 1. Position identity: vertices within `tolerance` share a posId (locked vertices keep their own).
  const inv = 1 / opts.tolerance;
  const posIds = new Uint32Array(vertexCount);
  const posMap = new Map<string, number>();
  let nextPos = 0;
  for (let i = 0; i < vertexCount; i++) {
    if (g.locked[i]) {
      posIds[i] = nextPos++;
      continue;
    }
    const key = `${Math.round(g.position[i * 3]! * inv)},${Math.round(g.position[i * 3 + 1]! * inv)},${Math.round(g.position[i * 3 + 2]! * inv)}`;
    let id = posMap.get(key);
    if (id === undefined) posMap.set(key, (id = nextPos++));
    posIds[i] = id;
  }

  // 2. Contact seams and duplicates on coplanar islands (see coincidentIslands).
  const removedTriangle = new Uint8Array(triangleCount);
  const triangleLocked = (t: number): boolean => g.locked[g.index[t * 3]!] === 1;
  const candidates: number[] = [];
  const seen = new Set<string>();
  for (let t = 0; t < triangleCount; t++) {
    const a = posIds[g.index[t * 3]!]!;
    const b = posIds[g.index[t * 3 + 1]!]!;
    const c = posIds[g.index[t * 3 + 2]!]!;
    if (a === b || b === c || a === c) {
      removedTriangle[t] = 1;
      report.degenerateFaces++;
      continue;
    }
    if (triangleLocked(t)) continue;
    // Exact duplicates (same points, same winding: a module placed twice) never reach the island pass, where
    // their shared edges would fuse the copies into one island.
    if (opts.removeDuplicateFaces) {
      const sorted = [a, b, c].sort((x, y) => x - y);
      const key = `${sorted[0]},${sorted[1]},${sorted[2]}|${parity(a, b, c)}`;
      if (seen.has(key)) {
        removedTriangle[t] = 1;
        report.duplicateFaces++;
        continue;
      }
      seen.add(key);
    }
    candidates.push(t);
  }
  if (opts.removeContactFaces || opts.removeDuplicateFaces) {
    const { seams, duplicates } = coincidentIslands(g, posIds, candidates, opts.tolerance);
    if (opts.removeContactFaces) {
      for (const t of seams) {
        if (!removedTriangle[t]) {
          removedTriangle[t] = 1;
          report.contactFaces++;
        }
      }
    }
    if (opts.removeDuplicateFaces) {
      for (const t of duplicates) {
        if (!removedTriangle[t]) {
          removedTriangle[t] = 1;
          report.duplicateFaces++;
        }
      }
    }
  }

  // 3. Buried faces (opt-in): every ray from the face's front, over the hemisphere, hits geometry within `distance`.
  if (buried) {
    const survivors: number[] = [];
    for (let t = 0; t < triangleCount; t++) if (!removedTriangle[t]) survivors.push(t);
    const occluder = new BufferGeometry();
    occluder.setAttribute('position', new BufferAttribute(g.position, 3));
    const occIndex = new Uint32Array(survivors.length * 3);
    survivors.forEach((t, i) => occIndex.set([g.index[t * 3]!, g.index[t * 3 + 1]!, g.index[t * 3 + 2]!], i * 3));
    occluder.setIndex(new BufferAttribute(occIndex, 1));
    const bvh = new MeshBVH(occluder);
    const ray = new Ray();
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const n = new Vector3();
    const t1 = new Vector3();
    const t2 = new Vector3();
    const eps = Math.max(opts.tolerance * 10, 1e-5);
    const blocked = (origin: Vector3, normal: Vector3): boolean => {
      t1.set(1, 0, 0);
      if (Math.abs(normal.x) > 0.9) t1.set(0, 1, 0);
      t1.cross(normal).normalize();
      t2.crossVectors(normal, t1);
      for (let i = 0; i < buried.samples; i++) {
        const z = 0.15 + (0.85 * (i + 0.5)) / buried.samples;
        const r = Math.sqrt(1 - z * z);
        const phi = i * GOLDEN;
        ray.origin.copy(origin);
        ray.direction.set(0, 0, 0).addScaledVector(t1, r * Math.cos(phi)).addScaledVector(t2, r * Math.sin(phi)).addScaledVector(normal, z).normalize();
        const hit = bvh.raycastFirst(ray, DoubleSide);
        if (!hit || hit.distance > buried.distance) return false;
      }
      return true;
    };
    for (const t of survivors) {
      if (triangleLocked(t)) continue;
      a.fromArray(g.position, g.index[t * 3]! * 3);
      b.fromArray(g.position, g.index[t * 3 + 1]! * 3);
      c.fromArray(g.position, g.index[t * 3 + 2]! * 3);
      n.copy(b).sub(a).cross(c.clone().sub(a)).normalize();
      const centroid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      const front = blocked(centroid.clone().addScaledVector(n, eps), n);
      if (!front) continue;
      const doubleSided = entries[g.triangleEntry[t]!]!.doubleSided === true;
      if (doubleSided && !blocked(centroid.clone().addScaledVector(n, -eps), n.clone().negate())) continue;
      removedTriangle[t] = 1;
      report.buriedFaces++;
    }
    occluder.dispose();
  }

  // 4. Weld: same posId, normals within normalAngle, identical uv, colours within colorTolerance.
  const cosTol = Math.cos((opts.normalAngle * Math.PI) / 180);
  const remap = new Int32Array(vertexCount).fill(-1);
  const buckets = new Map<number, number[]>(); // posId -> output vertex ids
  const outPosition: number[] = [];
  const outNormal: number[] = [];
  const outUv: number[] = [];
  const outColor: number[] = [];
  const emit = (i: number): number => {
    const id = outPosition.length / 3;
    outPosition.push(g.position[i * 3]!, g.position[i * 3 + 1]!, g.position[i * 3 + 2]!);
    outNormal.push(g.normal[i * 3]!, g.normal[i * 3 + 1]!, g.normal[i * 3 + 2]!);
    if (g.uv) outUv.push(g.uv[i * 2]!, g.uv[i * 2 + 1]!);
    if (g.color) outColor.push(g.color[i * 3]!, g.color[i * 3 + 1]!, g.color[i * 3 + 2]!);
    return id;
  };
  const matches = (i: number, out: number): boolean => {
    const dot = g.normal[i * 3]! * outNormal[out * 3]! + g.normal[i * 3 + 1]! * outNormal[out * 3 + 1]! + g.normal[i * 3 + 2]! * outNormal[out * 3 + 2]!;
    if (dot < cosTol) return false;
    if (g.uv && (Math.abs(g.uv[i * 2]! - outUv[out * 2]!) > 1e-5 || Math.abs(g.uv[i * 2 + 1]! - outUv[out * 2 + 1]!) > 1e-5)) return false;
    if (g.color) for (let k = 0; k < 3; k++) if (Math.abs(g.color[i * 3 + k]! - outColor[out * 3 + k]!) > opts.colorTolerance) return false;
    return true;
  };
  const vertexOf = (i: number): number => {
    if (remap[i]! >= 0) return remap[i]!;
    if (g.locked[i]) return (remap[i] = emit(i));
    const bucket = buckets.get(posIds[i]!);
    if (bucket) {
      for (const out of bucket) {
        if (matches(i, out)) {
          report.weldedVertices++;
          return (remap[i] = out);
        }
      }
    }
    const id = emit(i);
    if (bucket) bucket.push(id);
    else buckets.set(posIds[i]!, [id]);
    return (remap[i] = id);
  };
  const outIndex: number[] = [];
  const origins: number[] = [];
  const removedPositions: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
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
  // Vertices referenced only by removed triangles never get emitted, which is the right outcome; count them as welded away too.
  report.vertices = outPosition.length / 3;
  report.triangles = outIndex.length / 3;
  report.weldedVertices = vertexCount - report.vertices - removedOnlyVertices(g, removedTriangle, remap);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(outPosition), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(outNormal), 3));
  if (g.uv) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(outUv), 2));
  if (g.color) geometry.setAttribute('color', new BufferAttribute(new Float32Array(outColor), 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array(outIndex), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const removed = new BufferGeometry();
  removed.setAttribute('position', new BufferAttribute(new Float32Array(removedPositions), 3));
  removed.setIndex(new BufferAttribute(new Uint32Array(removedPositions.length / 3).map((_, i) => i), 1));
  return { geometry, removed, report, triangleOrigins: new Uint32Array(origins), hasColor: g.hasColor, hasUv: g.hasUv };
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
