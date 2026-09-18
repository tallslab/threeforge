import {
  BatchedMesh,
  BoxGeometry,
  BufferGeometry,
  DataTexture,
  Group,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  type Material,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  Scene,
  SphereGeometry,
  Sprite,
  type Texture,
  UnsignedByteType,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ResourceTracker } from '../../src/memory/ResourceTracker.js';
import {
  collectResources,
  disposeGeometry,
  emptyResourceSets,
  unreferencedResources,
} from '../../src/memory/resources.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';

const tex = () => new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat, UnsignedByteType);

describe('collectResources', () => {
  it('walks geometries, material arrays, texture properties and the scene background', () => {
    const scene = new Scene();
    const map = tex();
    const env = tex();
    scene.background = env;
    const geometry = new BoxGeometry();
    scene.add(
      new Mesh(geometry, [new MeshStandardMaterial({ map }), new MeshStandardMaterial()]),
      new Mesh(geometry, new MeshStandardMaterial({ map })),
    );
    const r = collectResources(scene);
    expect(r.geometries.size).toBe(1);
    expect(r.materials.size).toBe(3);
    expect([...r.textures]).toEqual(expect.arrayContaining([map, env]));
    expect(r.textures.size).toBe(2);
  });

  it('collects userData.forgeTextures, BatchedMesh and bone textures', () => {
    const node = tex();
    const material = new MeshStandardMaterial();
    material.userData.forgeTextures = [node];
    const batch = new BatchedMesh(4, 64, 96, new MeshStandardMaterial());
    const root = new Group().add(new Mesh(new BoxGeometry(), material), batch);
    const r = collectResources(root);
    expect(r.textures.has(node)).toBe(true);
    expect(r.textures.has((batch as unknown as { _matricesTexture: Texture })._matricesTexture)).toBe(true);
    expect(r.textures.size).toBeGreaterThanOrEqual(3);
  });

  it('reads a shared material once and still collects textures of filed materials', () => {
    const map = tex();
    const geometry = new BoxGeometry();
    const shared = new MeshStandardMaterial({ map });
    const other = new MeshStandardMaterial();
    const root = new Group();
    for (let i = 0; i < 50; i++) root.add(new Mesh(geometry, i % 2 ? shared : [other, shared]));
    const values = vi.spyOn(Object, 'values');
    const r = collectResources(root);
    const materialReads = values.mock.calls.filter(
      ([v]) => (v as { isMaterial?: boolean } | null)?.isMaterial === true,
    ).length;
    values.mockRestore();
    expect(materialReads).toBe(2);
    expect(r.materials.size).toBe(2);
    expect([...r.textures]).toEqual([map]);
    // ResourceTracker.track(material) files a material without its textures; a later walk still collects them.
    const sets = emptyResourceSets();
    sets.materials.add(shared);
    collectResources(root, sets);
    expect(sets.textures.has(map)).toBe(true);
  });
});

describe('ResourceTracker', () => {
  it('releases what only the released owner holds, keeps shared textures, and detaches the root', () => {
    const scene = new Scene();
    const shared = tex();
    const a = new Group();
    const b = new Group();
    const geometryA = new BoxGeometry();
    const geometryB = new SphereGeometry();
    a.add(new Mesh(geometryA, new MeshStandardMaterial({ map: shared })));
    b.add(new Mesh(geometryB, new MeshStandardMaterial({ map: shared })));
    scene.add(a, b);
    const disposedTexture = vi.spyOn(shared, 'dispose');
    const disposedA = vi.spyOn(geometryA, 'dispose');
    const tracker = new ResourceTracker();
    tracker.track(a).track(b);
    expect(tracker.stats()).toEqual({ owners: 2, geometries: 2, materials: 2, textures: 1 });
    expect(tracker.release(a)).toEqual({ geometries: 1, materials: 1, textures: 0 });
    expect(a.parent).toBeNull();
    expect(disposedA).toHaveBeenCalledTimes(1);
    expect(disposedTexture).not.toHaveBeenCalled();
    tracker.release(b);
    expect(disposedTexture).toHaveBeenCalledTimes(1);
    expect(tracker.stats().owners).toBe(0);
  });

  it('never disposes a material the registry knows', () => {
    const material = new MeshStandardMaterial();
    const registry = { canonicalOf: (m: unknown) => (m === material ? material : undefined) };
    const spy = vi.spyOn(material, 'dispose');
    const root = new Group().add(new Mesh(new BoxGeometry(), material));
    new ResourceTracker({ registry }).track(root).release(root);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('unreferencedResources', () => {
  it('counts unreachable renderer resources minus an allowance, never below zero', () => {
    const scene = new Scene();
    scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map: tex() })));
    expect(unreferencedResources({ geometries: 3, textures: 4 }, scene)).toEqual({ geometries: 2, textures: 3 });
    expect(unreferencedResources({ geometries: 3, textures: 4 }, scene, { textures: 2 })).toEqual({
      geometries: 2,
      textures: 1,
    });
    expect(unreferencedResources({ geometries: 0, textures: 0 }, scene)).toEqual({ geometries: 0, textures: 0 });
  });
});

