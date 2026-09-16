import { describe, expect, it } from 'vitest';
import { BackSide, BoxGeometry, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, FrontSide, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Raycaster, Vector3 } from 'three';
import { bakeGeometries, unbakeableAttribute, type BakeEntry } from '../../src/compiler/bake.js';

/**
 * An opaque, front-side box module that casts no shadow (an entry without `opaque`, `side` or `castShadow: false` loses
 * no faces, so tests of removal set all three).
 */
const box = (x: number, size = 1, extra?: Partial<BakeEntry>): BakeEntry => ({ geometry: new BoxGeometry(size, size, size), matrix: new Matrix4().makeTranslation(x, 0, 0), opaque: true, side: FrontSide, castShadow: false, ...extra });
const faceNormal = (p: Float32Array | ArrayLike<number>, i: number, index: ArrayLike<number>): Vector3 => {
  const a = new Vector3().fromArray(p, index[i * 3]! * 3);
  const b = new Vector3().fromArray(p, index[i * 3 + 1]! * 3);
  const c = new Vector3().fromArray(p, index[i * 3 + 2]! * 3);
  return b.sub(a).cross(c.sub(a)).normalize();
};

/** BoxGeometry's face order; each face is two triangles (six indices) in that order. */
const FACE = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 } as const;

/** The same box with one face triangulated along its other diagonal. */
function retriangulated(geometry: BufferGeometry, face: number): BufferGeometry {
  const index = Array.from(geometry.index!.array);
  const [a, b, d, b2, c, d2] = index.slice(face * 6, face * 6 + 6);
  if (b2 !== b || d2 !== d) throw new Error('unexpected BoxGeometry triangulation');
  index.splice(face * 6, 6, a!, b!, c!, a!, c!, d!);
  geometry.setIndex(index);
  return geometry;
}

/** The same box without one face: an open shell. */
function withoutFace(geometry: BufferGeometry, face: number): BufferGeometry {
  const index = Array.from(geometry.index!.array);
  index.splice(face * 6, 6);
  geometry.setIndex(index);
  return geometry;
}

/** Indexed parts concatenated into one geometry, each optionally transformed or turned inside out (winding and normals reversed). */
function merged(parts: Array<{ geometry: BufferGeometry; matrix?: Matrix4; insideOut?: boolean }>): BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (const part of parts) {
    const g = part.geometry.clone();
    if (part.matrix) g.applyMatrix4(part.matrix);
    const offset = position.length / 3;
    position.push(...(g.attributes.position!.array as Float32Array));
    const n = Array.from(g.attributes.normal!.array as Float32Array);
    normal.push(...(part.insideOut ? n.map((v) => -v) : n));
    uv.push(...(g.attributes.uv!.array as Float32Array));
    const idx = g.index!.array;
    for (let k = 0; k < idx.length; k += 3) index.push(offset + idx[k]!, offset + idx[part.insideOut ? k + 2 : k + 1]!, offset + idx[part.insideOut ? k + 1 : k + 2]!);
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(position, 3));
  out.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  out.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  out.setIndex(index);
  return out;
}

