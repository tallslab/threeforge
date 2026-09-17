import {
  type BoxGeometry,
  CylinderGeometry,
  type DodecahedronGeometry,
  type Material,
  Mesh,
  type MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
} from 'three';
import { describe, expect, it } from 'vitest';
import { World } from '../../src/compiler/World.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer } from './helpers/fakeRenderer.js';
import { batchesIn, box, dodeca, meshesIn, mixedScene, solid } from './helpers/worldScene.js';

const OWN = (object: object, key: string): boolean => Object.hasOwn(object, key);

describe('World materials option', () => {
  it("keeps every mesh's own material instance with materials: 'keep'", () => {
    const scene = new Scene();
    const a = tag.dynamic(new Mesh(box, solid(0xabcdef)));
    const b = tag.dynamic(new Mesh(box, solid(0xabcdef)));
    scene.add(a, b);
    const materialB = b.material;
    new World(scene, { materials: 'keep' }).compile();
    expect(b.material).toBe(materialB);
    expect(a.material).not.toBe(b.material);
  });
});

describe('World material ownership', () => {
  /** Counts the `dispose` events three's `Material.dispose()` dispatches, per material. */
  function disposeCounts(materials: Material[]): Map<Material, number> {
    const counts = new Map<Material, number>();
    for (const material of materials) {
      counts.set(material, 0);
      material.addEventListener('dispose', () => counts.set(material, counts.get(material)! + 1));
    }
    return counts;
  }

  it('never disposes a registered material the compiler shared with a batch or an instanced group (decompile, dispose); it disposes the clones it made', () => {
    const registry = new MaterialRegistry();
    // App code registers its materials. Every instance white: the batch and the instanced group draw with these very objects.
    const sharedBatch = registry.register(solid(0xffffff, { roughness: 0.3 }));
    const sharedInstanced = registry.register(solid(0xffffff, { roughness: 0.5 }));
    const scene = new Scene();
    const add = (
      material: Material,
      geometry: BoxGeometry | DodecahedronGeometry | CylinderGeometry,
      n: number,
      z: number,
    ): Mesh[] =>
      Array.from({ length: n }, (_, i) => {
        const mesh = tag.static(new Mesh(geometry, material));
        mesh.position.set(i * 2, 0, z);
        scene.add(mesh);
        return mesh;
      });
    const batchOriginals = add(sharedBatch, box, 2, 0);
    const instancedOriginals = add(sharedInstanced, dodeca, 4, 4);
    // Tinted groups: a white clone carries the per-instance colours, owned by the World.
    const cylinder = new CylinderGeometry(0.4, 0.4, 1, 8);
    add(registry.register(solid(0xff0000, { roughness: 0.9 })), cylinder, 1, 8);
    add(registry.register(solid(0x00ff00, { roughness: 0.9 })), cylinder, 1, 10);
    for (const color of [0x0000ff, 0xffff00])
      add(registry.register(solid(color, { roughness: 0.1 })), box, 2, color === 0x0000ff ? 12 : 14);
    const world = new World(scene, { registry, instanceThreshold: 4 });
    world.compile();
    const drawn = [...world.batchedMeshes, ...world.instancedMeshes].map((m) => m.material as Material);
    expect(world.batchedMeshes.map((b) => b.material)).toContain(sharedBatch);
    expect(world.instancedMeshes.map((m) => m.material)).toContain(sharedInstanced);
    const clones = drawn.filter((m) => m !== sharedBatch && m !== sharedInstanced);
    expect(clones, 'one batch clone and one instanced clone').toHaveLength(2);
    const counts = disposeCounts([sharedBatch, sharedInstanced, ...clones]);

    world.decompile();
    expect([counts.get(sharedBatch), counts.get(sharedInstanced)], 'shared materials disposed on decompile').toEqual([
      0, 0,
    ]);
    expect(
      clones.map((m) => counts.get(m)! > 0),
      'clones disposed on decompile',
    ).toEqual([true, true]);
    expect(
      batchOriginals.every((m) => m.material === sharedBatch) &&
        instancedOriginals.every((m) => m.material === sharedInstanced),
    ).toBe(true);

    // Still usable: the next compile shares them again, and dispose() leaves them alone but frees that compile's clones.
    world.compile();
    expect(world.batchedMeshes.map((b) => b.material)).toContain(sharedBatch);
    expect(world.instancedMeshes.map((m) => m.material)).toContain(sharedInstanced);
    const secondClones = [...world.batchedMeshes, ...world.instancedMeshes]
      .map((m) => m.material as Material)
      .filter((m) => m !== sharedBatch && m !== sharedInstanced);
    expect(secondClones, 'the second compile made its own clones').toHaveLength(2);
    expect(secondClones.some((m) => clones.includes(m))).toBe(false);
    const secondCounts = disposeCounts(secondClones);
    world.dispose();
    expect([counts.get(sharedBatch), counts.get(sharedInstanced)], 'shared materials disposed on dispose').toEqual([
      0, 0,
    ]);
    expect(
      secondClones.map((m) => secondCounts.get(m)! > 0),
      "the second compile's clones disposed on dispose",
    ).toEqual([true, true]);
  });

  it("never disposes the originals' own material: materials: 'keep' batches with it, and an unsupported ShaderMaterial is never batched", () => {
    for (const mode of ['unsupported', 'keep'] as const) {
      const scene = new Scene();
      const material: Material = mode === 'unsupported' ? new ShaderMaterial() : solid(0xffffff, { roughness: 0.4 });
      for (let i = 0; i < 3; i++) {
        const mesh = tag.static(new Mesh(box, material));
        mesh.position.set(i * 2, 0, 0);
        scene.add(mesh);
      }
      const world = new World(scene, mode === 'keep' ? { materials: 'keep' } : {});
      const report = world.compile();
      if (mode === 'keep') {
        expect(
          world.batchedMeshes.map((b) => b.material),
          "keep: the batch draws with the originals' material",
        ).toEqual([material]);
      } else {
        // classify excludes ShaderMaterial and RawShaderMaterial, the only materials the registry marks unsupported, so the
        // ownership pass's `o.material === material` branch is defensive: no World batch can draw with such a material.
        expect(world.batchedMeshes, 'unsupported: batches').toHaveLength(0);
        expect(new Set(report.skipped.map((s) => s.rule)), 'unsupported: rule').toEqual(new Set(['shader-material']));
      }
      const counts = disposeCounts([material]);
      world.decompile();
      expect(counts.get(material), `${mode}: disposed on decompile`).toBe(0);
      world.compile();
      world.dispose();
      expect(counts.get(material), `${mode}: disposed on dispose`).toBe(0);
    }
  });
});