describe('the geometry every Sprite shares', () => {
  it('is never disposed by release: sprites elsewhere still draw it', () => {
    const owner = new Group().add(new Sprite(), new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    const shared = vi.spyOn(new Sprite().geometry, 'dispose');
    const tracker = new ResourceTracker().track(owner);
    expect(tracker.release(owner).geometries).toBe(1);
    expect(shared).not.toHaveBeenCalled();
    shared.mockRestore();
  });
});

describe('interleaved geometries', () => {
  const packed = (buffer: InterleavedBuffer): BufferGeometry =>
    new BufferGeometry()
      .setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0))
      .setAttribute('uv', new InterleavedBufferAttribute(buffer, 2, 3, true));
  const triangle = () => new InterleavedBuffer(new Float32Array(15), 5);
  const bufferOf = (g: BufferGeometry) => (g.getAttribute('position') as InterleavedBufferAttribute).data;

  it('disposeGeometry renews interleaved attributes and leaves plain ones alone', () => {
    const geometry = packed(triangle());
    const plain = new BoxGeometry().getAttribute('normal');
    geometry.setAttribute('normal', plain);
    const uv = geometry.getAttribute('uv') as InterleavedBufferAttribute;
    const disposed = vi.spyOn(geometry, 'dispose');
    disposeGeometry(geometry);
    expect(disposed).toHaveBeenCalledTimes(1);
    const renewed = geometry.getAttribute('uv') as InterleavedBufferAttribute;
    expect(renewed).not.toBe(uv);
    expect([renewed.itemSize, renewed.offset, renewed.normalized]).toEqual([2, 3, true]);
    expect(renewed.data).toBe(bufferOf(geometry));
    expect(renewed.data.array).toBe(uv.data.array);
    expect(geometry.getAttribute('normal')).toBe(plain);
  });

  it('a reference taken before the disposal still drives uploads', () => {
    const geometry = packed(triangle());
    const stale = geometry.getAttribute('position') as InterleavedBufferAttribute;
    const staleBuffer = stale.data;
    disposeGeometry(geometry);
    const live = bufferOf(geometry);
    const version = live.version;
    // three uploads when the live buffer's version moves; both old objects have to move it.
    stale.needsUpdate = true;
    expect(live.version).toBe(version + 1);
    staleBuffer.needsUpdate = true;
    expect(live.version).toBe(version + 2);
    staleBuffer.addUpdateRange(0, 5);
    expect(live.updateRanges).toEqual([{ start: 0, count: 5 }]);
  });

  it('release finds the scene from an attached owner, without being given one', () => {
    const buffer = triangle();
    const scene = new Scene();
    const untracked = new Mesh(packed(buffer), new MeshStandardMaterial());
    const level = new Group();
    const owner = new Group().add(new Mesh(packed(buffer), new MeshStandardMaterial()));
    scene.add(untracked, level.add(owner));
    const disposed = vi.spyOn((owner.children[0] as Mesh).geometry, 'dispose');
    const tracker = new ResourceTracker().track(owner);
    expect(tracker.release(owner).geometries).toBe(0);
    expect(disposed).not.toHaveBeenCalled();
    expect(owner.parent).toBeNull();
  });

  it('release leaves a geometry whose buffer a mesh in the given scene still draws from', () => {
    const buffer = triangle();
    const scene = new Scene();
    const untracked = new Mesh(packed(buffer), new MeshStandardMaterial());
    const owner = new Group().add(new Mesh(packed(buffer), new MeshStandardMaterial()));
    scene.add(untracked, owner);
    const disposed = vi.spyOn((owner.children[0] as Mesh).geometry, 'dispose');
    const tracker = new ResourceTracker({ scene }).track(owner);
    expect(tracker.release(owner).geometries).toBe(0);
    expect(disposed).not.toHaveBeenCalled();
  });

  it('release frees a geometry once the owner sharing its buffer is released too', () => {
    const buffer = triangle();
    const a = new Group().add(new Mesh(packed(buffer), new MeshStandardMaterial()));
    const b = new Group().add(new Mesh(packed(buffer), new MeshStandardMaterial()));
    const geometryA = (a.children[0] as Mesh).geometry;
    const disposedA = vi.spyOn(geometryA, 'dispose');
    const tracker = new ResourceTracker().track(a).track(b);
    // Disposing it now would destroy the buffer b still draws from.
    expect(tracker.release(a).geometries).toBe(0);
    expect(disposedA).not.toHaveBeenCalled();
    expect(tracker.release(b).geometries).toBe(2);
    expect(disposedA).toHaveBeenCalledTimes(1);
    expect(bufferOf(geometryA)).toBe(bufferOf((b.children[0] as Mesh).geometry));
  });
});

