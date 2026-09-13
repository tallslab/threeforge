import { describe, expect, it } from 'vitest';
import { BatchedMesh, BoxGeometry, Mesh, MeshStandardMaterial, Scene } from 'three';
import { World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';

const box = new BoxGeometry(1, 1, 1);

function line(count: number, spacing: number): { scene: Scene; meshes: Mesh[] } {
  const scene = new Scene();
  const meshes = Array.from({ length: count }, (_, i) => {
    const m = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x336699 })));
    m.name = `m-${i}`;
    m.position.set(i * spacing, 0, 0);
    scene.add(m);
    return m;
  });
  return { scene, meshes };
}

function batchesIn(scene: Scene): BatchedMesh[] {
  const out: BatchedMesh[] = [];
  scene.traverse((o) => {
    if ((o as BatchedMesh).isBatchedMesh) out.push(o as BatchedMesh);
  });
  return out;
}

describe('World chunkSize', () => {
  it('splits a material group into one batch per world-space cell', () => {
    const { scene } = line(8, 10); // x = 0..70
    const report = new World(scene, { chunkSize: 20 }).compile();
    const batches = batchesIn(scene);
    expect(batches).toHaveLength(4);
    expect(batches.map((b) => b.instanceCount)).toEqual([2, 2, 2, 2]);
    expect(report.groups.map((g) => g.chunk)).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ]);
  });

  it('keeps one batch per group when chunkSize is not set and reports chunk as null', () => {
    const { scene } = line(8, 10);
    const report = new World(scene).compile();
    expect(batchesIn(scene)).toHaveLength(1);
    expect(report.groups[0]?.chunk).toBeNull();
  });

  it('leaves a lone mesh in a cell as a plain mesh (no single-instance batches)', () => {
    const { scene } = line(3, 30); // x = 0, 30, 60 -> three cells of one
    const report = new World(scene, { chunkSize: 20 }).compile();
    expect(batchesIn(scene)).toHaveLength(0);
    expect(report.after.meshes).toBe(3);
    expect(report.skipped.every((s) => s.rule === 'singleton')).toBe(true);
  });

  it('gives each chunk batch its own tight bounds so whole chunks can be frustum-culled', () => {
    const { scene } = line(8, 10);
    new World(scene, { chunkSize: 20 }).compile();
    for (const b of batchesIn(scene)) {
      expect(b.boundingSphere!.radius).toBeLessThan(12);
    }
  });
});