describe('World.dispose', () => {
  it('decompiles first (listeners hear it), clears the dirty listeners, uninstalls the pass tracker hooks, and is safe to call twice', () => {
    const { scene } = mixedScene();
    const world = new World(scene);
    const events: string[] = [];
    const off = world.onDirty((e) => events.push(e.kind));
    world.compile();
    expect(OWN(scene, 'onBeforeRender') && OWN(scene, 'onAfterRender'), 'pass tracker hooks installed').toBe(true);
    world.dispose();
    expect(events).toEqual(['compile', 'decompile']);
    expect(batchesIn(scene)).toHaveLength(0);
    expect(meshesIn(scene)).toHaveLength(9);
    expect(OWN(scene, 'onBeforeRender') || OWN(scene, 'onAfterRender'), 'pass tracker hooks removed').toBe(false);
    expect((world as unknown as { dirtyListeners: Set<unknown> }).dirtyListeners.size).toBe(0);
    expect(world.mainCamera).toBeNull();
    world.dispose();
    world.decompile();
    off();
    expect(events).toEqual(['compile', 'decompile']);
  });

  it('refuses a recompile from a decompile listener while disposing: no scene hook or batch is left behind', () => {
    const { scene } = mixedScene();
    const world = new World(scene);
    const errors: string[] = [];
    world.onDirty((e) => {
      if (e.kind !== 'decompile') return;
      try {
        world.compile();
      } catch (error) {
        errors.push((error as Error).message);
      }
    });
    world.compile();
    world.dispose();
    expect(OWN(scene, 'onBeforeRender') || OWN(scene, 'onAfterRender'), 'pass tracker hooks left installed').toBe(
      false,
    );
    expect(batchesIn(scene)).toHaveLength(0);
    expect(errors).toEqual([expect.stringContaining('World is disposed')]);
    expect(() => world.compile()).toThrow('World is disposed');
  });

  it('throws a clear error on compile, markDirty, setVisible, onDirty and warmup after dispose', async () => {
    const { scene, statics } = mixedScene();
    const world = new World(scene);
    world.dispose(); // never compiled: nothing to decompile
    expect(() => world.compile()).toThrow('World is disposed');
    expect(() => world.markDirty(statics[0]!)).toThrow('World is disposed');
    expect(() => world.setVisible(statics[0]!, false)).toThrow('World is disposed');
    expect(() => world.onDirty(() => {})).toThrow('World is disposed');
    await expect(world.warmup(new FakeRenderer() as never, new PerspectiveCamera())).rejects.toThrow(
      'World is disposed',
    );
    expect(statics[0]!.visible).toBe(true);
  });
});

describe('World and the material registry on decompile', () => {
  /** Counts the `dispose` events three's `Material.dispose()` dispatches for one material. */
  function disposes(material: Material): () => number {
    let n = 0;
    material.addEventListener('dispose', () => n++);
    return () => n;
  }

  /** Three tinted statics of one variant: the batch draws with a white clone the World owns and disposes. */
  function tintedBatch(registry: MaterialRegistry) {
    const scene = new Scene();
    [0xff0000, 0x00ff00, 0x0000ff].forEach((color, i) => {
      const mesh = tag.static(new Mesh(box, registry.register(solid(color))));
      mesh.position.set(i * 2, 0, 0);
      scene.add(mesh);
    });
    const world = new World(scene, { registry });
    world.compile();
    return { world, clone: world.batchedMeshes[0]!.material as MeshStandardMaterial };
  }

  it('forgets a material it disposes, so the registry never hands out a disposed one', () => {
    const registry = new MaterialRegistry();
    const { world, clone } = tintedBatch(registry);
    // The batch material is reachable through `world.batchedMeshes`, so app code can register it.
    expect(registry.register(clone)).toBe(clone);
    expect(registry.describe(clone).outcome).not.toBe('unregistered');
    const count = disposes(clone);
    world.decompile();
    expect(count(), 'still disposed, as the World created it').toBe(1);
    expect(registry.describe(clone).outcome, 'and forgotten first').toBe('unregistered');
    expect(registry.canonicalOf(clone)).toBeUndefined();
  });

  it('keeps and never disposes a material a live registered material still merges into', () => {
    const registry = new MaterialRegistry();
    const { world, clone } = tintedBatch(registry);
    expect(registry.register(clone)).toBe(clone);
    const twin = clone.clone();
    expect(registry.register(twin), 'an identical material merges into the clone').toBe(clone);
    const count = disposes(clone);
    world.decompile();
    expect(count(), 'disposing it would break every mesh drawn with the twin').toBe(0);
    expect(registry.canonicalOf(twin), 'which still resolves to it').toBe(clone);
    expect(registry.describe(clone).outcome).not.toBe('unregistered');
  });
});