describe('bakeGeometries', () => {
  it('removes the two contact faces of two touching boxes and nothing else', () => {
    const { geometry, report, removed, triangleOrigins } = bakeGeometries([box(0), box(1)]);
    expect(report.inputTriangles).toBe(24);
    expect(report.contactFaces).toBe(4); // two quads, two triangles each
    expect(report.keptCoincidentFaces).toBe(0);
    expect(report.buriedFaces).toBe(0);
    expect(report.triangles).toBe(20);
    expect(geometry.index!.count / 3).toBe(20);
    expect(removed.index!.count / 3).toBe(4);
    expect(triangleOrigins.length).toBe(20);
    expect(new Set(triangleOrigins)).toEqual(new Set([0, 1]));
  });

  it('keeps one copy of duplicated faces', () => {
    const { report } = bakeGeometries([box(0), box(0)]);
    expect(report.duplicateFaces).toBe(12);
    expect(report.triangles).toBe(12);
  });

  it('leaves two boxes with a gap untouched', () => {
    const { report } = bakeGeometries([box(0), box(1.01)]);
    expect(report.contactFaces).toBe(0);
    expect(report.triangles).toBe(24);
  });

  it('welds vertices only when position, normal, uv and colour agree', () => {
    // A box has 24 vertices (4 per face, normals differ per face): nothing to weld.
    expect(bakeGeometries([box(0)]).report.weldedVertices).toBe(0);
    // Two coplanar quads sharing an edge, same normal and continuous uv: the two shared corners weld.
    const left = new PlaneGeometry(1, 1);
    const right = new PlaneGeometry(1, 1);
    const uv = right.attributes.uv!;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) + 1); // continue the uv range instead of repeating it
    left.attributes.uv!.setX(1, 1); // make the shared edge's uv identical: left's right edge is u=1
    const { report, geometry } = bakeGeometries([
      { geometry: left, matrix: new Matrix4() },
      { geometry: right, matrix: new Matrix4().makeTranslation(1, 0, 0) },
    ]);
    expect(report.inputVertices).toBe(8);
    expect(report.weldedVertices).toBe(2);
    expect(geometry.attributes.position!.count).toBe(6);
  });

  it('does not weld across differing colours', () => {
    const left = new PlaneGeometry(1, 1);
    const right = new PlaneGeometry(1, 1);
    const { report, geometry } = bakeGeometries([
      { geometry: left, matrix: new Matrix4(), color: new Color(0xff0000) },
      { geometry: right, matrix: new Matrix4().makeTranslation(1, 0, 0), color: new Color(0x00ff00) },
    ]);
    expect(report.weldedVertices).toBe(0);
    expect(geometry.attributes.color!.count).toBe(8);
    expect(geometry.attributes.color!.getX(0)).toBeCloseTo(1);
  });

  it('removes a box buried inside a solid only when every ray is blocked within the distance', () => {
    const buried = bakeGeometries([box(0, 1), box(0, 0.2)], { removeBuried: { distance: 1 } });
    expect(buried.report.buriedFaces).toBe(12);
    expect(buried.report.triangles).toBe(12);
    // Room interiors survive: the walls are further away than the default 0.1 units.
    const room = bakeGeometries([box(0, 1), box(0, 0.2)], { removeBuried: true });
    expect(room.report.buriedFaces).toBe(0);
  });

  it('removes buried faces only of opaque entries, and only opaque faces block the rays', () => {
    const options = { removeBuried: { distance: 1 } };
    // A translucent shell hides nothing, so the opaque box inside it stays.
    expect(bakeGeometries([box(0, 1, { opaque: false }), box(0, 0.2)], options).report.buriedFaces).toBe(0);
    // A translucent box inside an opaque solid is never removed.
    expect(bakeGeometries([box(0, 1), box(0, 0.2, { opaque: false })], options).report.buriedFaces).toBe(0);
    // An entry without `opaque` counts as not opaque.
    expect(bakeGeometries([box(0, 1), { geometry: new BoxGeometry(0.2, 0.2, 0.2), matrix: new Matrix4() }], options).report.buriedFaces).toBe(0);
  });

  it('keeps outward winding for mirrored instances', () => {
    const mirrored = new Matrix4().makeScale(-1, 1, 1);
    const { geometry } = bakeGeometries([{ geometry: new BoxGeometry(), matrix: mirrored }]);
    const p = geometry.attributes.position!.array;
    const n = geometry.attributes.normal!;
    for (let i = 0; i < geometry.index!.count / 3; i++) {
      const fn = faceNormal(p, i, geometry.index!.array);
      const vn = new Vector3(n.getX(geometry.index!.array[i * 3]!), n.getY(geometry.index!.array[i * 3]!), n.getZ(geometry.index!.array[i * 3]!));
      expect(fn.dot(vn)).toBeGreaterThan(0.9);
    }
  });

  it('leaves excluded entries untouched (their seams stay too) and reports them', () => {
    const { report } = bakeGeometries([box(0), box(1, 1, { bake: false })]);
    expect(report.excludedEntries).toBe(1);
    expect(report.contactFaces).toBe(0);
    expect(report.triangles).toBe(24);
  });

  it('removes a seam whatever the triangulation of the two faces', () => {
    // Two touching boxes; the second one's contact face (-x) is triangulated along its other diagonal.
    const other = retriangulated(new BoxGeometry(1, 1, 1), FACE.nx);
    const { report } = bakeGeometries([box(0), { ...box(1), geometry: other }]);
    expect(report.contactFaces).toBe(4);
    expect(report.keptCoincidentFaces).toBe(0);
    expect(report.triangles).toBe(20);
  });

  it('carries every UV set (lightmap uv1) through the bake and welds only when they agree', () => {
    // The second quad's uv continues the first's (u offset by its x), so the seam vertices agree on uv and only
    // uv1 decides whether they weld.
    const quad = (x: number, uv1Scale: number): BakeEntry => {
      const g = new PlaneGeometry(1, 1);
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) + x);
      const uv1 = new Float32Array(uv.count * 2);
      for (let i = 0; i < uv.count; i++) {
        uv1[i * 2] = uv.getX(i) * uv1Scale;
        uv1[i * 2 + 1] = uv.getY(i) * uv1Scale;
      }
      g.setAttribute('uv1', new Float32BufferAttribute(uv1, 2));
      return { geometry: g, matrix: new Matrix4().makeTranslation(x, 0, 0) };
    };
    const same = bakeGeometries([quad(0, 0.5), quad(1, 0.5)]);
    const uv1 = same.geometry.getAttribute('uv1');
    expect(uv1).toBeDefined();
    expect(uv1.itemSize).toBe(2);
    // Two touching quads share the seam edge: two vertices weld when uv and uv1 agree.
    expect(same.report.weldedVertices).toBe(2);
    expect(same.geometry.getAttribute('position').count).toBe(6);
    expect(Array.from(uv1.array as Float32Array).every((v) => v >= 0 && v <= 1)).toBe(true);
    const differ = bakeGeometries([quad(0, 0.5), quad(1, 0.25)]);
    expect(differ.report.weldedVertices).toBe(0);
    expect(differ.geometry.getAttribute('position').count).toBe(8);
  });
});

