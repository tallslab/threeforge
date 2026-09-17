import { Box3, BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { type Gathered, triangleLocked } from './gather.js';
import {
  coversOnce,
  edgeKey,
  isDegenerate,
  islandsByEdge,
  parity,
  perpendicularBasis,
  trianglesOverlap,
} from './topology.js';

/**
 * Exact duplicates (same points, same winding: a module placed twice) never reach the island pass, where their shared
 * edges would fuse the copies into one island. three draws the later of two copies at equal depth (opaque items sort by
 * object id after depth, and a mesh draws its index in order), so a copy may go only when nothing drawn at that depth
 * could show in its place differently:
 * - every copy of the winding is unlocked, in an entry that may lose faces, and draws the same as the first
 *   (`sameTriangle`), else every copy stays and is counted;
 * - no other triangle lies in the copies' plane over their region (`drawnOver`): a copy of another triangulation, an
 *   excluded entry's triangle, a double- or back-side one. A removable triangle of the other winding is culled wherever
 *   these are drawn, so it does not count.
 * Triangles already marked in `removedTriangle` (degenerate ones) take no part. Marks the removed copies and returns
 * their count, with the unlocked copies kept for either reason.
 */
export function removeExactDuplicates(
  g: Gathered,
  placeIds: Uint32Array,
  posIds: Uint32Array,
  removedTriangle: Uint8Array,
  tolerance: number,
  removable: (entry: number) => boolean,
  sameVertex: (i: number, j: number) => boolean,
): { removed: number; kept: number[] } {
  // Whether triangles `s` and `t` on the same places draw the same: each corner of `s` against the corner of `t` at its place.
  const sameTriangle = (s: number, t: number): boolean => {
    for (let c = 0; c < 3; c++) {
      const i = g.index[s * 3 + c]!;
      let j = -1;
      for (let d = 0; d < 3; d++) if (placeIds[g.index[t * 3 + d]!] === placeIds[i]) j = g.index[t * 3 + d]!;
      if (j < 0 || !sameVertex(i, j)) return false;
    }
    return true;
  };
  // Triangles on the same three places, in index order, whatever their winding or entry (locked ones included).
  const copies = new Map<string, number[]>();
  for (let t = 0; t < g.triangleEntry.length; t++) {
    if (removedTriangle[t]) continue;
    const pa = placeIds[g.index[t * 3]!]!;
    const pb = placeIds[g.index[t * 3 + 1]!]!;
    const pc = placeIds[g.index[t * 3 + 2]!]!;
    // A locked triangle collapsed onto fewer places draws a sliver no copy can hide or reveal.
    if (isDegenerate(pa, pb, pc)) continue;
    const sorted = [pa, pb, pc].sort((x, y) => x - y);
    const key = `${sorted[0]},${sorted[1]},${sorted[2]}`;
    const list = copies.get(key);
    if (list) list.push(t);
    else copies.set(key, [t]);
  }
  const kept: number[] = [];
  const sets: number[][] = [];
  for (const list of copies.values()) {
    if (list.length < 2) continue;
    for (const winding of [1, -1] as const) {
      // Winding by place: a locked triangle's posIds are its own and say nothing about its winding against the others.
      const same = list.filter(
        (t) =>
          parity(placeIds[g.index[t * 3]!]!, placeIds[g.index[t * 3 + 1]!]!, placeIds[g.index[t * 3 + 2]!]!) ===
          winding,
      );
      if (same.length < 2) continue;
      if (same.every((t) => !triangleLocked(g, t) && removable(g.triangleEntry[t]!) && sameTriangle(same[0]!, t)))
        sets.push(same);
      else for (const t of same) if (!triangleLocked(g, t)) kept.push(t);
    }
  }
  let removed = 0;
  if (sets.length > 0) {
    const drawnOver = overlapTest(
      g,
      posIds,
      tolerance,
      (vertex) => g.locked[vertex] === 0 && removable(g.vertexEntry[vertex]!),
    );
    for (const same of sets) {
      if (drawnOver(same)) {
        kept.push(...same);
        continue;
      }
      for (let k = 1; k < same.length; k++) {
        removedTriangle[same[k]!] = 1;
        removed++;
      }
    }
    drawnOver.dispose();
  }
  return { removed, kept };
}

/**
 * Coplanar contact: triangles are grouped by plane, split into the two facing sides, and each side is merged into
 * islands along shared edges. An island's outline (its edges used exactly once, sorted) bounds its region only when no
 * edge is used three or more times and some edge is used once, and two islands with equal outlines cover the same
 * region only when neither overlaps itself (`coversOnce`); an island failing either is left alone. Equal outlines on
 * the same side are duplicates (one stays, among `removable` entries only); equal outlines on opposite sides are a
 * seam, and both go only when the islands' entries are disjoint, `seamSafe` holds for every entry involved and both
 * cover once, else both are `kept`. With `seamSafe` null no pair is judged. Partial overlaps are left alone.
 */
export function coincidentIslands(
  g: Gathered,
  posIds: Uint32Array,
  posCount: number,
  candidates: number[],
  tolerance: number,
  seamSafe: ((entry: number) => boolean) | null,
  removable: (entry: number) => boolean,
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
  const corner = (t: number, k: number): number => posIds[g.index[t * 3 + k]!]!;
  const islandsOf = (tris: number[]): Map<string, number[]> => {
    const islands = islandsByEdge(tris.length, (i, k) => corner(tris[i]!, k), posCount);
    // Boundary signature: edges used exactly once inside the island, sorted.
    const out = new Map<string, number[]>();
    for (const local of islands) {
      const island = local.map((i) => tris[i]!);
      const counts = new Map<number, number>();
      let overused = false;
      for (const t of island) {
        for (let k = 0; k < 3; k++) {
          const key = edgeKey(corner(t, k), corner(t, (k + 1) % 3), posCount);
          const used = (counts.get(key) ?? 0) + 1;
          counts.set(key, used);
          if (used > 2) overused = true;
        }
      }
      // An edge used three or more times drops out of the once-used outline, which then no longer bounds the region
      // (it could match a region of a different size). Leave such an island alone.
      if (overused) continue;
      const boundary = [...counts.entries()]
        .filter(([, c]) => c === 1)
        .map(([k]) => k)
        .sort((x, y) => x - y)
        .join(';');
      // No outline: every such region shares the empty key, so it can be matched against nothing. Leave it alone.
      if (boundary.length === 0) continue;
      const existing = out.get(boundary);
      if (existing) {
        // Same side, same outline: keep the first island only, and only when every entry involved may lose faces.
        const removableIsland = (tris: number[]): boolean => tris.every((t) => removable(g.triangleEntry[t]!));
        if (removableIsland(existing) && removableIsland(island)) duplicates.push(...island);
      } else out.set(boundary, island);
    }
    return out;
  };
  // The entry conditions of a seam: the two islands' entries are disjoint, and every entry is safe (see `seamSafe`).
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
      if (!facing) continue;
      const seam =
        isSeam(island, facing, seamSafe) && coversOnce(g, island, tolerance) && coversOnce(g, facing, tolerance);
      (seam ? seams : kept).push(...island, ...facing);
    }
  }
  return { seams, duplicates, kept };
}

