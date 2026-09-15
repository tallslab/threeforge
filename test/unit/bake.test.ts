import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Matrix4, PlaneGeometry, Vector3 } from 'three';
import { bakeGeometries, type BakeEntry } from '../../src/compiler/bake.js';

/** An opaque box module (an entry without `opaque` counts as not opaque, so tests of removal set it). */
const box = (x: number, size = 1, extra?: Partial<BakeEntry>): BakeEntry => ({ geometry: new BoxGeometry(size, size, size), matrix: new Matrix4().makeTranslation(x, 0, 0), opaque: true, ...extra });
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
  const card = (matrix: Matrix4): BakeEntry => ({ geometry: new PlaneGeometry(1, 1), matrix, opaque: true });

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
    const { report } = bakeGeometries([{ geometry: pair, matrix: new Matrix4(), opaque: true }]);
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
    const { report } = bakeGeometries([box(1), { geometry: slab, matrix: new Matrix4().makeTranslation(1, 0, 0), opaque: true }]);
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
    const { report } = bakeGeometries([{ geometry: inside, matrix: new Matrix4(), opaque: true }, box(0)]);
    expect(report.contactFaces).toBe(0);
    expect(report.keptCoincidentFaces).toBe(24);
    expect(report.triangles).toBe(24);
  });

  it("checks every connected component: an inside-out part keeps its faces although the entry's total volume is positive", () => {
    const entry = merged([{ geometry: new BoxGeometry(3, 3, 3), matrix: new Matrix4().makeTranslation(10, 0, 0) }, { geometry: new BoxGeometry(1, 1, 1), insideOut: true }]);
    const { report } = bakeGeometries([{ geometry: entry, matrix: new Matrix4(), opaque: true }, box(0)]);
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
});