describe('bakeGeometries seam guard: a coincident opposite pair goes only between opaque, single-sided, closed outward shells of different entries', () => {
  const card = (matrix: Matrix4): BakeEntry => ({ geometry: new PlaneGeometry(1, 1), matrix, opaque: true, side: FrontSide, castShadow: false });

  it('keeps and counts back-to-back cards: open planes, not solids', () => {
    const { report } = bakeGeometries([card(new Matrix4()), card(new Matrix4().makeRotationY(Math.PI))]);
    expect(report.contactFaces).toBe(0);
    expect(report.keptCoincidentFaces).toBe(4);
    expect(report.triangles).toBe(4);
    // With contact removal off the guard does not run, so nothing is counted.
    const off = bakeGeometries([card(new Matrix4()), card(new Matrix4().makeRotationY(Math.PI))], { removeContactFaces: false });
    expect(off.report.keptCoincidentFaces).toBe(0);
    expect(off.report.triangles).toBe(4);
  });

  it('keeps and counts a coincident pair inside one entry', () => {
    const pair = merged([{ geometry: new BoxGeometry(1, 1, 1) }, { geometry: new BoxGeometry(1, 1, 1), matrix: new Matrix4().makeTranslation(1, 0, 0) }]);
    const { report } = bakeGeometries([{ geometry: pair, matrix: new Matrix4(), opaque: true, side: FrontSide, castShadow: false }]);
    expect(report.contactFaces).toBe(0);
    expect(report.keptCoincidentFaces).toBe(4);
    expect(report.triangles).toBe(24);
  });

  it('keeps and counts a face against a zero-volume plane slab (closed by edge pairing, but flat)', () => {
    // The slab is the box's own -x quad twice, once reversed: every edge is paired, but it encloses no volume. Placed on
    // the box, its unreversed copy duplicates the box's -x face exactly (removed as a duplicate) and its reversed copy
    // faces the box's -x face: a coincident opposite pair between different entries that only the volume test keeps.
    const nx = new BoxGeometry(1, 1, 1);
    const quad = new BufferGeometry();
    for (const name of ['position', 'normal', 'uv'] as const) {
      const a = nx.attributes[name]!;
      quad.setAttribute(name, new Float32BufferAttribute(Array.from(a.array).slice(FACE.nx * 4 * a.itemSize, (FACE.nx + 1) * 4 * a.itemSize), a.itemSize));
    }
    quad.setIndex(Array.from(nx.index!.array.slice(FACE.nx * 6, FACE.nx * 6 + 6)).map((i) => i - FACE.nx * 4));
    const slab = merged([{ geometry: quad }, { geometry: quad, insideOut: true }]);
    const { report } = bakeGeometries([box(1), { geometry: slab, matrix: new Matrix4().makeTranslation(1, 0, 0), opaque: true, side: FrontSide, castShadow: false }]);
    expect(report.contactFaces).toBe(0);
    expect(report.keptCoincidentFaces).toBe(4);
    expect(report.duplicateFaces).toBe(2);
    expect(report.triangles).toBe(14);
  });

  it('keeps and counts the seam when either module is double-sided', () => {
    for (const entries of [[box(0, 1, { doubleSided: true }), box(1)], [box(0), box(1, 1, { doubleSided: true })]]) {
      const { report } = bakeGeometries(entries);
      expect(report.contactFaces).toBe(0);
      expect(report.keptCoincidentFaces).toBe(4);
      expect(report.triangles).toBe(24);
    }
  });

  it('keeps and counts the seam between modules that are not opaque; an entry without `opaque` is not opaque', () => {
    const unflagged = (x: number): BakeEntry => ({ geometry: new BoxGeometry(1, 1, 1), matrix: new Matrix4().makeTranslation(x, 0, 0) });
    const cases: Array<[string, BakeEntry[]]> = [
      ['both translucent', [box(0, 1, { opaque: false }), box(1, 1, { opaque: false })]],
      ['one translucent', [box(0), box(1, 1, { opaque: false })]],
      ['opaque absent', [unflagged(0), unflagged(1)]],
    ];
    for (const [label, entries] of cases) {
      const { report } = bakeGeometries(entries);
      expect(report.contactFaces, label).toBe(0);
      expect(report.keptCoincidentFaces, label).toBe(4);
      expect(report.triangles, label).toBe(24);
    }
  });

  it('keeps and counts the seam against an open box', () => {
    const open = withoutFace(new BoxGeometry(1, 1, 1), FACE.py); // no lid: the inside of the contact face shows
    const { report } = bakeGeometries([{ ...box(0), geometry: open }, box(1)]);
    expect(report.contactFaces).toBe(0);
    expect(report.keptCoincidentFaces).toBe(4);
    expect(report.triangles).toBe(22);
  });

  it('keeps and counts the faces between an inside-out box and a box filling it', () => {
    const inside = merged([{ geometry: new BoxGeometry(1, 1, 1), insideOut: true }]);
    const { report } = bakeGeometries([{ geometry: inside, matrix: new Matrix4(), opaque: true, side: FrontSide, castShadow: false }, box(0)]);
    expect(report.contactFaces).toBe(0);
    expect(report.keptCoincidentFaces).toBe(24);
    expect(report.triangles).toBe(24);
  });

  it("checks every connected component: an inside-out part keeps its faces although the entry's total volume is positive", () => {
    const entry = merged([{ geometry: new BoxGeometry(3, 3, 3), matrix: new Matrix4().makeTranslation(10, 0, 0) }, { geometry: new BoxGeometry(1, 1, 1), insideOut: true }]);
    const { report } = bakeGeometries([{ geometry: entry, matrix: new Matrix4(), opaque: true, side: FrontSide, castShadow: false }, box(0)]);
    expect(report.contactFaces).toBe(0);
    expect(report.keptCoincidentFaces).toBe(24);
    expect(report.triangles).toBe(36);
  });

  it('treats mirrored matrices consistently: outward shells stay outward, so their seams still go', () => {
    const mirroredAt = (x: number): BakeEntry => ({ ...box(0), matrix: new Matrix4().makeTranslation(x, 0, 0).multiply(new Matrix4().makeScale(-1, 1, 1)) });
    const { report } = bakeGeometries([mirroredAt(0), mirroredAt(1)]);
    expect(report.contactFaces).toBe(4);
    expect(report.keptCoincidentFaces).toBe(0);
    expect(report.triangles).toBe(20);
  });
});

