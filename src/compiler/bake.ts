/**
 * Geometry bake for finished groups: merge into one geometry, drop contact seams between touching solid modules, drop
 * duplicated faces, optionally drop truly buried faces, then weld vertices whose position, normal, tangent, uv and
 * colour agree. A wrong deletion is visible and a missed one is invisible, so every rule is conservative (a coincident
 * pair that is not provably a seam between two solids stays, and is counted) and every removal is counted and
 * returned as geometry (`removed`) that an agent can render to check.
 */
import { type BufferGeometry, type Color, DoubleSide, FrontSide, type Matrix4, type Side } from 'three';
import { removeBuriedFaces } from './bake/buried.js';
import { coincidentIslands, removeExactDuplicates } from './bake/coincident.js';
import { gather, positionIds, triangleLocked } from './bake/gather.js';
import { closedOutwardShell, isDegenerate } from './bake/topology.js';
import { vertexComparator, weld } from './bake/weld.js';

export { unbakeableAttribute } from './bake/gather.js';

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

const DEFAULTS = {
  tolerance: 1e-4,
  normalAngle: 0.5,
  colorTolerance: 1 / 255,
  removeContactFaces: true,
  removeDuplicateFaces: true,
};
const BURIED_DEFAULTS: Required<BuriedOptions> = { samples: 24, distance: 0.1 };

/** Merge modules into one geometry with the removals and welds described by `options`. */
export function bakeGeometries(entries: BakeEntry[], options: BakeOptions = {}): BakeResult {
  const opts = { ...DEFAULTS, ...options };
  const buried: Required<BuriedOptions> | null = options.removeBuried
    ? { ...BURIED_DEFAULTS, ...(typeof options.removeBuried === 'object' ? options.removeBuried : {}) }
    : null;
  const g = gather(entries);
  const triangleCount = g.triangleEntry.length;
  const report: BakeReport = {
    inputVertices: g.vertexEntry.length,
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
  const { placeIds, posIds, count: posCount } = positionIds(g, opts.tolerance);
  const same = vertexComparator(opts.normalAngle, opts.colorTolerance);

  const removedTriangle = new Uint8Array(triangleCount);
  /** Marks the triangles of `list` removed and returns how many were not already. */
  const remove = (list: number[]): number => {
    let n = 0;
    for (const t of list) {
      if (removedTriangle[t]) continue;
      removedTriangle[t] = 1;
      n++;
    }
    return n;
  };
  for (let t = 0; t < triangleCount; t++) {
    if (isDegenerate(posIds[g.index[t * 3]!]!, posIds[g.index[t * 3 + 1]!]!, posIds[g.index[t * 3 + 2]!]!)) {
      removedTriangle[t] = 1;
      report.degenerateFaces++;
    }
  }

  // Exact duplicates first (see removeExactDuplicates), then contact seams and duplicates on coplanar islands (see
  // coincidentIslands).
  let keptDuplicates: number[] = [];
  if (opts.removeDuplicateFaces) {
    const found = removeExactDuplicates(g, placeIds, posIds, removedTriangle, opts.tolerance, removable, (i, j) =>
      same(g, i, g, j),
    );
    report.duplicateFaces += found.removed;
    keptDuplicates = found.kept;
  }
  const candidates: number[] = [];
  for (let t = 0; t < triangleCount; t++) if (!removedTriangle[t] && !triangleLocked(g, t)) candidates.push(t);
  let kept: number[] = [];
  if (opts.removeContactFaces || opts.removeDuplicateFaces) {
    // An entry may lose seam faces only when it is opaque, front-side and a closed, manifold, outward shell (computed once).
    const shells = new Int8Array(entries.length); // 0 not yet computed, 1 closed and outward, -1 not
    const seamSafe = (k: number): boolean => {
      if (!removable(k)) return false;
      if (shells[k] === 0) shells[k] = closedOutwardShell(g, posIds, posCount, k, opts.tolerance) ? 1 : -1;
      return shells[k] === 1;
    };
    const found = coincidentIslands(
      g,
      posIds,
      posCount,
      candidates,
      opts.tolerance,
      opts.removeContactFaces ? seamSafe : null,
      removable,
    );
    kept = found.kept;
    if (opts.removeContactFaces) report.contactFaces += remove(found.seams);
    if (opts.removeDuplicateFaces) report.duplicateFaces += remove(found.duplicates);
  }

  if (buried) report.buriedFaces = removeBuriedFaces(g, removedTriangle, buried, opts.tolerance, occludes, removable);

  // Kept coincident faces and kept duplicates that no later rule removed.
  if (opts.removeContactFaces) for (const t of kept) if (!removedTriangle[t]) report.keptCoincidentFaces++;
  for (const t of keptDuplicates) if (!removedTriangle[t]) report.keptDuplicateFaces++;

  const welded = weld(g, posIds, removedTriangle, same);
  report.vertices = welded.vertices;
  report.triangles = welded.triangles;
  report.weldedVertices = welded.weldedVertices;
  return {
    geometry: welded.geometry,
    removed: welded.removed,
    report,
    triangleOrigins: welded.triangleOrigins,
    hasColor: g.hasColor,
    hasUv: g.hasUv,
  };
}
