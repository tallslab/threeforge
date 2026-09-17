import { Vector3 } from 'three';
import type { Gathered } from './gather.js';

/** Whether a triangle on ids `a`, `b`, `c` has two corners at the same id. */
export function isDegenerate(a: number, b: number, c: number): boolean {
  return a === b || b === c || a === c;
}

/** Parity of the permutation taking (a, b, c) to sorted order: +1 even (same winding as sorted), -1 odd. */
export function parity(a: number, b: number, c: number): 1 | -1 {
  let inversions = 0;
  if (a > b) inversions++;
  if (a > c) inversions++;
  if (b > c) inversions++;
  return inversions % 2 === 0 ? 1 : -1;
}

/** Sets `u` and `v` to unit vectors perpendicular to the unit normal `n` and to each other, with u x v = n. */
export function perpendicularBasis(n: Vector3, u: Vector3, v: Vector3): void {
  u.set(1, 0, 0);
  if (Math.abs(n.x) > 0.9) u.set(0, 1, 0);
  u.cross(n).normalize();
  v.crossVectors(n, u);
}

/** One key per unordered pair of ids below `idCount`. */
export function edgeKey(u: number, v: number, idCount: number): number {
  return u < v ? u * idCount + v : v * idCount + u;
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
 * The islands of `count` triangles joined by shared edges, where `corner(i, c)` is the id (below `idCount`) of corner
 * `c` of triangle `i`: each island lists its triangles in ascending order, and the islands come in the order of their
 * first triangle.
 */
export function islandsByEdge(count: number, corner: (i: number, c: number) => number, idCount: number): number[][] {
  const uf = new Islands(count);
  const byEdge = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const key = edgeKey(corner(i, c), corner(i, (c + 1) % 3), idCount);
      const other = byEdge.get(key);
      if (other === undefined) byEdge.set(key, i);
      else uf.union(i, other);
    }
  }
  const islands: number[][] = [];
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = uf.find(i);
    const island = byRoot.get(root);
    if (island) island.push(i);
    else {
      const started = [i];
      byRoot.set(root, started);
      islands.push(started);
    }
  }
  return islands;
}

/**
 * Whether entry `k` is a closed, manifold, outward shell in every connected component (degenerate triangles skipped):
 * every edge, by position identity, is used exactly once in each direction, so each edge joins exactly two
 * consistently wound triangles (an edge shared by two parts of the entry, used four times, fails), and every component
 * (triangles joined by shared edges) encloses a positive signed volume beyond a flat slab's (`volume > area *
 * tolerance`). Positions and winding are the gathered ones, already reversed for a mirrored matrix, so a shell outward
 * in its own space stays outward. Per component, not per entry: an inside-out part next to a larger outward one would
 * pass a total.
 */
export function closedOutwardShell(
  g: Gathered,
  posIds: Uint32Array,
  posCount: number,
  k: number,
  tolerance: number,
): boolean {
  const start = g.entryTriangles[k]!;
  const end = g.entryTriangles[k + 1]!;
  /** Position id of corner `c` (0, 1 or 2) of triangle `t`. */
  const corner = (t: number, c: number): number => posIds[g.index[t * 3 + c]!]!;
  const triangles: number[] = [];
  // Per edge: bit 1 once it is used from its lower position id to its higher, bit 2 once it is used the other way.
  const uses = new Map<number, number>();
  const use = (u: number, v: number): boolean => {
    const key = edgeKey(u, v, posCount);
    const bit = u < v ? 1 : 2;
    const seen = uses.get(key) ?? 0;
    if ((seen & bit) !== 0) return false; // a second use in the same direction: non-manifold or inconsistently wound
    uses.set(key, seen | bit);
    return true;
  };
  for (let t = start; t < end; t++) {
    const a = corner(t, 0);
    const b = corner(t, 1);
    const c = corner(t, 2);
    if (isDegenerate(a, b, c)) continue;
    triangles.push(t);
    if (!use(a, b) || !use(b, c) || !use(c, a)) return false;
  }
  if (triangles.length === 0) return false;
  for (const bits of uses.values()) if (bits !== 3) return false; // used in one direction only: an open edge
  const components = islandsByEdge(triangles.length, (i, c) => corner(triangles[i]!, c), posCount);
  // Signed volume and area per component, relative to one of the entry's points (a closed surface's volume does not
  // depend on the origin; a near one keeps the products small).
  const p = g.position;
  const origin = g.index[triangles[0]! * 3]! * 3;
  const ox = p[origin]!;
  const oy = p[origin + 1]!;
  const oz = p[origin + 2]!;
  for (const component of components) {
    let volume = 0;
    let area = 0;
    for (const i of component) {
      const t = triangles[i]!;
      const ia = g.index[t * 3]! * 3;
      const ib = g.index[t * 3 + 1]! * 3;
      const ic = g.index[t * 3 + 2]! * 3;
      const ax = p[ia]! - ox,
        ay = p[ia + 1]! - oy,
        az = p[ia + 2]! - oz;
      const bx = p[ib]! - ox,
        by = p[ib + 1]! - oy,
        bz = p[ib + 2]! - oz;
      const cx = p[ic]! - ox,
        cy = p[ic + 1]! - oy,
        cz = p[ic + 2]! - oz;
      const ux = bx - ax,
        uy = by - ay,
        uz = bz - az;
      const wx = cx - ax,
        wy = cy - ay,
        wz = cz - az;
      const nx = uy * wz - uz * wy,
        ny = uz * wx - ux * wz,
        nz = ux * wy - uy * wx;
      volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
      area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    }
    if (!(volume > area * tolerance)) return false;
  }
  return true;
}