describe('bakeGeometries vertex colours and tangents', () => {
  const gray = (): PlaneGeometry => {
    const g = new PlaneGeometry(1, 1);
    g.setAttribute('color', new Float32BufferAttribute(new Float32Array(g.attributes.position!.count * 3).fill(0.5), 3));
    return g;
  };
  const tint = new Color().setRGB(1, 0.2, 0.6);
  const rows = (geometry: BufferGeometry, name: string, size: number): number[][] => {
    const a = geometry.getAttribute(name);
    return Array.from({ length: a.count }, (_, i) => [a.getX(i), a.getY(i), a.getZ(i), a.getW(i)].slice(0, size));
  };

  it('ignores the colour attribute when vertexColors is false: the tint alone colours the module', () => {
    const { geometry, hasColor } = bakeGeometries([{ geometry: gray(), matrix: new Matrix4(), color: tint, vertexColors: false }]);
    expect(hasColor).toBe(true);
    for (const [r, g, b] of rows(geometry, 'color', 3)) {
      expect(r).toBeCloseTo(1);
      expect(g).toBeCloseTo(0.2);
      expect(b).toBeCloseTo(0.6);
    }
    const untinted = bakeGeometries([{ geometry: gray(), matrix: new Matrix4(), vertexColors: false }]);
    expect(untinted.hasColor).toBe(false);
    expect(untinted.geometry.getAttribute('color')).toBeUndefined();
  });

  it('multiplies the colour attribute by the tint when vertexColors is true or absent (the default)', () => {
    for (const vertexColors of [true, undefined]) {
      const entry: BakeEntry = { geometry: gray(), matrix: new Matrix4(), color: tint, ...(vertexColors === undefined ? {} : { vertexColors }) };
      const { geometry } = bakeGeometries([entry]);
      for (const [r, g, b] of rows(geometry, 'color', 3)) {
        expect(r, String(vertexColors)).toBeCloseTo(0.5);
        expect(g, String(vertexColors)).toBeCloseTo(0.1);
        expect(b, String(vertexColors)).toBeCloseTo(0.3);
      }
    }
  });

  const withTangent = (x: number, y: number, z: number, w: number): PlaneGeometry => {
    const g = new PlaneGeometry(1, 1);
    const t = new Float32Array(g.attributes.position!.count * 4);
    for (let i = 0; i < t.length; i += 4) t.set([x, y, z, w], i);
    g.setAttribute('tangent', new Float32BufferAttribute(t, 4));
    return g;
  };

  it('carries tangents: xyz turned by the matrix and normalised, w kept as it is, also under a mirrored matrix', () => {
    // three builds the bitangent as cross(normalView, tangentView) * tangent.w with no determinant term
    // (nodes/accessors/Bitangent.js), so parity with the naive mesh keeps w even when the matrix mirrors.
    const cases: Array<{ label: string; matrix: Matrix4; expected: [number, number, number] }> = [
      { label: 'turned and scaled', matrix: new Matrix4().makeRotationZ(Math.PI / 2).multiply(new Matrix4().makeScale(2, 2, 2)), expected: [0, 1, 0] },
      { label: 'mirrored', matrix: new Matrix4().makeScale(-1, 1, 1), expected: [-1, 0, 0] },
    ];
    for (const { label, matrix, expected } of cases) {
      for (const w of [1, -1]) {
        const { geometry } = bakeGeometries([{ geometry: withTangent(1, 0, 0, w), matrix }]);
        expect(geometry.getAttribute('tangent')?.itemSize, label).toBe(4);
        for (const [x, y, z, tw] of rows(geometry, 'tangent', 4)) {
          expect(x, label).toBeCloseTo(expected[0]);
          expect(y, label).toBeCloseTo(expected[1]);
          expect(z, label).toBeCloseTo(expected[2]);
          expect(tw, `${label} w`).toBe(w);
        }
      }
    }
  });

  it('welds vertices only when their tangents agree in direction and w', () => {
    const quad = (x: number, tangent: [number, number, number, number]): BakeEntry => {
      const g = withTangent(...tangent);
      const uv = g.attributes.uv!;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) + x);
      return { geometry: g, matrix: new Matrix4().makeTranslation(x, 0, 0) };
    };
    expect(bakeGeometries([quad(0, [1, 0, 0, 1]), quad(1, [1, 0, 0, 1])]).report.weldedVertices).toBe(2);
    expect(bakeGeometries([quad(0, [1, 0, 0, 1]), quad(1, [1, 0, 0, -1])]).report.weldedVertices).toBe(0);
    expect(bakeGeometries([quad(0, [1, 0, 0, 1]), quad(1, [Math.cos(0.2), Math.sin(0.2), 0, 1])]).report.weldedVertices).toBe(0);
  });

  it('drops tangents unless every entry has them', () => {
    const { geometry } = bakeGeometries([
      { geometry: withTangent(1, 0, 0, 1), matrix: new Matrix4() },
      { geometry: new PlaneGeometry(1, 1), matrix: new Matrix4().makeTranslation(2, 0, 0) },
    ]);
    expect(geometry.getAttribute('tangent')).toBeUndefined();
  });

  it('gives a three-component tangent w = 1 and turns its xyz', () => {
    const g = new PlaneGeometry(1, 1);
    g.setAttribute('tangent', new Float32BufferAttribute(new Float32Array(g.attributes.position!.count * 3).map((_, i) => (i % 3 === 0 ? 1 : 0)), 3));
    const { geometry } = bakeGeometries([{ geometry: g, matrix: new Matrix4().makeRotationZ(Math.PI / 2) }]);
    expect(geometry.getAttribute('tangent')?.itemSize).toBe(4);
    for (const [x, y, z, w] of rows(geometry, 'tangent', 4)) {
      expect(x).toBeCloseTo(0);
      expect(y).toBeCloseTo(1);
      expect(z).toBeCloseTo(0);
      expect(w).toBe(1);
    }
  });
});

