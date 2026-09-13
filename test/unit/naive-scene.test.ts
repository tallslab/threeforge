import { describe, expect, it } from 'vitest';
import { Mesh, MeshStandardMaterial, SkinnedMesh } from 'three';
import { buildNaiveScene, NAIVE_SCENE } from '../../test/scenes/naive.js';
import { tag } from '../../src/tags.js';

describe('buildNaiveScene', () => {
  const built = buildNaiveScene(1);
  const meshes: Mesh[] = [];
  built.scene.traverse((o) => {
    if ((o as Mesh).isMesh) meshes.push(o as Mesh);
  });

  it('has 500 props, one ground plane and two skinned dummies', () => {
    expect(built.props).toHaveLength(NAIVE_SCENE.propCount);
    expect(NAIVE_SCENE.propCount).toBe(500);
    expect(built.skinned).toHaveLength(2);
    expect(built.skinned.every((m) => m instanceof SkinnedMesh)).toBe(true);
    expect(meshes).toHaveLength(503);
  });

  it('creates a new material instance per prop from 40 recipes (the naive part)', () => {
    const materials = new Set(built.props.map((p) => p.material));
    expect(materials.size).toBe(500);
    expect(NAIVE_SCENE.recipeCount).toBe(40);
    expect(built.props.every((p) => p.material instanceof MeshStandardMaterial)).toBe(true);
  });

  it('shares 12 base geometries across the props, some of them non-indexed', () => {
    const geometries = new Set(built.props.map((p) => p.geometry));
    expect(geometries.size).toBe(12);
    const nonIndexed = [...geometries].filter((g) => g.index === null);
    expect(nonIndexed.length).toBeGreaterThan(0);
    for (const g of geometries) {
      expect(Object.keys(g.attributes).sort()).toEqual(['normal', 'position', 'uv']);
    }
  });

  it('tags 490 props static and 10 dynamic; ground is static; skinned are untagged', () => {
    const statics = built.props.filter((p) => tag.of(p) === 'static');
    const dynamics = built.props.filter((p) => tag.of(p) === 'dynamic');
    expect(statics).toHaveLength(490);
    expect(dynamics).toHaveLength(10);
    expect(built.dynamics).toHaveLength(10);
    expect(tag.of(built.ground)).toBe('static');
    expect(built.skinned.every((m) => tag.of(m) === undefined)).toBe(true);
  });

  it('is deterministic for a seed and differs across seeds', () => {
    const again = buildNaiveScene(1);
    const other = buildNaiveScene(2);
    const pos = (b: typeof built) => b.props.map((p) => p.position.toArray().map((v) => v.toFixed(4)).join(','));
    expect(pos(again)).toEqual(pos(built));
    expect(pos(other)).not.toEqual(pos(built));
  });
});
