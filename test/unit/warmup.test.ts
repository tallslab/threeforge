import { describe, expect, it } from 'vitest';
import { BoxGeometry, DataTexture, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera, RGBAFormat, Scene, WebGLCoordinateSystem, WebGPUCoordinateSystem } from 'three';
import { World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';

const box = new BoxGeometry();

function fakeRenderer(coordinateSystem: number) {
  const calls: string[] = [];
  return {
    calls,
    coordinateSystem,
    async compileAsync() {
      calls.push('compileAsync');
    },
    initTexture() {
      calls.push('initTexture');
    },
  };
}

describe('World.warmup', () => {
  it('compiles shaders and uploads textures on WebGL', async () => {
    const scene = new Scene();
    scene.add(tag.static(new Mesh(box, new MeshStandardMaterial({ map: new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat) }))));
    const world = new World(scene);
    world.compile();
    const renderer = fakeRenderer(WebGLCoordinateSystem);
    const result = await world.warmup(renderer as never, new PerspectiveCamera());
    expect(renderer.calls).toEqual(['initTexture', 'compileAsync']);
    expect(result).toEqual({ compiled: true, textures: 1, skipped: null });
  });

  it('skips compileAsync on every backend when the scene has transmissive materials (three r186 renders them wrong afterwards)', async () => {
    const scene = new Scene();
    scene.add(new Mesh(box, new MeshPhysicalMaterial({ transmission: 0.9 })), tag.static(new Mesh(box, new MeshStandardMaterial())));
    const world = new World(scene);
    world.compile();
    for (const cs of [WebGPUCoordinateSystem, WebGLCoordinateSystem]) {
      const renderer = fakeRenderer(cs);
      const result = await world.warmup(renderer as never, new PerspectiveCamera());
      expect(renderer.calls).toEqual([]);
      expect(result).toEqual({ compiled: false, textures: 0, skipped: 'transmission' });
    }
  });
});