describe('bakeGeometries fix round 1: non-manifold shells, render sides, fused duplicates, kept survivors', () => {
  it('rejects a shell whose outward and inside-out parts share one edge (non-manifold): the filler keeps every face', () => {
    // One entry: an outward box [0,2]x[0,2]x[0,1] and an inside-out box [2,3]x[2,3]x[0,1] sharing the edge
    // (2,2,0)-(2,2,1); a second entry fills the inside-out box. The shared edge is used twice in each direction.
    const joined = (outwardOffsetX: number): BakeEntry => ({
      geometry: merged([
        { geometry: new BoxGeometry(2, 2, 1), matrix: new Matrix4().makeTranslation(1 + outwardOffsetX, 1, 0.5) },
        { geometry: new BoxGeometry(1, 1, 1), matrix: new Matrix4().makeTranslation(2.5, 2.5, 0.5), insideOut: true },
      ]),
      matrix: new Matrix4(),
      opaque: true,
      side: FrontSide,
      castShadow: false,
    });
    const filler: BakeEntry = { geometry: new BoxGeometry(1, 1, 1), matrix: new Matrix4().makeTranslation(2.5, 2.5, 0.5), opaque: true, side: FrontSide, castShadow: false };
    const shared = bakeGeometries([joined(0), filler]).report;
    // The -x and -y walls fuse with the outward box's faces across the shared edge, so four pairs are judged.
    expect(shared.contactFaces).toBe(0);
    expect(shared.keptCoincidentFaces).toBe(16);
    expect(shared.triangles).toBe(36);
    // Control: without the shared edge all six pairs are judged, and kept.
    const apart = bakeGeometries([joined(-0.5), filler]).report;
    expect(apart.contactFaces).toBe(0);
    expect(apart.keptCoincidentFaces).toBe(24);
  });

  it('keeps and counts the seam unless every module draws front faces only; an entry without `side` does not', () => {
    const cases: Array<[string, BakeEntry[]]> = [
      ['BackSide', [box(0, 1, { side: BackSide }), box(1, 1, { side: BackSide })]],
      ['one BackSide', [box(0), box(1, 1, { side: BackSide })]],
      ['DoubleSide', [box(0, 1, { side: DoubleSide }), box(1)]],
      ['side absent', [box(0, 1, { side: undefined }), box(1, 1, { side: undefined })]],
    ];
    for (const [label, entries] of cases) {
      const { report } = bakeGeometries(entries);
      expect(report.contactFaces, label).toBe(0);
      expect(report.keptCoincidentFaces, label).toBe(4);
      expect(report.triangles, label).toBe(24);
    }
  });

  it('removes buried faces only of front-side modules, and back-side faces block no ray', () => {
    const options = { removeBuried: { distance: 1 } };
    const buried = (entries: BakeEntry[]): number => bakeGeometries(entries, options).report.buriedFaces;
    expect(buried([box(0, 1), box(0, 0.2)]), 'control').toBe(12);
    expect(buried([box(0, 1), box(0, 0.2, { side: BackSide })]), 'back-side box inside').toBe(0);
    expect(buried([box(0, 1), box(0, 0.2, { side: DoubleSide })]), 'double-sided box inside').toBe(0);
    expect(buried([box(0, 1), box(0, 0.2, { side: undefined })]), 'side absent inside').toBe(0);
    // A back-side shell draws the far wall behind the box inside it, so it hides nothing; a double-sided one does.
    expect(buried([box(0, 1, { side: BackSide }), box(0, 0.2)]), 'inside a back-side shell').toBe(0);
    expect(buried([box(0, 1, { side: DoubleSide }), box(0, 0.2)]), 'inside a double-sided shell').toBe(12);
  });

  it('keeps two separate regions each covered twice with different triangulations (their fused islands have no outline)', () => {
    // Each spot: a tile and the same tile turned 90 degrees about its normal (the other diagonal). Every edge of a spot
    // is used twice, so each spot fuses into one island whose boundary is empty.
    const tile = (x: number, turned: boolean): BakeEntry => ({ geometry: new PlaneGeometry(1, 1), matrix: new Matrix4().makeTranslation(x, 0, 0).multiply(new Matrix4().makeRotationZ(turned ? Math.PI / 2 : 0)), opaque: true, side: FrontSide, castShadow: false });
    const { report, triangleOrigins } = bakeGeometries([tile(0, false), tile(0, true), tile(10, false), tile(10, true)]);
    expect(report.duplicateFaces).toBe(0);
    expect(report.triangles).toBe(8);
    expect(new Set(triangleOrigins)).toEqual(new Set([0, 1, 2, 3]));
  });

  it('counts only the kept coincident faces that survive the bake: a kept pair buried inside a solid is not counted', () => {
    const card = (turned: boolean): BakeEntry => ({ geometry: new PlaneGeometry(0.5, 0.5), matrix: new Matrix4().makeRotationY(turned ? Math.PI : 0), opaque: true, side: FrontSide, castShadow: false });
    expect(bakeGeometries([box(0, 1), card(false), card(true)]).report.keptCoincidentFaces, 'without removeBuried').toBe(4);
    const { report } = bakeGeometries([box(0, 1), card(false), card(true)], { removeBuried: { distance: 1 } });
    expect(report.contactFaces).toBe(0);
    expect(report.buriedFaces).toBe(4);
    expect(report.keptCoincidentFaces).toBe(0);
  });
});

