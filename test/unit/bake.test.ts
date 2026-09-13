import { describe, expect, it } from 'vitest';
import { BoxGeometry, Color, Matrix4, PlaneGeometry, Vector3 } from 'three';
import { bakeGeometries, type BakeEntry } from '../../src/compiler/bake.js';

const box = (x: number, size = 1, extra?: Partial<BakeEntry>): BakeEntry => ({ geometry: new BoxGeometry(size, size, size), matrix: new Matrix4().makeTranslation(x, 0, 0), ...extra });
const faceNormal = (p: Float32Array | ArrayLike<number>, i: number, index: ArrayLike<number>): Vector3 => {
  const a = new Vector3().fromArray(p, index[i * 3]! * 3);
  const b = new Vector3().fromArray(p, index[i * 3 + 1]! * 3);
  const c = new Vector3().fromArray(p, index[i * 3 + 2]! * 3);
  return b.sub(a).cross(c.sub(a)).normalize();
};

describe('bakeGeometries', () => {
  it('removes the two contact faces of two touching boxes and nothing else', () => {
    const { geometry, report, removed, triangleOrigins } = bakeGeometries([box(0), box(1)]);
    expect(report.inputTriangles).toBe(24);
    expect(report.contactFaces).toBe(4); // two quads, two triangles each
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
    // A quad triangulated along one diagonal against the same quad triangulated along the other.
    const quad = (flip: boolean): BakeEntry => {
      const g = new PlaneGeometry(1, 1); // two triangles along one diagonal, normal +z
      if (flip) g.setIndex([0, 2, 1, 1, 2, 3].map((i) => [1, 0, 3, 2][i]!)); // the other diagonal, normal -z
      g.computeVertexNormals();
      return { geometry: g, matrix: new Matrix4() };
    };
    const { report } = bakeGeometries([quad(false), quad(true)]);
    expect(report.contactFaces).toBe(4);
    expect(report.triangles).toBe(0);
  });
});
