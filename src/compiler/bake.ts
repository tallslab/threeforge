/**
 * Geometry bake for finished groups: merge into one geometry, drop contact seams between touching solid modules, drop
 * duplicated faces, optionally drop truly buried faces, then weld vertices whose position, normal, tangent, uv and
 * colour agree. A wrong deletion is visible and a missed one is invisible, so every rule is conservative (a coincident
 * pair that is not provably a seam between two solids stays, and is counted) and every removal is counted and
 * returned as geometry (`removed`) that an agent can render to check.
 */
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Matrix3, Matrix4, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export interface BakeEntry {
  geometry: BufferGeometry;
  /** Matrix of the module in the baked space (the scene's space under `World`, else usually its world matrix). */
  matrix: Matrix4;
  /** Per-module tint (an instance colour); white or absent means none. */
  color?: Color | null;
  /** `false` keeps this module's triangles exactly as they are: no removal, no welding. */
  bake?: boolean;
  /** The material draws both faces: a buried face then needs both hemispheres blocked, and no seam involving it goes. Absent means single-sided. */
  doubleSided?: boolean;
  /**
   * The material hides whatever lies behind its faces (`bakeEntriesOf` decides it from the material). Only opaque
   * modules lose seam or buried faces, and only their faces block buried-face rays. Absent counts as NOT opaque: that
   * entry gets no seam and no buried-face removal (a missed deletion is invisible, a wrong one is visible).
   */
  opaque?: boolean;
  /**
   * The material reads the geometry's `color` attribute. `false` ignores the attribute, so only the tint colours the
   * module, as three draws a material without `vertexColors`. Absent keeps multiplying the attribute by the tint.
   */
  vertexColors?: boolean;
}

export interface BuriedOptions {
  /** Rays per face over the front hemisphere (default 24). */
  samples?: number;
  /** A face is buried only when every ray is blocked within this depth along the face normal, in world units (default 0.1): solid right in front of it, unlike a room interior. */
  distance?: number;
}

export interface BakeOptions {
  /** Position tolerance for "the same point", in world units (default 1e-4). */
  tolerance?: number;
  /** Normals (and tangent directions) within this many degrees weld (default 0.5). */
  normalAngle?: number;
  /** Colour channels within this weld (default 1/255). */
  colorTolerance?: number;
  /**
   * Remove seams between touching solids (default true): a coincident, opposite-winding pair goes only when its two
   * sides come from different entries that are all closed, outward, single-sided and opaque. Every other coincident,
   * opposite pair stays and is counted in `keptCoincidentFaces`.
   */
  removeContactFaces?: boolean;
  /** Keep one of several coincident, same-winding triangles (default true). */
  removeDuplicateFaces?: boolean;
  /** Remove faces of opaque entries that cannot be seen because opaque geometry sits right in front of them (default false). */
  removeBuried?: boolean | BuriedOptions;
}

export interface BakeReport {
  inputVertices: number;
  inputTriangles: number;
  vertices: number;
  triangles: number;
  weldedVertices: number;
  contactFaces: number;
  /** Faces of coincident, opposite-winding pairs the seam rule kept because a condition failed (0 while `removeContactFaces` is off). */
  keptCoincidentFaces: number;
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
  /** Four per vertex (xyz in the baked space, w as given) when every entry has a `tangent` attribute. */
  tangent: Float32Array | null;
  /** UV sets present in every entry (`uv`, `uv1`, `uv2`, `uv3`), and their gathered coordinates in the same order. */
  uvSets: string[];
  uvs: Float32Array[];
  color: Float32Array | null;
  /** Entry index per vertex. */
  vertexEntry: Uint32Array;
  /** Vertex indices, three per triangle. */
  index: Uint32Array;
  triangleEntry: Uint32Array;
  /** First triangle of each entry, plus the total at the end: entry k owns triangles [entryTriangles[k], entryTriangles[k + 1]). */
  entryTriangles: Uint32Array;
  locked: Uint8Array;
}