describe('bakeGeometries fix round 2: outlines of overlapping or non-manifold islands, shadow casters, back-side hits, copies', () => {
  /** The first front face a ray straight down from above (x, z) meets in a baked geometry, or undefined. */
  const hitFromAbove = (geometry: BufferGeometry, x: number, z: number) =>
    new Raycaster(new Vector3(x, 5, z), new Vector3(0, -1, 0)).intersectObject(new Mesh(geometry, new MeshBasicMaterial()))[0];
  const placed = (geometry: BufferGeometry, matrix: Matrix4): BakeEntry => ({ ...box(0), geometry, matrix });

  /** A closed, outward prism over a counter-clockwise (x, z) polygon, its caps split into `caps`, from y0 up to y1. */
  const prism = (polygon: Array<[number, number]>, caps: Array<[number, number, number]>, y0: number, y1: number): BufferGeometry => {
    const n = polygon.length;
    const position: number[] = [];
    for (const [x, z] of polygon) position.push(x, y0, z);
    for (const [x, z] of polygon) position.push(x, y1, z);
    const index: number[] = [];
    for (const [a, b, c] of caps) index.push(a, b, c, n + a, n + c, n + b); // bottom faces -y, top faces +y
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      index.push(i, n + j, j, i, n + i, n + j); // side wall, facing out
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(position, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    return g;
  };

  it('does not pair outlines shortened by an edge used three times: a mirrored copy leaves the longer top over x in [2, 3] covered', () => {
    const mirrored = (geometry: BufferGeometry, x: number, y: number): BakeEntry => placed(geometry, new Matrix4().makeTranslation(x, y, 0).multiply(new Matrix4().makeScale(-1, 1, 1)));
    const { geometry } = bakeGeometries([
      placed(new BoxGeometry(1, 1, 1), new Matrix4().makeTranslation(0.5, 0.5, 0)),
      placed(new BoxGeometry(1, 1, 1), new Matrix4().makeTranslation(1.5, 0.5, 0)),
      mirrored(new BoxGeometry(1, 1, 1), 1.5, 0.5),
      placed(new BoxGeometry(1, 1, 1), new Matrix4().makeTranslation(0.5, -0.5, 0)),
      placed(new BoxGeometry(2, 1, 1), new Matrix4().makeTranslation(2, -0.5, 0)),
      mirrored(new BoxGeometry(2, 1, 1), 2, -0.5),
    ]);
    const hit = hitFromAbove(geometry, 2.5, 0.1);
    expect(hit, 'nothing sits on the long top over x in [2, 3]: it must stay').toBeDefined();
    expect(hit!.point.y).toBeCloseTo(0);
  });

  it('does not pair islands whose triangles overlap: a prism top lying inside a box top, sharing one of its edges, keeps both', () => {
    // Box X's top [0,2]x[0,2] at y = 0; prism Y (inside X) has its top triangle (0,0)-(2,0)-(1,0.3) on it, sharing X's
    // edge (0,0)-(2,0) in the same direction, so every edge of the plus island is used at most twice; prism Z above
    // covers X's top minus Y's triangle, and its bottom has exactly the plus island's once-used edges.
    const { geometry, report } = bakeGeometries([
      placed(new BoxGeometry(2, 1, 2), new Matrix4().makeTranslation(1, -0.5, 1)),
      placed(prism([[0, 0], [2, 0], [1, 0.3]], [[0, 1, 2]], -0.2, 0), new Matrix4()),
      placed(prism([[0, 0], [1, 0.3], [2, 0], [2, 2], [0, 2]], [[1, 2, 3], [1, 3, 4], [1, 4, 0]], 0, 1), new Matrix4()),
    ]);
    const hit = hitFromAbove(geometry, 1, 0.1);
    expect(hit, 'nothing covers the prism top triangle: the tops there must stay').toBeDefined();
    expect(hit!.point.y).toBeCloseTo(0);
    expect(report.contactFaces).toBe(0);
    expect(report.keptCoincidentFaces).toBe(6);
  });

  it.each([
    ['casts shadows', { castShadow: true }],
    ['has no castShadow flag', { castShadow: undefined }],
  ] as Array<[string, Partial<BakeEntry>]>)('keeps and counts the seam when a module %s', (_label, extra) => {
    const { report } = bakeGeometries([box(0, 1, extra), box(1, 1, extra)]);
    expect(report.contactFaces).toBe(0);
    expect(report.keptCoincidentFaces).toBe(4);
    expect(report.triangles).toBe(24);
  });

  it.each([
    ['casts shadows', { castShadow: true }],
    ['has no castShadow flag', { castShadow: undefined }],
  ] as Array<[string, Partial<BakeEntry>]>)('removes no buried face of a module that %s', (_label, extra) => {
    expect(bakeGeometries([box(0, 1), box(0, 0.2, extra)], { removeBuried: { distance: 1 } }).report.buriedFaces).toBe(0);
  });

  const card = (facingTheBox: boolean): BakeEntry => placed(new PlaneGeometry(10, 10), new Matrix4().makeTranslation(0, 0, 0.55).multiply(new Matrix4().makeRotationY(facingTheBox ? Math.PI : 0)));

  it("does not bury a face behind a front-side card that faces it: a viewer beyond sees through the card's culled back", () => {
    expect(bakeGeometries([box(0), card(true)], { removeBuried: true }).report.buriedFaces).toBe(0);
  });

  it('buries the face behind a front-side card that faces away from it: a viewer beyond sees the drawn card', () => {
    expect(bakeGeometries([box(0), card(false)], { removeBuried: true }).report.buriedFaces).toBe(2);
  });

  it.each([
    ['not opaque', { opaque: false }],
    ['back-side', { side: BackSide }],
    ['shadow-casting', { castShadow: true }],
  ] as Array<[string, Partial<BakeEntry>]>)('keeps both exact copies when one of them is %s', (_label, extra) => {
    for (const entries of [[box(0), box(0, 1, extra)], [box(0, 1, extra), box(0)]]) {
      const { report } = bakeGeometries(entries);
      expect(report.duplicateFaces).toBe(0);
      expect(report.triangles).toBe(24);
    }
  });
});

describe('bakeGeometries duplicate rule: a copy goes only when every coincident copy draws the same pixels', () => {
  const red = new Color(1, 0, 0);
  const blue = new Color(0, 0, 1);
  const green = new Color(0, 1, 0);
  /** Colour per output triangle, read at its first corner. */
  const colours = (geometry: BufferGeometry): string[] => {
    const color = geometry.getAttribute('color');
    const index = geometry.index!;
    return Array.from({ length: index.count / 3 }, (_, t) => {
      const v = index.getX(t * 3);
      return [color.getX(v), color.getY(v), color.getZ(v)].map((c) => c.toFixed(2)).join(',');
    });
  };
  /** The same box with its uvs shifted: the same triangles, a different texture lookup. */
  const shiftedUv = (): BoxGeometry => {
    const g = new BoxGeometry(1, 1, 1);
    const uv = g.attributes.uv!;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) + 0.25);
    return g;
  };
  /** The same box with every normal tilted: the same triangles, lit differently. */
  const tiltedNormals = (): BoxGeometry => {
    const g = new BoxGeometry(1, 1, 1);
    const n = g.attributes.normal!;
    const v = new Vector3();
    for (let i = 0; i < n.count; i++) {
      v.fromBufferAttribute(n, i).add(new Vector3(0.3, 0.3, 0)).normalize();
      n.setXYZ(i, v.x, v.y, v.z);
    }
    return g;
  };

  it('keeps and counts a duplicate whose tint differs: three draws the later copy, so neither may go', () => {
    const { geometry, report } = bakeGeometries([box(0, 1, { color: red }), box(0, 1, { color: blue })]);
    expect(report.duplicateFaces).toBe(0);
    expect(report.keptDuplicateFaces).toBe(24);
    expect(report.triangles).toBe(24);
    // The later copy is still later in the index, as it was later in three's opaque list.
    expect(colours(geometry).slice(12)).toEqual(Array(12).fill('0.00,0.00,1.00'));
  });

  it('still removes a duplicate whose copies are interchangeable (same tint), and counts nothing kept', () => {
    const { report } = bakeGeometries([box(0, 1, { color: green }), box(0, 1, { color: green })]);
    expect(report.duplicateFaces).toBe(12);
    expect(report.keptDuplicateFaces).toBe(0);
    expect(report.triangles).toBe(12);
  });

  it.each([
    ['uvs', shiftedUv],
    ['normals', tiltedNormals],
  ] as Array<[string, () => BufferGeometry]>)('keeps and counts a duplicate whose %s differ', (_label, geometry) => {
    const { report } = bakeGeometries([box(0), { ...box(0), geometry: geometry() }]);
    expect(report.duplicateFaces).toBe(0);
    expect(report.keptDuplicateFaces).toBe(24);
    expect(report.triangles).toBe(24);
  });

  it('keeps all three copies when the middle one differs: removing the last would show the middle one', () => {
    const { report } = bakeGeometries([box(0, 1, { color: red }), box(0, 1, { color: blue }), box(0, 1, { color: red })]);
    expect(report.duplicateFaces).toBe(0);
    expect(report.keptDuplicateFaces).toBe(36);
    expect(report.triangles).toBe(36);
  });

  it('keeps both removable copies when an excluded entry (bake: false) draws the same triangles between them', () => {
    const { report } = bakeGeometries([box(0, 1, { color: green }), box(0, 1, { color: blue, bake: false }), box(0, 1, { color: green })]);
    expect(report.duplicateFaces).toBe(0);
    expect(report.keptDuplicateFaces).toBe(24);
    expect(report.triangles).toBe(36);
  });

  it('keeps both removable copies when a double-sided copy with the opposite winding draws the same triangle', () => {
    const quad = (reversed: boolean, extra: Partial<BakeEntry>): BakeEntry => ({ ...box(0), geometry: new PlaneGeometry(1, 1), matrix: new Matrix4().makeRotationY(reversed ? Math.PI : 0), ...extra });
    const { report } = bakeGeometries([quad(false, { color: green }), quad(true, { color: blue, side: DoubleSide, doubleSided: true }), quad(false, { color: green })]);
    expect(report.duplicateFaces).toBe(0);
    expect(report.keptDuplicateFaces).toBe(4);
    expect(report.triangles).toBe(6);
  });

  it('keeps and counts a triangle repeated inside one entry with different uvs', () => {
    const g = new PlaneGeometry(1, 1);
    const position = Array.from(g.attributes.position!.array as Float32Array);
    const uv = Array.from(g.attributes.uv!.array as Float32Array);
    const doubled = new BufferGeometry();
    doubled.setAttribute('position', new Float32BufferAttribute([...position, ...position], 3));
    doubled.setAttribute('normal', new Float32BufferAttribute([...Array.from(g.attributes.normal!.array as Float32Array), ...Array.from(g.attributes.normal!.array as Float32Array)], 3));
    doubled.setAttribute('uv', new Float32BufferAttribute([...uv, ...uv.map((u) => u * 0.5)], 2));
    const index = Array.from(g.index!.array);
    doubled.setIndex([...index, ...index.map((i) => i + 4)]);
    const { report } = bakeGeometries([{ ...box(0), geometry: doubled }]);
    expect(report.duplicateFaces).toBe(0);
    expect(report.keptDuplicateFaces).toBe(4);
    expect(report.triangles).toBe(4);
  });

  it('keeps the copies when a triangle of another triangulation lies over them in between: removing the last would show it', () => {
    const { report } = bakeGeometries([box(0, 1, { color: red }), box(0, 1, { color: blue, geometry: retriangulated(new BoxGeometry(1, 1, 1), FACE.py) }), box(0, 1, { color: red })]);
    // Every face but +y is on the same points in all three: those copies differ in tint. The +y face of the first and
    // last copies is interchangeable, but the retriangulated blue face lies over it.
    expect(report.duplicateFaces).toBe(0);
    expect(report.keptDuplicateFaces).toBe(34);
    expect(report.triangles).toBe(36);
  });

  it('still removes the copies of a box placed twice beside a touching box: an edge-sharing neighbour does not lie over them', () => {
    const { report } = bakeGeometries([box(0), box(0), box(1)]);
    expect(report.duplicateFaces).toBe(12);
    expect(report.keptDuplicateFaces).toBe(0);
  });

  it('counts kept duplicates only while the duplicate rule is on', () => {
    const { report } = bakeGeometries([box(0, 1, { color: red }), box(0, 1, { color: blue })], { removeDuplicateFaces: false });
    expect(report.duplicateFaces).toBe(0);
    expect(report.keptDuplicateFaces).toBe(0);
  });
});

