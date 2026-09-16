/**
 * Geometry bake for finished groups: merge into one geometry, drop contact seams between touching solid modules, drop
 * duplicated faces, optionally drop truly buried faces, then weld vertices whose position, normal, tangent, uv and
 * colour agree. A wrong deletion is visible and a missed one is invisible, so every rule is conservative (a coincident
 * pair that is not provably a seam between two solids stays, and is counted) and every removal is counted and
 * returned as geometry (`removed`) that an agent can render to check.
 */
import { BackSide, Box3, BufferAttribute, BufferGeometry, Color, DoubleSide, FrontSide, Matrix3, Matrix4, Ray, Vector3, type Side } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export interface BakeEntry {
  geometry: BufferGeometry;
  /** Matrix of the module in the baked space (the scene's space under `World`, else usually its world matrix). */
  matrix: Matrix4;
  /** Per-module tint (an instance colour); white or absent means none. */
  color?: Color | null;
  /** `false` keeps this module's triangles exactly as they are: no removal, no welding. */
  bake?: boolean;
  /** `true`: the material draws both faces, which counts as not front-side whatever `side` says. Superseded by `side`. */
  doubleSided?: boolean;
  /**
   * The material's `side` (`bakeEntriesOf` copies it). Only `FrontSide` modules lose seam or buried faces: a `BackSide`
   * material draws exactly the faces those rules assume hidden, and a `DoubleSide` one draws both. Back-side faces also
   * block no buried-face ray. Absent counts as not front-side: that entry loses no faces.
   */
  side?: Side;
  /**
   * The module casts shadows (`bakeEntriesOf` copies the original's `castShadow`). Only modules with `castShadow: false`
   * lose seam, buried or duplicate faces: non-VSM shadow maps draw a front-side material's back faces, so a seam face is
   * a shadow caster for the neighbouring module. Absent counts as casting: that entry loses no faces.
   */
  castShadow?: boolean;
  /**
   * The material hides whatever lies behind its faces and draws them where the geometry puts them, judged by an
   * allowlist of three's default material hooks (`bakeEntriesOf` decides it: no blending, discard, transmission, node
   * in any slot, custom `onBeforeCompile`, `customProgramCacheKey` or `defines`, displacement, material clipping planes,
   * polygon offset, wireframe, stencil test, or depth test other than less-or-equal). Only opaque modules lose seam,
   * buried or duplicate faces, and only their faces block buried-face rays. Absent counts as NOT opaque: that entry
   * loses no faces (a missed deletion is invisible, a wrong one is visible).
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
   * Remove seams between touching solids (default true): a coincident, opposite-winding pair goes only when both sides
   * cover their region exactly once and come from different entries that are all closed, manifold, outward,
   * front-side, opaque and cast no shadow. Every other coincident, opposite pair stays and is counted in
   * `keptCoincidentFaces`.
   */
  removeContactFaces?: boolean;
  /**
   * Keep one of several exactly coincident, same-winding triangles of opaque, front-side, non-casting entries (default
   * true), only when every copy draws the same pixels: each corner's normal, tangent, uvs and colour (tint included)
   * agree within the weld tolerances, and no other triangle on the same points is excluded (`bake: false`), not
   * removable, or a copy that differs. three draws the later of two copies at equal depth, so removing a copy that
   * differs changes what is drawn. Every other set of copies stays and is counted in `keptDuplicateFaces`.
   */
  removeDuplicateFaces?: boolean;
  /** Remove faces of opaque, front-side, non-casting entries that cannot be seen because opaque geometry sits right in front of them (default false). */
  removeBuried?: boolean | BuriedOptions;
}