/**
 * A test over every triangle of the gathered geometry (locked and degenerate ones included): whether any triangle other
 * than `copies` (triangles on the same points) lies within a small distance of their plane and overlaps their region
 * there by more than `tolerance`. A triangle facing the other way is skipped when `culledOpposite` holds for its first
 * vertex: a front-side face turned away is not drawn where the copies are. Index order is kept per triangle, so a
 * triangle of the tree is matched to a copy by its three vertex indices.
 */
export function overlapTest(
  g: Gathered,
  posIds: Uint32Array,
  tolerance: number,
  culledOpposite: (vertex: number) => boolean,
): ((copies: number[]) => boolean) & { dispose(): void } {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(g.position, 3));
  // MeshBVH reorders the index it is given, whole triangles at a time: give it a copy, and read vertex indices from it.
  geometry.setIndex(new BufferAttribute(new Uint32Array(g.index), 1));
  const bvh = new MeshBVH(geometry);
  const index = geometry.index!.array as Uint32Array;
  const planeDistance = Math.max(tolerance * 10, 1e-5);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();
  const e1 = new Vector3();
  const e2 = new Vector3();
  const u = new Vector3();
  const v = new Vector3();
  const box = new Box3();
  const xy = new Float64Array(12);
  const project = (slot: number, p: Vector3, q: Vector3, r: Vector3): void => {
    xy[slot * 6] = p.dot(u);
    xy[slot * 6 + 1] = p.dot(v);
    xy[slot * 6 + 2] = q.dot(u);
    xy[slot * 6 + 3] = q.dot(v);
    xy[slot * 6 + 4] = r.dot(u);
    xy[slot * 6 + 5] = r.dot(v);
  };
  const offPlane = (p: Vector3): boolean => Math.abs(e1.copy(p).sub(a).dot(n)) > planeDistance;
  const test = (copies: number[]): boolean => {
    const t = copies[0]!;
    a.fromArray(g.position, g.index[t * 3]! * 3);
    b.fromArray(g.position, g.index[t * 3 + 1]! * 3);
    c.fromArray(g.position, g.index[t * 3 + 2]! * 3);
    n.copy(b).sub(a).cross(e1.copy(c).sub(a));
    if (n.lengthSq() < 1e-20) return true;
    n.normalize();
    perpendicularBasis(n, u, v);
    const isCopy = (i0: number, i1: number, i2: number): boolean => {
      for (const copy of copies)
        if (g.index[copy * 3] === i0 && g.index[copy * 3 + 1] === i1 && g.index[copy * 3 + 2] === i2) return true;
      return false;
    };
    box.makeEmpty().expandByPoint(a).expandByPoint(b).expandByPoint(c).expandByScalar(planeDistance);
    project(0, a, b, c);
    let found = false;
    bvh.shapecast({
      intersectsBounds: (bounds) => bounds.intersectsBox(box),
      intersectsTriangle: (triangle, i) => {
        const i0 = index[i * 3]!;
        const i1 = index[i * 3 + 1]!;
        const i2 = index[i * 3 + 2]!;
        if (isCopy(i0, i1, i2)) return false;
        if (isDegenerate(posIds[i0]!, posIds[i1]!, posIds[i2]!)) return false;
        if (offPlane(triangle.a) || offPlane(triangle.b) || offPlane(triangle.c)) return false;
        const facing = e1.copy(triangle.b).sub(triangle.a).cross(e2.copy(triangle.c).sub(triangle.a)).dot(n);
        if (facing < 0 && culledOpposite(i0)) return false;
        project(1, triangle.a, triangle.b, triangle.c);
        if (!trianglesOverlap(xy, 0, 1, tolerance)) return false;
        found = true;
        return true;
      },
    });
    return found;
  };
  return Object.assign(test, { dispose: () => geometry.dispose() });
}