describe('unbakeableAttribute: what the bake carries faithfully', () => {
  const withAttribute = (name: string, itemSize: number): BufferGeometry => {
    const g = new BoxGeometry(1, 1, 1);
    g.setAttribute(name, new Float32BufferAttribute(new Float32Array(g.attributes.position!.count * itemSize).fill(0.5), itemSize));
    return g;
  };

  it('accepts position, normal, a three- or four-component tangent, uv to uv3 and a three-component colour', () => {
    expect(unbakeableAttribute(new BoxGeometry(1, 1, 1))).toBeNull();
    for (const [name, size] of [['tangent', 4], ['tangent', 3], ['uv1', 2], ['uv2', 2], ['uv3', 2], ['color', 3]] as Array<[string, number]>) {
      expect(unbakeableAttribute(withAttribute(name, size)), `${name}:${size}`).toBeNull();
    }
  });

  it('names a four-component colour the material reads (three multiplies its alpha into the diffuse colour), not one it ignores', () => {
    expect(unbakeableAttribute(withAttribute('color', 4))).toBe('color');
    expect(unbakeableAttribute(withAttribute('color', 4), true)).toBe('color');
    expect(unbakeableAttribute(withAttribute('color', 4), false, true)).toBeNull();
  });

  it('names a colour its vertexColors flag ignores unless three\'s own code is all that reads the geometry (an allowlist)', () => {
    for (const size of [3, 4]) {
      expect(unbakeableAttribute(withAttribute('color', size), false, true), `color:${size}, built-in reads`).toBeNull();
      expect(unbakeableAttribute(withAttribute('color', size), false, false), `color:${size}, a node graph may read it`).toBe('color');
      expect(unbakeableAttribute(withAttribute('color', size), false), `color:${size}, reads not stated`).toBe('color');
    }
    expect(unbakeableAttribute(withAttribute('color', 3), true, false), 'a three-component colour the flag reads is carried').toBeNull();
  });

  it('names an attribute outside the carried set, and a carried one with another item size', () => {
    expect(unbakeableAttribute(withAttribute('_feature_id_0', 1))).toBe('_feature_id_0');
    expect(unbakeableAttribute(withAttribute('uv4', 2))).toBe('uv4');
    expect(unbakeableAttribute(withAttribute('uv', 3))).toBe('uv');
    expect(unbakeableAttribute(withAttribute('normal', 4))).toBe('normal');
  });
});