function gather(entries: BakeEntry[]): Gathered & { hasColor: boolean; hasUv: boolean } {
  const uvSets = ['uv', 'uv1', 'uv2', 'uv3'].filter((name) => entries.every((e) => e.geometry.attributes[name] !== undefined));
  const hasUv = uvSets.includes('uv');
  const readsColor = (e: BakeEntry): boolean => e.vertexColors !== false && e.geometry.attributes.color !== undefined;
  const hasColor = entries.some((e) => readsColor(e) || (e.color && (e.color.r !== 1 || e.color.g !== 1 || e.color.b !== 1)));
  const hasTangent = entries.length > 0 && entries.every((e) => e.geometry.attributes.tangent !== undefined);
  let vertexTotal = 0;
  let triangleTotal = 0;
  for (const e of entries) {
    vertexTotal += e.geometry.attributes.position!.count;
    triangleTotal += (e.geometry.index ? e.geometry.index.count : e.geometry.attributes.position!.count) / 3;
  }
  const position = new Float32Array(vertexTotal * 3);
  const normal = new Float32Array(vertexTotal * 3);
  const tangent = hasTangent ? new Float32Array(vertexTotal * 4) : null;
  const uvs = uvSets.map(() => new Float32Array(vertexTotal * 2));
  const color = hasColor ? new Float32Array(vertexTotal * 3) : null;
  const vertexEntry = new Uint32Array(vertexTotal);
  const index = new Uint32Array(triangleTotal * 3);
  const triangleEntry = new Uint32Array(triangleTotal);
  const entryTriangles = new Uint32Array(entries.length + 1);
  const locked = new Uint8Array(vertexTotal);
  const normalMatrix = new Matrix3();
  const v = new Vector3();
  let vOffset = 0;
  let tOffset = 0;
  entries.forEach((e, k) => {
    entryTriangles[k] = tOffset;
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
    const gColor = readsColor(e) ? g.attributes.color : undefined;
    const gTangent = tangent ? g.attributes.tangent! : null;
    const gUvs = uvSets.map((name) => g.attributes[name]!);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(e.matrix);
      position.set([v.x, v.y, v.z], (vOffset + i) * 3);
      v.fromBufferAttribute(nrm, i).applyMatrix3(normalMatrix).normalize();
      normal.set([v.x, v.y, v.z], (vOffset + i) * 3);
      if (gTangent) {
        // A surface direction: turned by the matrix's upper 3x3 and normalised. `w` stays as it is, even when the
        // matrix mirrors: three builds the bitangent as cross(normalView, tangentView) * tangent.w with no determinant
        // term (nodes/accessors/Bitangent.js, ShaderChunk/normal_vertex.glsl.js), so that is what the naive mesh drew.
        v.set(gTangent.getX(i), gTangent.getY(i), gTangent.getZ(i)).transformDirection(e.matrix);
        const o = (vOffset + i) * 4;
        tangent![o] = v.x;
        tangent![o + 1] = v.y;
        tangent![o + 2] = v.z;
        tangent![o + 3] = gTangent.itemSize >= 4 ? gTangent.getW(i) : 1;
      }
      for (let k = 0; k < gUvs.length; k++) uvs[k]!.set([gUvs[k]!.getX(i), gUvs[k]!.getY(i)], (vOffset + i) * 2);
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
  entryTriangles[entries.length] = tOffset;
  return { position, normal, tangent, uvSets, uvs, color, vertexEntry, index, triangleEntry, entryTriangles, locked, hasColor, hasUv };
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
 * Whether entry `k` is a closed, outward shell in every connected component (triangles joined by shared edges, by
 * position identity; degenerate triangles skipped): every edge is used equally often in both directions, and every
 * component encloses a positive signed volume beyond a flat slab's (`volume > area * tolerance`). Positions and
 * winding are the gathered ones, already reversed for a mirrored matrix, so a shell outward in its own space stays
 * outward. Per component, not per entry: an inside-out part next to a larger outward one would pass a total.
 */
function closedOutwardShell(g: Gathered, posIds: Uint32Array, posCount: number, k: number, tolerance: number): boolean {
  const start = g.entryTriangles[k]!;
  const end = g.entryTriangles[k + 1]!;
  const edgeKey = (u: number, v: number): number => (u < v ? u * posCount + v : v * posCount + u);
  const triangles: number[] = [];
  // +1 per use of an edge from its lower posId to its higher, -1 the other way: 0 everywhere when closed and consistently wound.
  const balance = new Map<number, number>();
  const tally = (u: number, v: number): void => {
    const key = edgeKey(u, v);
    balance.set(key, (balance.get(key) ?? 0) + (u < v ? 1 : -1));
  };
  for (let t = start; t < end; t++) {
    const a = posIds[g.index[t * 3]!]!;
    const b = posIds[g.index[t * 3 + 1]!]!;
    const c = posIds[g.index[t * 3 + 2]!]!;
    if (a === b || b === c || a === c) continue;
    triangles.push(t);
    tally(a, b);
    tally(b, c);
    tally(c, a);
  }
  if (triangles.length === 0) return false;
  for (const n of balance.values()) if (n !== 0) return false;
  const components = new Islands(triangles.length);
  const byEdge = new Map<number, number>();
  const join = (i: number, u: number, v: number): void => {
    const key = edgeKey(u, v);
    const other = byEdge.get(key);
    if (other === undefined) byEdge.set(key, i);
    else components.union(i, other);
  };
  triangles.forEach((t, i) => {
    const a = posIds[g.index[t * 3]!]!;
    const b = posIds[g.index[t * 3 + 1]!]!;
    const c = posIds[g.index[t * 3 + 2]!]!;
    join(i, a, b);
    join(i, b, c);
    join(i, c, a);
  });
  // Signed volume and area per component, relative to one of the entry's points (a closed surface's volume does not
  // depend on the origin; a near one keeps the products small).
  const p = g.position;
  const origin = g.index[triangles[0]! * 3]! * 3;
  const ox = p[origin]!;
  const oy = p[origin + 1]!;
  const oz = p[origin + 2]!;
  const volume = new Float64Array(triangles.length);
  const area = new Float64Array(triangles.length);
  triangles.forEach((t, i) => {
    const ia = g.index[t * 3]! * 3;
    const ib = g.index[t * 3 + 1]! * 3;
    const ic = g.index[t * 3 + 2]! * 3;
    const ax = p[ia]! - ox, ay = p[ia + 1]! - oy, az = p[ia + 2]! - oz;
    const bx = p[ib]! - ox, by = p[ib + 1]! - oy, bz = p[ib + 2]! - oz;
    const cx = p[ic]! - ox, cy = p[ic + 1]! - oy, cz = p[ic + 2]! - oz;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = cx - ax, wy = cy - ay, wz = cz - az;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const root = components.find(i);
    volume[root] = volume[root]! + (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    area[root] = area[root]! + Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
  });
  for (let i = 0; i < triangles.length; i++) {
    if (components.find(i) === i && !(volume[i]! > area[i]! * tolerance)) return false;
  }
  return true;
}

/**
 * Coplanar contact: triangles are grouped by plane, split into the two facing sides, and each side is merged into
 * islands (polygons) along shared edges. Equal boundaries on the same side are duplicates: one stays. An island whose
 * boundary edges exactly equal an island's on the other side is a coincident, opposite pair, whatever the
 * triangulation. It is a seam (both go) only when the two islands' entries are disjoint and `seamSafe` holds for
 * every entry involved (closed, outward, single-sided, opaque); otherwise both are `kept`. With `seamSafe` null
 * (contact removal off) no pair is judged. Partial overlaps are left alone (invisible cost, never a visible hole).
 */
function coincidentIslands(
  g: Gathered,
  posIds: Uint32Array,
  candidates: number[],
  tolerance: number,
  seamSafe: ((entry: number) => boolean) | null,
): { seams: number[]; duplicates: number[]; kept: number[] } {
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();
  const inv = 1 / tolerance;
  // Plane key (sign-canonical) and side per triangle.
  const planes = new Map<string, { plus: number[]; minus: number[] }>();
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
  }
  const seams: number[] = [];
  const duplicates: number[] = [];
  const kept: number[] = [];
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
  // The four seam conditions: the two islands' entries are disjoint, and every entry is safe (see `seamSafe`).
  const isSeam = (island: number[], facing: number[], safe: (entry: number) => boolean): boolean => {
    const own = new Set<number>();
    for (const t of island) own.add(g.triangleEntry[t]!);
    const other = new Set<number>();
    for (const t of facing) {
      const k = g.triangleEntry[t]!;
      if (own.has(k)) return false;
      other.add(k);
    }
    for (const k of own) if (!safe(k)) return false;
    for (const k of other) if (!safe(k)) return false;
    return true;
  };
  for (const plane of planes.values()) {
    const plus = islandsOf(plane.plus);
    const minus = islandsOf(plane.minus);
    if (!seamSafe) continue;
    for (const [boundary, island] of plus) {
      const facing = minus.get(boundary);
      if (!facing || boundary.length === 0) continue;
      (isSeam(island, facing, seamSafe) ? seams : kept).push(...island, ...facing);
    }
  }
  return { seams, duplicates, kept };
}

/** Merge modules into one geometry with the removals and welds described by `options`. */
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
    keptCoincidentFaces: 0,
    duplicateFaces: 0,
    buriedFaces: 0,
    degenerateFaces: 0,
    excludedEntries: entries.filter((e) => e.bake === false).length,
  };
  const opaque = (t: number): boolean => entries[g.triangleEntry[t]!]!.opaque === true;

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
    // An entry may lose seam faces only when it is opaque, single-sided and a closed, outward shell (computed once).
    const shells = new Int8Array(entries.length); // 0 not yet computed, 1 closed and outward, -1 not
    const seamSafe = (k: number): boolean => {
      const entry = entries[k]!;
      if (entry.opaque !== true || entry.doubleSided === true) return false;
      if (shells[k] === 0) shells[k] = closedOutwardShell(g, posIds, nextPos, k, opts.tolerance) ? 1 : -1;
      return shells[k] === 1;
    };
    const { seams, duplicates, kept } = coincidentIslands(g, posIds, candidates, opts.tolerance, opts.removeContactFaces ? seamSafe : null);
    if (opts.removeContactFaces) {
      for (const t of seams) {
        if (!removedTriangle[t]) {
          removedTriangle[t] = 1;
          report.contactFaces++;
        }
      }
      report.keptCoincidentFaces = kept.length;
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

  // 3. Buried faces (opt-in): every ray from the face's front, over the hemisphere, hits opaque geometry within
  // `distance`. Only opaque faces block, and only faces of opaque entries are removed.
  if (buried) {
    const occluders: number[] = [];
    for (let t = 0; t < triangleCount; t++) if (!removedTriangle[t] && opaque(t)) occluders.push(t);
    if (occluders.length > 0) {
      const occluder = new BufferGeometry();
      occluder.setAttribute('position', new BufferAttribute(g.position, 3));
      const occIndex = new Uint32Array(occluders.length * 3);
      occluders.forEach((t, i) => occIndex.set([g.index[t * 3]!, g.index[t * 3 + 1]!, g.index[t * 3 + 2]!], i * 3));
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
          // Depth along the face normal, so a wall parallel to the face at gap g blocks at g from every angle.
          if (!hit || hit.distance * z > buried.distance) return false;
        }
        return true;
      };
      // The occluders are exactly the surviving faces of opaque entries: the candidates for removal.
      for (const t of occluders) {
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
  }

  // 4. Weld: same posId, normals and tangent directions within normalAngle, identical tangent w and uv, colours within colorTolerance.
  const cosTol = Math.cos((opts.normalAngle * Math.PI) / 180);
  const remap = new Int32Array(vertexCount).fill(-1);
  const buckets = new Map<number, number[]>(); // posId -> output vertex ids
  const outPosition: number[] = [];
  const outNormal: number[] = [];
  const outTangent: number[] = [];
  const outUvs: number[][] = g.uvSets.map(() => []);
  const outColor: number[] = [];
  const emit = (i: number): number => {
    const id = outPosition.length / 3;
    outPosition.push(g.position[i * 3]!, g.position[i * 3 + 1]!, g.position[i * 3 + 2]!);
    outNormal.push(g.normal[i * 3]!, g.normal[i * 3 + 1]!, g.normal[i * 3 + 2]!);
    if (g.tangent) outTangent.push(g.tangent[i * 4]!, g.tangent[i * 4 + 1]!, g.tangent[i * 4 + 2]!, g.tangent[i * 4 + 3]!);
    for (let k = 0; k < g.uvs.length; k++) outUvs[k]!.push(g.uvs[k]![i * 2]!, g.uvs[k]![i * 2 + 1]!);
    if (g.color) outColor.push(g.color[i * 3]!, g.color[i * 3 + 1]!, g.color[i * 3 + 2]!);
    return id;
  };
  const matches = (i: number, out: number): boolean => {
    const dot = g.normal[i * 3]! * outNormal[out * 3]! + g.normal[i * 3 + 1]! * outNormal[out * 3 + 1]! + g.normal[i * 3 + 2]! * outNormal[out * 3 + 2]!;
    if (dot < cosTol) return false;
    if (g.tangent) {
      const o = i * 4;
      const p = out * 4;
      if (g.tangent[o + 3] !== outTangent[p + 3]) return false;
      const x = g.tangent[o]!, y = g.tangent[o + 1]!, z = g.tangent[o + 2]!;
      const ox = outTangent[p]!, oy = outTangent[p + 1]!, oz = outTangent[p + 2]!;
      // Exactly equal directions weld even when degenerate (a zero tangent).
      if (x * ox + y * oy + z * oz < cosTol && (x !== ox || y !== oy || z !== oz)) return false;
    }
    for (let k = 0; k < g.uvs.length; k++) {
      const set = g.uvs[k]!;
      const outSet = outUvs[k]!;
      if (Math.abs(set[i * 2]! - outSet[out * 2]!) > 1e-5 || Math.abs(set[i * 2 + 1]! - outSet[out * 2 + 1]!) > 1e-5) return false;
    }
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
  if (g.tangent) geometry.setAttribute('tangent', new BufferAttribute(new Float32Array(outTangent), 4));
  g.uvSets.forEach((name, k) => geometry.setAttribute(name, new BufferAttribute(new Float32Array(outUvs[k]!), 2)));
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
