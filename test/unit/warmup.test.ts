import { describe, expect, it } from 'vitest';
import { BoxGeometry, DataTexture, DoubleSide, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera, RGBAFormat, Scene, Vector4, WebGLCoordinateSystem } from 'three';
import type { Material } from 'three';
import { World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';

const box = new BoxGeometry();

/**
 * Mirrors the parts of three's common Renderer that warm-up touches: scissor state, `render`/`renderAsync`,
 * `compileAsync`, `initTexture`. Every call is logged with the scissor state it saw.
 */
function fakeRenderer(options: { compileAsync?: boolean; renderAsync?: boolean } = {}) {
  const calls: string[] = [];
  const scissor = new Vector4(0, 0, 800, 600);
  let scissorTest = false;
  const renderer = {
    calls,
    coordinateSystem: WebGLCoordinateSystem,
    getScissor(target: Vector4) {
      return target.copy(scissor);
    },
    setScissor(x: number, y: number, w: number, h: number) {
      scissor.set(x, y, w, h);
      calls.push(`setScissor(${x},${y},${w},${h})`);
    },
    getScissorTest() {
      return scissorTest;
    },
    setScissorTest(value: boolean) {
      scissorTest = value;
      calls.push(`setScissorTest(${value})`);
    },
    render() {
      calls.push(`render scissor=${scissorTest ? scissor.toArray().join(',') : 'off'}`);
    },
    initTexture() {
      calls.push('initTexture');
    },
  } as Record<string, unknown> & { calls: string[] };
  if (options.compileAsync !== false) renderer.compileAsync = async () => void calls.push('compileAsync');
  if (options.renderAsync) renderer.renderAsync = async () => void calls.push(`renderAsync scissor=${scissorTest ? scissor.toArray().join(',') : 'off'}`);
  return renderer;
}

function disposals(...materials: Material[]): () => string[] {
  const disposed: string[] = [];
  for (const m of materials) m.addEventListener('dispose', () => disposed.push(m.name));
  return () => disposed;
}

describe('World.warmup', () => {
  it('renders one real frame inside a 1x1 scissor by default, then restores the scissor state', async () => {
    const scene = new Scene();
    scene.add(tag.static(new Mesh(box, new MeshStandardMaterial({ map: new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat) }))));
    const world = new World(scene);
    world.compile();
    const renderer = fakeRenderer();
    const result = await world.warmup(renderer as never, new PerspectiveCamera());
    expect(renderer.calls).toEqual(['initTexture', 'setScissor(0,0,1,1)', 'setScissorTest(true)', 'render scissor=0,0,1,1', 'setScissorTest(false)', 'setScissor(0,0,800,600)']);
    expect(result).toEqual({ mode: 'frame', textures: 1, repaired: 0 });
  });

  it('prefers renderAsync for the warm-up frame when the renderer has it', async () => {
    const scene = new Scene();
    scene.add(tag.static(new Mesh(box, new MeshStandardMaterial())));
    const world = new World(scene);
    world.compile();
    const renderer = fakeRenderer({ renderAsync: true });
    await world.warmup(renderer as never, new PerspectiveCamera());
    expect(renderer.calls).toContain('renderAsync scissor=0,0,1,1');
    expect(renderer.calls.some((c) => c.startsWith('render '))).toBe(false);
  });

  it('async mode pre-compiles with compileAsync, then rebuilds the materials three renders in two passes or through a viewport texture', async () => {
    const scene = new Scene();
    const foliage = new MeshStandardMaterial({ name: 'foliage', transparent: true, side: DoubleSide });
    const glass = new MeshPhysicalMaterial({ name: 'glass', transmission: 0.9 });
    const singlePass = new MeshStandardMaterial({ name: 'single-pass', transparent: true, side: DoubleSide, forceSinglePass: true });
    const opaque = new MeshStandardMaterial({ name: 'opaque' });
    scene.add(new Mesh(box, foliage), new Mesh(box, glass), new Mesh(box, singlePass), tag.static(new Mesh(box, opaque)));
    const world = new World(scene);
    world.compile();
    const disposed = disposals(foliage, glass, singlePass, opaque);
    const renderer = fakeRenderer();
    const result = await world.warmup(renderer as never, new PerspectiveCamera(), { mode: 'async' });
    expect(disposed().sort()).toEqual(['foliage', 'glass']);
    expect(renderer.calls).toEqual(['compileAsync', 'setScissor(0,0,1,1)', 'setScissorTest(true)', 'render scissor=0,0,1,1', 'setScissorTest(false)', 'setScissor(0,0,800,600)']);
    expect(result).toEqual({ mode: 'async', textures: 0, repaired: 2 });
  });

  it('async mode falls back to the frame when the renderer has no compileAsync', async () => {
    const scene = new Scene();
    scene.add(tag.static(new Mesh(box, new MeshStandardMaterial())));
    const world = new World(scene);
    world.compile();
    const renderer = fakeRenderer({ compileAsync: false });
    const result = await world.warmup(renderer as never, new PerspectiveCamera(), { mode: 'async' });
    expect(renderer.calls.filter((c) => c === 'compileAsync')).toEqual([]);
    expect(result.mode).toBe('frame');
  });
});