describe('ResourceTracker and the material registry', () => {
  const owned = (material: Material) => new Group().add(new Mesh(new BoxGeometry(), material));

  it('forgets a released material the registry knows, without disposing it', () => {
    const registry = new MaterialRegistry();
    const material = registry.register(new MeshStandardMaterial({ color: 0x223344 }));
    const spy = vi.spyOn(material, 'dispose');
    const root = owned(material);
    const tracker = new ResourceTracker({ registry }).track(root);
    expect(tracker.release(root).materials, 'a registered material is still never disposed here').toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(registry.describe(material).outcome, 'but the registry no longer holds it').toBe('unregistered');
    expect(registry.stats().registered).toBe(0);
  });

  it('forgets the materials merged into a canonical before the canonical itself', () => {
    const registry = new MaterialRegistry();
    const canonical = registry.register(new MeshStandardMaterial({ color: 0x556677, roughness: 0.25 }));
    const duplicate = new MeshStandardMaterial({ color: 0x556677, roughness: 0.25 });
    expect(registry.register(duplicate)).toBe(canonical);
    const root = new Group().add(new Mesh(new BoxGeometry(), canonical), new Mesh(new BoxGeometry(), duplicate));
    new ResourceTracker({ registry }).track(root).release(root);
    expect(registry.describe(duplicate).outcome).toBe('unregistered');
    expect(registry.describe(canonical).outcome, 'forgotten last, once nothing merged into it was left').toBe(
      'unregistered',
    );
    expect(registry.stats().registered).toBe(0);
  });

  it('keeps a canonical a live duplicate still merges into', () => {
    const registry = new MaterialRegistry();
    const canonical = registry.register(new MeshStandardMaterial({ color: 0x113355, roughness: 0.75 }));
    const duplicate = new MeshStandardMaterial({ color: 0x113355, roughness: 0.75 });
    expect(registry.register(duplicate)).toBe(canonical);
    const released = owned(canonical);
    const kept = owned(duplicate);
    const tracker = new ResourceTracker({ registry }).track(released).track(kept);
    tracker.release(released);
    expect(registry.canonicalOf(duplicate), 'the live duplicate still resolves to it').toBe(canonical);
    expect(registry.describe(canonical).outcome, 'so the canonical stays registered').not.toBe('unregistered');
  });

  it('works with a registry that only offers canonicalOf', () => {
    const material = new MeshStandardMaterial();
    const registry = { canonicalOf: (m: unknown) => (m === material ? material : undefined) };
    const spy = vi.spyOn(material, 'dispose');
    const root = owned(material);
    expect(new ResourceTracker({ registry }).track(root).release(root).materials).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ResourceTracker with a partial registry', () => {
  it('forgets merged duplicates but never a canonical when the registry offers no dependentsOf', () => {
    const registry = new MaterialRegistry();
    const canonical = registry.register(new MeshStandardMaterial({ color: 0x778899, roughness: 0.4 }));
    const duplicate = new MeshStandardMaterial({ color: 0x778899, roughness: 0.4 });
    expect(registry.register(duplicate)).toBe(canonical);
    const forgotten: Material[] = [];
    const stub = {
      canonicalOf: (m: Material): Material | undefined => registry.canonicalOf(m),
      forget: (m: Material): void => {
        forgotten.push(m);
        registry.forget(m);
      },
    };
    const root = new Group().add(new Mesh(new BoxGeometry(), canonical), new Mesh(new BoxGeometry(), duplicate));
    new ResourceTracker({ registry: stub }).track(root).release(root);
    expect(forgotten, 'a canonical cannot be shown free without dependentsOf').toEqual([duplicate]);
  });
});
