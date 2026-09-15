import { describe, expect, it, vi } from 'vitest';
import { DodecahedronGeometry, Mesh, MeshStandardMaterial, Scene, SphereGeometry, TorusKnotGeometry, type BufferGeometry } from 'three';
import { disposeLods, generateLods, lodsOf, prepareLods } from '../../src/lod/generateLods.js';
import { tag } from '../../src/tags.js';

describe('generateLods', () => {
  it('produces one geometry per ratio with roughly that share of the triangles and the same attributes', async () => {
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

  it('never returns a level with more triangles than the previous one, even when the simplifier stalls', async () => {
    const base = new SphereGeometry(1, 8, 6); // tiny: simplifier may refuse to go below a floor
    const lods = await generateLods(base, { ratios: [0.5, 0.25, 0.1] });
    let previous = base.index!.count;
    for (const lod of lods) {
      expect(lod.index!.count).toBeLessThanOrEqual(previous);
      previous = lod.index!.count;
    }
  });
});

describe('prepareLods', () => {
  it('attaches LODs to every distinct geometry under a root once and exposes them through lodsOf', async () => {
    const scene = new Scene();
    const shared = new TorusKnotGeometry(1, 0.3, 64, 12);
    scene.add(tag.static(new Mesh(shared, new MeshStandardMaterial())), tag.static(new Mesh(shared, new MeshStandardMaterial())));
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
  it('disposes every attached level, drops them from the geometry, and leaves the geometry itself alone', async () => {
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
