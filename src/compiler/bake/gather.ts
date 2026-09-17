import { type BufferGeometry, Matrix3, Vector3 } from 'three';
import type { BakeEntry } from '../bake.js';

/** Item sizes of the attributes `gather` carries into the baked geometry (colour: see `unbakeableAttribute`). */
const CARRIED: Record<string, readonly number[]> = {
  position: [3],
  normal: [3],
  tangent: [3, 4],
  uv: [2],
  uv1: [2],
  uv2: [2],
  uv3: [2],
  color: [3],
};

/**
 * The first attribute of `geometry` the bake does not carry faithfully, or null: one outside `position`, `normal`,
 * `tangent` (three or four components), `uv` to `uv3` (two) and `color` (three), or one of those with another item
 * size. A four-component colour (glTF's RGBA `COLOR_0`) would lose the alpha three multiplies into the diffuse colour
 * (NodeMaterial.setupDiffuseColor reads `vertexColor()` as a vec4). With `vertexColors` false the bake drops `color`,
 * which is faithful only when `builtInReads` says three's own code is all that reads the geometry (`bakeProvesReads`;
 * NodeMaterial.js:839 is three r186's only reader); otherwise a node or an overridden method may read it, so it counts.
 */
export function unbakeableAttribute(
  geometry: BufferGeometry,
  vertexColors = true,
  builtInReads = false,
): string | null {
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

export interface Gathered {
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

export function gather(entries: BakeEntry[]): Gathered & { hasColor: boolean; hasUv: boolean } {
  const uvSets = ['uv', 'uv1', 'uv2', 'uv3'].filter((name) =>
    entries.every((e) => e.geometry.attributes[name] !== undefined),
  );
  const hasUv = uvSets.includes('uv');
  const readsColor = (e: BakeEntry): boolean => e.vertexColors !== false && e.geometry.attributes.color !== undefined;
  const hasColor = entries.some(
    (e) => readsColor(e) || (e.color && (e.color.r !== 1 || e.color.g !== 1 || e.color.b !== 1)),
  );
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
  return {
    position,
    normal,
    tangent,
    uvSets,
    uvs,
    color,
    vertexEntry,
    index,
    triangleEntry,
    entryTriangles,
    locked,
    hasColor,
    hasUv,
  };
}

/** Whether triangle `t` belongs to an excluded entry (`bake: false`): its vertices are locked. */
export function triangleLocked(g: Gathered, t: number): boolean {
  return g.locked[g.index[t * 3]!] === 1;
}

/**
 * Position identity: vertices within `tolerance` share a place (`placeIds`, locked vertices included) and a posId
 * (locked vertices keep their own, so no rule joins or removes their triangles). `count` is the number of posIds.
 */
export function positionIds(
  g: Gathered,
  tolerance: number,
): { placeIds: Uint32Array; posIds: Uint32Array; count: number } {
  const vertexCount = g.vertexEntry.length;
  const inv = 1 / tolerance;
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
  return { placeIds, posIds, count: nextPos };
}