export interface BakeReport {
  inputVertices: number;
  inputTriangles: number;
  vertices: number;
  triangles: number;
  weldedVertices: number;
  contactFaces: number;
  /**
   * Faces of coincident, opposite-winding pairs the seam rule kept because a condition failed, and that no later rule
   * removed (a kept face later removed as buried is counted there only). 0 while `removeContactFaces` is off.
   */
  keptCoincidentFaces: number;
  duplicateFaces: number;
  /**
   * Faces of exactly coincident, same-winding copies the duplicate rule kept, for any of its reasons (see
   * `removeDuplicateFaces`): a copy in an excluded entry (`bake: false`) or in one that may lose no faces (not opaque,
   * not front-side, or casting shadows), a copy that draws differently from the first, or another triangle drawn over
   * the copies. Only copies outside excluded entries count, and only those no later rule removed. 0 while
   * `removeDuplicateFaces` is off.
   */
  keptDuplicateFaces: number;
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

/** Item sizes of the attributes `gather` carries into the baked geometry (colour: see `unbakeableAttribute`). */
const CARRIED: Record<string, readonly number[]> = { position: [3], normal: [3], tangent: [3, 4], uv: [2], uv1: [2], uv2: [2], uv3: [2], color: [3] };

/**
 * The first attribute of `geometry` the bake does not carry faithfully, or null: one outside `position`, `normal`,
 * `tangent` (three or four components), `uv` to `uv3` (two) and `color` (three), or one of those with another item
 * size. The bake writes colour as three components, so a four-component colour (glTF's RGBA `COLOR_0`) loses its alpha,
 * which three multiplies into the diffuse colour (NodeMaterial.setupDiffuseColor reads `vertexColor()` as a vec4). Any
 * other attribute (a custom one a node material reads with `attribute()`, feature ids) is dropped.
 *
 * `vertexColors` is the material's flag (default true). With it false the bake drops `color` altogether, which is
 * faithful only when nothing reads it: `builtInReads` says three's own code is all that reads the geometry (a built-in
 * material class with no instance function and no node in any slot; `readsOnlyBuiltInAttributes` in batchStatics.ts),
 * and then the flag decides (setupDiffuseColor, NodeMaterial.js:839, is three r186's only reader). Otherwise a
 * `colorNode = vertexColor()`, an `attribute('color')` or an overridden method may read it, so `color` counts, of any
 * size. Default false: an allowlist, since a colour dropped under a reader is visible and a group left to batching is not.
 */
export function unbakeableAttribute(geometry: BufferGeometry, vertexColors = true, builtInReads = false): string | null {
  for (const name of Object.keys(geometry.attributes)) {
    const size = geometry.attributes[name]!.itemSize;
    if (name === 'color' && !vertexColors) {
      if (builtInReads) continue;
      return name;
    }
    if (!CARRIED[name]?.includes(size)) return name;
  }
  return null;
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
 * Whether entry `k` is a closed, manifold, outward shell in every connected component (degenerate triangles skipped):
 * every edge, by position identity, is used exactly once in each direction, so each edge joins exactly two
 * consistently wound triangles (an edge shared by two parts of the entry, used four times, fails), and every component
 * (triangles joined by shared edges) encloses a positive signed volume beyond a flat slab's (`volume > area *
 * tolerance`). Positions and winding are the gathered ones, already reversed for a mirrored matrix, so a shell outward
 * in its own space stays outward. Per component, not per entry: an inside-out part next to a larger outward one would
 * pass a total.
 */
function closedOutwardShell(g: Gathered, posIds: Uint32Array, posCount: number, k: number, tolerance: number): boolean {
  const start = g.entryTriangles[k]!;
  const end = g.entryTriangles[k + 1]!;
  const edgeKey = (u: number, v: number): number => (u < v ? u * posCount + v : v * posCount + u);
  /** Position id of corner `c` (0, 1 or 2) of triangle `t`. */
  const corner = (t: number, c: number): number => posIds[g.index[t * 3 + c]!]!;
  const triangles: number[] = [];
  // Per edge: bit 1 once it is used from its lower position id to its higher, bit 2 once it is used the other way.
  const uses = new Map<number, number>();
  const use = (u: number, v: number): boolean => {
    const key = edgeKey(u, v);
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
    if (a === b || b === c || a === c) continue;
    triangles.push(t);
    if (!use(a, b) || !use(b, c) || !use(c, a)) return false;
  }
  if (triangles.length === 0) return false;
  for (const bits of uses.values()) if (bits !== 3) return false; // used in one direction only: an open edge
  const components = new Islands(triangles.length);
  const byEdge = new Map<number, number>();
  const join = (i: number, u: number, v: number): void => {
    const key = edgeKey(u, v);
    const other = byEdge.get(key);
    if (other === undefined) byEdge.set(key, i);
    else components.union(i, other);
  };
  triangles.forEach((t, i) => {
    const a = corner(t, 0);
    const b = corner(t, 1);
    const c = corner(t, 2);
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
 * Whether no two triangles of a coplanar island overlap by more than `tolerance` in their plane, so the island covers
 * each point of its region at most once. Triangles are projected onto the plane of the first one, swept along one axis
 * and compared by separating axes (their six edge normals): a shared edge or vertex separates with zero overlap.
 */
function coversOnce(g: Gathered, tris: number[], tolerance: number): boolean {
  const count = tris.length;
  if (count < 2) return true;
  const p = g.position;
  const first = tris[0]! * 3;
  const origin = new Vector3().fromArray(p, g.index[first]! * 3);
  const normal = new Vector3().fromArray(p, g.index[first + 1]! * 3).sub(origin).cross(new Vector3().fromArray(p, g.index[first + 2]! * 3).sub(origin)).normalize();
  const u = new Vector3(1, 0, 0);
  if (Math.abs(normal.x) > 0.9) u.set(0, 1, 0);
  u.cross(normal).normalize();
  const v = new Vector3().crossVectors(normal, u);
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
function trianglesOverlap(xy: Float64Array, i: number, j: number, tolerance: number): boolean {
  for (const [s, o] of [[i, j], [j, i]] as const) {
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

/**
 * Coplanar contact: triangles are grouped by plane, split into the two facing sides, and each side is merged into
 * islands (polygons) along shared edges. An island is paired only when it covers its region exactly once, so that its
 * outline (the edges used once, sorted) bounds exactly that region:
 * - an island with an edge used three or more times is skipped: that edge drops out of the outline, so a doubled box
 *   beside a longer one could share an outline with the longer one's top;
 * - an island without outline edges is skipped: a region covered twice with different triangulations fuses into one
 *   island whose every edge is used twice, and its empty outline would match any other such region's;
 * - a pair whose islands have overlapping triangles (`coversOnce`) is kept: overlapping triangles can share every edge
 *   at most twice and still double an area behind a matching outline.
 * With every edge used at most twice the once-used edges are the region's boundary, and without overlaps two islands
 * with the same boundary cover the same region, whatever their triangulations. Equal non-empty outlines on the same
 * side would be duplicates (one stays, only among `removable` entries), but islands sharing outline edges fuse into one,
 * so that check only guards the invariant; exact duplicates are removed before this pass. An island whose outline
 * equals an island's on the other side is a coincident, opposite pair. It is a seam (both go) only when the two
 * islands' entries are disjoint, `seamSafe` holds for every entry involved (closed, manifold, outward, front-side,
 * opaque, casting no shadow) and both islands cover their region once; otherwise both are `kept`. With `seamSafe` null
 * (contact removal off) no pair is judged. Partial overlaps are left alone (invisible cost, never a visible hole).
 */
function coincidentIslands(
  g: Gathered,
  posIds: Uint32Array,
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
      let overused = false;
      for (const t of island) {
        const ids = [posIds[g.index[t * 3]!]!, posIds[g.index[t * 3 + 1]!]!, posIds[g.index[t * 3 + 2]!]!];
        for (let k = 0; k < 3; k++) {
          const key = edgeKey(ids[k]!, ids[(k + 1) % 3]!);
          const used = (counts.get(key) ?? 0) + 1;
          counts.set(key, used);
          if (used > 2) overused = true;
        }
      }
      // An edge used three or more times drops out of the once-used outline, which then no longer bounds the region
      // (it could match a region of a different size). Leave such an island alone.
      if (overused) continue;
      const boundary = [...counts.entries()].filter(([, c]) => c === 1).map(([k]) => k).sort().join(';');
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
      const seam = isSeam(island, facing, seamSafe) && coversOnce(g, island, tolerance) && coversOnce(g, facing, tolerance);
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
function overlapTest(g: Gathered, posIds: Uint32Array, tolerance: number, culledOpposite: (vertex: number) => boolean): ((copies: number[]) => boolean) & { dispose(): void } {
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
    u.set(1, 0, 0);
    if (Math.abs(n.x) > 0.9) u.set(0, 1, 0);
    u.cross(n).normalize();
    v.crossVectors(n, u);
    const isCopy = (i0: number, i1: number, i2: number): boolean => {
      for (const copy of copies) if (g.index[copy * 3] === i0 && g.index[copy * 3 + 1] === i1 && g.index[copy * 3 + 2] === i2) return true;
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
        if (posIds[i0] === posIds[i1] || posIds[i1] === posIds[i2] || posIds[i0] === posIds[i2]) return false;
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
    keptDuplicateFaces: 0,
    buriedFaces: 0,
    degenerateFaces: 0,
    excludedEntries: entries.filter((e) => e.bake === false).length,
  };
  // Entries whose faces a rule may remove (opaque, front-side and casting no shadow: a shadow map draws a front-side
  // material's back faces), and entries whose faces block buried-face rays (opaque and front- or double-sided: a
  // back-side shell draws its far wall behind whatever is inside it).
  const removable = (k: number): boolean => {
    const e = entries[k]!;
    return e.opaque === true && e.side === FrontSide && e.doubleSided !== true && e.castShadow === false;
  };
  const occludes = (k: number): boolean => {
    const e = entries[k]!;
    return e.opaque === true && (e.side === FrontSide || e.side === DoubleSide);
  };
  let kept: number[] = [];
  let keptDuplicates: number[] = [];

  // 1. Position identity: vertices within `tolerance` share a place (`placeIds`, locked vertices included) and a posId
  // (locked vertices keep their own, so no rule joins or removes their triangles).
  const inv = 1 / opts.tolerance;
  const placeIds = new Uint32Array(vertexCount);
  const posMap = new Map<string, number>();
  let nextPos = 0;
  for (let i = 0; i < vertexCount; i++) {
    const key = `${Math.round(g.position[i * 3]! * inv)},${Math.round(g.position[i * 3 + 1]! * inv)},${Math.round(g.position[i * 3 + 2]! * inv)}`;
    let id = posMap.get(key);
    if (id === undefined) posMap.set(key, (id = nextPos++));
    placeIds[i] = id;
  }
  const posIds = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) posIds[i] = g.locked[i] ? nextPos++ : placeIds[i]!;

  // Whether gathered vertices `i` and `j` draw the same: normal and tangent direction within `normalAngle`, identical
  // tangent w and uv (1e-5), colour within `colorTolerance` (the weld's own rule, `matches` below).
  const cosTol = Math.cos((opts.normalAngle * Math.PI) / 180);
  const sameVertex = (i: number, j: number): boolean => {
    if (g.normal[i * 3]! * g.normal[j * 3]! + g.normal[i * 3 + 1]! * g.normal[j * 3 + 1]! + g.normal[i * 3 + 2]! * g.normal[j * 3 + 2]! < cosTol) return false;
    if (g.tangent) {
      const x = g.tangent[i * 4]!, y = g.tangent[i * 4 + 1]!, z = g.tangent[i * 4 + 2]!;
      const ox = g.tangent[j * 4]!, oy = g.tangent[j * 4 + 1]!, oz = g.tangent[j * 4 + 2]!;
      if (g.tangent[i * 4 + 3] !== g.tangent[j * 4 + 3]) return false;
      if (x * ox + y * oy + z * oz < cosTol && (x !== ox || y !== oy || z !== oz)) return false;
    }
    for (const set of g.uvs) if (Math.abs(set[i * 2]! - set[j * 2]!) > 1e-5 || Math.abs(set[i * 2 + 1]! - set[j * 2 + 1]!) > 1e-5) return false;
    if (g.color) for (let k = 0; k < 3; k++) if (Math.abs(g.color[i * 3 + k]! - g.color[j * 3 + k]!) > opts.colorTolerance) return false;
    return true;
  };
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

  // 2. Contact seams and duplicates on coplanar islands (see coincidentIslands).
  const removedTriangle = new Uint8Array(triangleCount);
  const triangleLocked = (t: number): boolean => g.locked[g.index[t * 3]!] === 1;
  // Triangles on the same three places, in index order, whatever their winding or entry (locked ones included).
  const copies = new Map<string, number[]>();
  for (let t = 0; t < triangleCount; t++) {
    const a = posIds[g.index[t * 3]!]!;
    const b = posIds[g.index[t * 3 + 1]!]!;
    const c = posIds[g.index[t * 3 + 2]!]!;
    if (a === b || b === c || a === c) {
      removedTriangle[t] = 1;
      report.degenerateFaces++;
      continue;
    }
    if (!opts.removeDuplicateFaces) continue;
    const pa = placeIds[g.index[t * 3]!]!;
    const pb = placeIds[g.index[t * 3 + 1]!]!;
    const pc = placeIds[g.index[t * 3 + 2]!]!;
    // A locked triangle collapsed onto fewer places draws a sliver no copy can hide or reveal.
    if (pa === pb || pb === pc || pa === pc) continue;
    const sorted = [pa, pb, pc].sort((x, y) => x - y);
    const key = `${sorted[0]},${sorted[1]},${sorted[2]}`;
    const list = copies.get(key);
    if (list) list.push(t);
    else copies.set(key, [t]);
  }
  // Exact duplicates (same points, same winding: a module placed twice) never reach the island pass, where their
  // shared edges would fuse the copies into one island. three draws the later of two copies at equal depth (opaque
  // items sort by object id after depth, and a mesh draws its index in order), so a copy may go only when nothing drawn
  // at that depth could show in its place differently:
  // - every copy of the winding is unlocked, in an entry that may lose faces, and draws the same as the first
  //   (`sameTriangle`), else every copy stays and is counted;
  // - no other triangle lies in the copies' plane over their region (`drawnOver`): a copy of another triangulation, an
  //   excluded entry's triangle, a double- or back-side one. A removable triangle of the other winding is culled wherever
  //   these are drawn, so it does not count.
  const sets: number[][] = [];
  for (const list of copies.values()) {
    if (list.length < 2) continue;
    for (const winding of [1, -1] as const) {
      // Winding by place: a locked triangle's posIds are its own and say nothing about its winding against the others.
      const same = list.filter((t) => parity(placeIds[g.index[t * 3]!]!, placeIds[g.index[t * 3 + 1]!]!, placeIds[g.index[t * 3 + 2]!]!) === winding);
      if (same.length < 2) continue;
      if (same.every((t) => !triangleLocked(t) && removable(g.triangleEntry[t]!) && sameTriangle(same[0]!, t))) sets.push(same);
      else for (const t of same) if (!triangleLocked(t)) keptDuplicates.push(t);
    }
  }
  if (sets.length > 0) {
    const drawnOver = overlapTest(g, posIds, opts.tolerance, (vertex) => g.locked[vertex] === 0 && removable(g.vertexEntry[vertex]!));
    for (const same of sets) {
      if (drawnOver(same)) {
        keptDuplicates.push(...same);
        continue;
      }
      for (let k = 1; k < same.length; k++) {
        removedTriangle[same[k]!] = 1;
        report.duplicateFaces++;
      }
    }
    drawnOver.dispose();
  }
  const candidates: number[] = [];
  for (let t = 0; t < triangleCount; t++) if (!removedTriangle[t] && !triangleLocked(t)) candidates.push(t);
  if (opts.removeContactFaces || opts.removeDuplicateFaces) {
    // An entry may lose seam faces only when it is opaque, front-side and a closed, manifold, outward shell (computed once).
    const shells = new Int8Array(entries.length); // 0 not yet computed, 1 closed and outward, -1 not
    const seamSafe = (k: number): boolean => {
      if (!removable(k)) return false;
      if (shells[k] === 0) shells[k] = closedOutwardShell(g, posIds, nextPos, k, opts.tolerance) ? 1 : -1;
      return shells[k] === 1;
    };
    const found = coincidentIslands(g, posIds, candidates, opts.tolerance, opts.removeContactFaces ? seamSafe : null, removable);
    kept = found.kept;
    if (opts.removeContactFaces) {
      for (const t of found.seams) {
        if (!removedTriangle[t]) {
          removedTriangle[t] = 1;
          report.contactFaces++;
        }
      }
    }
    if (opts.removeDuplicateFaces) {
      for (const t of found.duplicates) {
        if (!removedTriangle[t]) {
          removedTriangle[t] = 1;
          report.duplicateFaces++;
        }
      }
    }
  }

  // 3. Buried faces (opt-in): every ray from the face's front, over the hemisphere, hits opaque geometry within
  // `distance`. Only faces of `occludes` entries block, only on their back side (see the raycast), and only faces of
  // `removable` entries are removed.
  if (buried) {
    const occluders: number[] = [];
    for (let t = 0; t < triangleCount; t++) if (!removedTriangle[t] && occludes(g.triangleEntry[t]!)) occluders.push(t);
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
      // Scratch for the per-candidate second edge and ray origin: the loop below runs once per surviving face of every
      // opaque front-side entry, so a `clone()` there is one allocation per face.
      const edge = new Vector3();
      const origin = new Vector3();
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
          // A hit blocks only when a viewer beyond it, looking back along the ray, would see that triangle drawn: the ray
          // meets its back side (three-mesh-bvh's BackSide test culls triangles facing the ray origin). A front-side card
          // facing the face shows that viewer its culled back, so it hides nothing.
          const hit = bvh.raycastFirst(ray, BackSide);
          // Depth along the face normal: a parallel wall at gap g that faces away from the face (the ray meets its back
          // side) blocks at g from every angle; one facing the face blocks nothing, so a face pressed against a
          // neighbouring solid's front face is buried only when that solid's far side is within `distance`.
          if (!hit || hit.distance * z > buried.distance) return false;
        }
        return true;
      };
      // Candidates: the surviving faces of opaque, front-side entries, all of which are occluders.
      for (const t of occluders) {
        if (triangleLocked(t) || !removable(g.triangleEntry[t]!)) continue;
        a.fromArray(g.position, g.index[t * 3]! * 3);
        b.fromArray(g.position, g.index[t * 3 + 1]! * 3);
        c.fromArray(g.position, g.index[t * 3 + 2]! * 3);
        n.copy(b).sub(a).cross(edge.copy(c).sub(a)).normalize();
        // The centroid, lifted `eps` along the face normal: the same value the two clones built, in one vector.
        origin.copy(a).add(b).add(c).multiplyScalar(1 / 3).addScaledVector(n, eps);
        if (!blocked(origin, n)) continue;
        removedTriangle[t] = 1;
        report.buriedFaces++;
      }
      occluder.dispose();
    }
  }

  // Kept coincident faces and kept duplicates that no later rule removed.
  if (opts.removeContactFaces) for (const t of kept) if (!removedTriangle[t]) report.keptCoincidentFaces++;
  for (const t of keptDuplicates) if (!removedTriangle[t]) report.keptDuplicateFaces++;
  keptDuplicates = [];

  // 4. Weld: same posId, normals and tangent directions within normalAngle, identical tangent w and uv, colours within colorTolerance.
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