/**
 * Whether no two triangles of a coplanar island overlap by more than `tolerance` in their plane, so the island covers
 * each point of its region at most once. Triangles are projected onto the plane of the first one, swept along one axis
 * and compared by separating axes (their six edge normals): a shared edge or vertex separates with zero overlap.
 */
export function coversOnce(g: Gathered, tris: number[], tolerance: number): boolean {
  const count = tris.length;
  if (count < 2) return true;
  const p = g.position;
  const first = tris[0]! * 3;
  const origin = new Vector3().fromArray(p, g.index[first]! * 3);
  const normal = new Vector3()
    .fromArray(p, g.index[first + 1]! * 3)
    .sub(origin)
    .cross(new Vector3().fromArray(p, g.index[first + 2]! * 3).sub(origin))
    .normalize();
  const u = new Vector3();
  const v = new Vector3();
  perpendicularBasis(normal, u, v);
  const xy = new Float64Array(count * 6);
  const minX = new Float64Array(count).fill(Infinity);
  const maxX = new Float64Array(count).fill(-Infinity);
  const minY = new Float64Array(count).fill(Infinity);
  const maxY = new Float64Array(count).fill(-Infinity);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const o = g.index[tris[i]! * 3 + c]! * 3;
      const x = p[o]! * u.x + p[o + 1]! * u.y + p[o + 2]! * u.z;
      const y = p[o]! * v.x + p[o + 1]! * v.y + p[o + 2]! * v.z;
      xy[i * 6 + c * 2] = x;
      xy[i * 6 + c * 2 + 1] = y;
      minX[i] = Math.min(minX[i]!, x);
      maxX[i] = Math.max(maxX[i]!, x);
      minY[i] = Math.min(minY[i]!, y);
      maxY[i] = Math.max(maxY[i]!, y);
    }
  }
  const order = Array.from({ length: count }, (_, i) => i).sort((i, j) => minX[i]! - minX[j]!);
  const active: number[] = [];
  for (const i of order) {
    for (let k = active.length - 1; k >= 0; k--) {
      if (maxX[active[k]!]! <= minX[i]! + tolerance) {
        active[k] = active[active.length - 1]!;
        active.pop();
      }
    }
    for (const j of active) {
      if (maxY[j]! <= minY[i]! + tolerance || maxY[i]! <= minY[j]! + tolerance) continue;
      if (trianglesOverlap(xy, i, j, tolerance)) return false;
    }
    active.push(i);
  }
  return true;
}

/** Whether projected triangles `i` and `j` overlap by more than `tolerance` along each of their six edge normals. */
export function trianglesOverlap(xy: Float64Array, i: number, j: number, tolerance: number): boolean {
  for (const [s, o] of [
    [i, j],
    [j, i],
  ] as const) {
    for (let e = 0; e < 3; e++) {
      const x0 = xy[s * 6 + e * 2]!;
      const y0 = xy[s * 6 + e * 2 + 1]!;
      const x1 = xy[s * 6 + ((e + 1) % 3) * 2]!;
      const y1 = xy[s * 6 + ((e + 1) % 3) * 2 + 1]!;
      const length = Math.hypot(x1 - x0, y1 - y0);
      if (length === 0) continue;
      const ax = (y1 - y0) / length;
      const ay = (x0 - x1) / length;
      let minS = Infinity;
      let maxS = -Infinity;
      let minO = Infinity;
      let maxO = -Infinity;
      for (let c = 0; c < 3; c++) {
        const ps = xy[s * 6 + c * 2]! * ax + xy[s * 6 + c * 2 + 1]! * ay;
        const po = xy[o * 6 + c * 2]! * ax + xy[o * 6 + c * 2 + 1]! * ay;
        minS = Math.min(minS, ps);
        maxS = Math.max(maxS, ps);
        minO = Math.min(minO, po);
        maxO = Math.max(maxO, po);
      }
      if (Math.min(maxS, maxO) - Math.max(minS, minO) <= tolerance) return false;
    }
  }
  return true;
}
