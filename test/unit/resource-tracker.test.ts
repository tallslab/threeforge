import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, DataTexture, Group, Mesh, MeshStandardMaterial, RGBAFormat, Scene, SphereGeometry, UnsignedByteType } from 'three';
import { ResourceTracker } from '../../src/memory/ResourceTracker.js';
import { collectResources, unreferencedResources } from '../../src/memory/resources.js';

const tex = () => new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat, UnsignedByteType);

describe('collectResources', () => {
  it('walks geometries, material arrays, texture properties and the scene background', () => {
    const scene = new Scene();
    const map = tex();
    const env = tex();
    scene.background = env;
    const geometry = new BoxGeometry();
    scene.add(new Mesh(geometry, [new MeshStandardMaterial({ map }), new MeshStandardMaterial()]), new Mesh(geometry, new MeshStandardMaterial({ map })));
    const r = collectResources(scene);
    expect(r.geometries.size).toBe(1);
    expect(r.materials.size).toBe(3);
    expect([...r.textures]).toEqual(expect.arrayContaining([map, env]));
    expect(r.textures.size).toBe(2);
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
  it('counts renderer-held resources the scene no longer reaches, minus an allowance, never below zero', () => {
    const scene = new Scene();
    scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map: tex() })));
    expect(unreferencedResources({ geometries: 3, textures: 4 }, scene)).toEqual({ geometries: 2, textures: 3 });
    expect(unreferencedResources({ geometries: 3, textures: 4 }, scene, { textures: 2 })).toEqual({ geometries: 2, textures: 1 });
    expect(unreferencedResources({ geometries: 0, textures: 0 }, scene)).toEqual({ geometries: 0, textures: 0 });
  });
});
