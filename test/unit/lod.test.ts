import {
  BufferAttribute,
  type BufferGeometry,
  DodecahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  Scene,
  SphereGeometry,
  TorusKnotGeometry,
  Vector3,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { disposeLods, generateLods, lodsOf, prepareLods } from '../../src/lod/generateLods.js';
import { tag } from '../../src/tags.js';

/** Surface area through the index: NaN when an index reads past the vertices. */
function area(g: BufferGeometry): number {
  const position = g.getAttribute('position');
  const index = g.getIndex()!;
  const [a, b, c] = [new Vector3(), new Vector3(), new Vector3()];
  let sum = 0;
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i));
    b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    sum += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return sum;
}

describe('generateLods', () => {
  it('produces one level per ratio with about that share of the triangles', async () => {
    const base = new TorusKnotGeometry(1, 0.3, 128, 24); // ~18k triangles
    const lods = await generateLods(base, { ratios: [0.5, 0.2] });
    expect(lods).toHaveLength(2);
    const tri = (g: BufferGeometry) => g.index!.count / 3;
    expect(tri(lods[0]!)).toBeLessThan(tri(base) * 0.6);
    expect(tri(lods[0]!)).toBeGreaterThan(tri(base) * 0.3);
    expect(tri(lods[1]!)).toBeLessThan(tri(lods[0]!));
    for (const lod of lods) {
      expect(Object.keys(lod.attributes).sort()).toEqual(Object.keys(base.attributes).sort());
      expect(lod.attributes.position!.count).toBeLessThan(base.attributes.position!.count);
      expect(lod.boundingSphere).not.toBeNull();
    }
  });

  it('handles non-indexed geometry by indexing it first and leaves the original untouched', async () => {
    const base = new DodecahedronGeometry(1, 3);
    const beforeCount = base.attributes.position!.count;
    const lods = await generateLods(base, { ratios: [0.3] });
    expect(base.index).toBeNull();
    expect(base.attributes.position!.count).toBe(beforeCount);
    expect(lods[0]!.index!.count / 3).toBeLessThan(beforeCount / 3);
  });

  it('never returns a level with more triangles than the previous one', async () => {
    const base = new SphereGeometry(1, 8, 6); // tiny: simplifier may refuse to go below a floor
    const lods = await generateLods(base, { ratios: [0.5, 0.25, 0.1] });
    let previous = base.index!.count;
    for (const lod of lods) {
      expect(lod.index!.count).toBeLessThanOrEqual(previous);
      previous = lod.index!.count;
    }
  });

  it.each([
    ['an indexed sphere', () => new SphereGeometry(1.3, 32, 24)],
    ['a non-indexed dodecahedron', () => new DodecahedronGeometry(1, 3)],
    ['a torus knot', () => new TorusKnotGeometry(1, 0.3, 64, 12)],
  ])("builds every level of %s from its own vertices, all of them the source's", async (_, build) => {
    const base = build();
    const source = new Set<string>();
    const position = base.getAttribute('position');
    for (let v = 0; v < position.count; v++) source.add(`${position.getX(v)},${position.getY(v)},${position.getZ(v)}`);
    for (const lod of await generateLods(base, { ratios: [0.5, 0.2] })) {
      const vertices = lod.getAttribute('position');
      const used = new Set<number>(lod.getIndex()!.array);
      // Compaction leaves exactly the vertices the triangles use: every index is one, and every one is indexed.
      expect([...used].sort((a, b) => a - b)).toEqual(Array.from({ length: vertices.count }, (_, v) => v));
      // Simplification moves nothing, so a level's vertex that is not a source vertex was read through a wrong index.
      for (let v = 0; v < vertices.count; v++)
        expect(source.has(`${vertices.getX(v)},${vertices.getY(v)},${vertices.getZ(v)}`), `vertex ${v}`).toBe(true);
      expect(Number.isFinite(area(lod))).toBe(true);
      expect(Number.isFinite(lod.boundingSphere!.radius)).toBe(true);
      expect(lod.boundingBox!.isEmpty()).toBe(false);
    }
  });

  it('simplifies each level from intact indices, so later levels still wrap the source', async () => {
    const base = new SphereGeometry(1.3, 32, 24);
    const lods = await generateLods(base, { ratios: [0.5, 0.2, 0.1] });
    // A sphere is convex and its levels keep source vertices, so a level can only lose a little area to flatter
    // facets. Indices compacted for one level and then simplified again against the source lose most of it.
    expect(lods.map((lod) => area(lod) / area(base))).toEqual([
      expect.closeTo(0.99, 1),
      expect.closeTo(0.97, 1),
      expect.closeTo(0.94, 1),
    ]);
  });

  it.each([
    ['16-bit', Uint16Array],
    ['32-bit', Uint32Array],
  ])('leaves a %s indexed source geometry as it was', async (_, IndexArray) => {
    const base = new SphereGeometry(1.3, 32, 24);
    base.setIndex(new BufferAttribute(IndexArray.from(base.getIndex()!.array), 1));
    const before = {
      index: Array.from(base.getIndex()!.array),
      position: Array.from(base.getAttribute('position').array),
    };
    await generateLods(base, { ratios: [0.5, 0.2] });
    expect(Array.from(base.getIndex()!.array)).toEqual(before.index);
    expect(Array.from(base.getAttribute('position').array)).toEqual(before.position);
    expect(lodsOf(base)).toEqual([]);
  });
});

describe('prepareLods', () => {
  it('attaches LODs to every distinct geometry under a root once and exposes them through lodsOf', async () => {
    const scene = new Scene();
    const shared = new TorusKnotGeometry(1, 0.3, 64, 12);
    scene.add(
      tag.static(new Mesh(shared, new MeshStandardMaterial())),
      tag.static(new Mesh(shared, new MeshStandardMaterial())),
    );
    scene.add(tag.static(new Mesh(new SphereGeometry(1, 16, 12), new MeshStandardMaterial())));
    const report = await prepareLods(scene, { ratios: [0.5, 0.2] });
    expect(report.geometries).toBe(2);
    expect(lodsOf(shared)).toHaveLength(2);
    const again = await prepareLods(scene, { ratios: [0.5, 0.2] });
    expect(again.geometries).toBe(0);
    expect(lodsOf(shared)).toHaveLength(2);
  });

  it('returns an empty list for geometries without LODs', () => {
    expect(lodsOf(new SphereGeometry())).toEqual([]);
  });
});

describe('disposeLods', () => {
  it('disposes and drops every attached level and leaves the geometry alone', async () => {
    const base = new SphereGeometry(1, 16, 12);
    base.userData.forgeLods = await generateLods(base, { ratios: [0.5, 0.2] });
    const levels = lodsOf(base);
    expect(levels).toHaveLength(2);
    const disposed = levels.map((g) => vi.spyOn(g, 'dispose'));
    const baseDispose = vi.spyOn(base, 'dispose');
    expect(disposeLods(base)).toBe(2);
    for (const spy of disposed) expect(spy).toHaveBeenCalledTimes(1);
    expect(baseDispose, 'the source geometry is the caller’s').not.toHaveBeenCalled();
    expect(lodsOf(base), 'and is left without levels, so prepareLods can attach fresh ones').toEqual([]);
    expect(disposeLods(base), 'a second call has nothing left to dispose').toBe(0);
    expect(disposeLods(new SphereGeometry()), 'a geometry that never had levels').toBe(0);
  });
});
