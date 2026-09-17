import type { Camera, Material } from 'three';
import {
  BoxGeometry,
  DataTexture,
  DoubleSide,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  Vector4,
  WebGLCoordinateSystem,
} from 'three';
import { describe, expect, it } from 'vitest';
import { World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer } from './helpers/fakeRenderer.js';
import { attachedLedger } from './helpers/ledger.js';

const box = new BoxGeometry();

/**
 * Mirrors the parts of three's common Renderer that warm-up touches: scissor state, `render`/`renderAsync`,
 * `compileAsync`, `initTexture`. Every call is logged with the scissor state it saw.
 */
function fakeRenderer(options: { compileAsync?: boolean; renderAsync?: boolean; init?: boolean } = {}) {
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
  if (options.init) {
    renderer.init = async () => {
      calls.push('init');
      await Promise.resolve();
      calls.push('init resolved');
    };
  }
  if (options.compileAsync !== false) renderer.compileAsync = async () => void calls.push('compileAsync');
  if (options.renderAsync)
    renderer.renderAsync = async () =>
      void calls.push(`renderAsync scissor=${scissorTest ? scissor.toArray().join(',') : 'off'}`);
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
    scene.add(
      tag.static(
        new Mesh(box, new MeshStandardMaterial({ map: new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat) })),
      ),
    );
    const world = new World(scene);
    world.compile();
    const renderer = fakeRenderer();
    const result = await world.warmup(renderer as never, new PerspectiveCamera());
    expect(renderer.calls).toEqual([
      'initTexture',
      'setScissor(0,0,1,1)',
      'setScissorTest(true)',
      'render scissor=0,0,1,1',
      'setScissorTest(false)',
      'setScissor(0,0,800,600)',
    ]);
    expect(result).toEqual({ mode: 'frame', textures: 1, repaired: 0 });
  });

  it('awaits renderer.init() before it changes any state, then renders with render(), never the deprecated renderAsync (both modes)', async () => {
    // three r186's renderAsync logs a deprecation warning and is `await this.init(); this.render(...)`: its await would sit
    // between the 1x1 scissor (and the occlusion suspension) and the render.
    const calls: Record<string, string[]> = {};
    for (const mode of ['frame', 'async'] as const) {
      const scene = new Scene();
      scene.add(tag.static(new Mesh(box, new MeshStandardMaterial())));
      const world = new World(scene);
      world.compile();
      const renderer = fakeRenderer({ init: true, renderAsync: true });
      await world.warmup(renderer as never, new PerspectiveCamera(), { mode });
      calls[mode] = renderer.calls;
    }
    const frame = [
      'setScissor(0,0,1,1)',
      'setScissorTest(true)',
      'render scissor=0,0,1,1',
      'setScissorTest(false)',
      'setScissor(0,0,800,600)',
    ];
    expect(calls).toEqual({
      frame: ['init', 'init resolved', ...frame],
      async: ['init', 'init resolved', 'compileAsync', ...frame],
    });
  });

  it('with a ledger attached, the warm-up frame is one main frame, the same as the render after it (both modes)', async () => {
    const outcome: string[] = [];
    for (const mode of ['frame', 'async'] as const) {
      const { renderer: attached, registry, ledger, scene, camera } = attachedLedger();
      for (let i = 0; i < 3; i++) scene.add(tag.static(new Mesh(box, new MeshStandardMaterial({ name: `m${i}` }))));
      const world = new World(scene, { registry, ledger });
      world.compile();
      // FakeRenderer's renderAsync is three's: `await this.init(); this.render(scene, camera);`.
      const renderer = Object.assign(attached, {
        getScissor: (target: Vector4) => target.set(0, 0, 300, 150),
        setScissor: () => undefined,
        getScissorTest: () => false,
        setScissorTest: () => undefined,
        async compileAsync() {},
      });
      const result = await world.warmup(renderer as never, camera, { mode });
      const warm = ledger.frame();
      renderer.render(scene, camera);
      const next = ledger.frame();
      outcome.push(
        `${result.mode}: warm-up passes ${warm.passes.map((p) => p.id).join(',')}, ${warm.totals.sceneSubmissions} scene submissions`,
      );
      outcome.push(
        `${result.mode}: next passes ${next.passes.map((p) => p.id).join(',')}, ${next.totals.sceneSubmissions} scene submissions`,
      );
      expect(warm.totals, `${mode}: warm-up totals`).toEqual(next.totals);
    }
    expect(outcome).toEqual(
      ['frame', 'async'].flatMap((mode) => [
        `${mode}: warm-up passes main, 1 scene submissions`,
        `${mode}: next passes main, 1 scene submissions`,
      ]),
    );
  });

  it('async mode pre-compiles with compileAsync, then rebuilds the materials three renders in two passes or through a viewport texture', async () => {
    const scene = new Scene();
    const foliage = new MeshStandardMaterial({ name: 'foliage', transparent: true, side: DoubleSide });
    const glass = new MeshPhysicalMaterial({ name: 'glass', transmission: 0.9 });
    const singlePass = new MeshStandardMaterial({
      name: 'single-pass',
      transparent: true,
      side: DoubleSide,
      forceSinglePass: true,
    });
    const opaque = new MeshStandardMaterial({ name: 'opaque' });
    scene.add(
      new Mesh(box, foliage),
      new Mesh(box, glass),
      new Mesh(box, singlePass),
      tag.static(new Mesh(box, opaque)),
    );
    const world = new World(scene);
    world.compile();
    const disposed = disposals(foliage, glass, singlePass, opaque);
    const renderer = fakeRenderer();
    const result = await world.warmup(renderer as never, new PerspectiveCamera(), { mode: 'async' });
    expect(disposed().sort()).toEqual(['foliage', 'glass']);
    expect(renderer.calls).toEqual([
      'compileAsync',
      'setScissor(0,0,1,1)',
      'setScissorTest(true)',
      'render scissor=0,0,1,1',
      'setScissorTest(false)',
      'setScissor(0,0,800,600)',
    ]);
    expect(result).toEqual({ mode: 'async', textures: 0, repaired: 2 });
  });

  it('async mode forgets the render compileAsync opens: three calls scene.onBeforeRender there but never onAfterRender', async () => {
    const scene = new Scene();
    for (let i = 0; i < 4; i++) scene.add(tag.static(new Mesh(box, new MeshStandardMaterial({ name: `m${i}` }))));
    const world = new World(scene);
    world.compile();
    // Renderer.compileAsync (three r186 Renderer.js ~967) calls sceneRef.onBeforeRender, queues the objects and resolves
    // without the matching sceneRef.onAfterRender.
    const renderer = Object.assign(new FakeRenderer({ sceneHooks: true }), {
      getScissor: (target: Vector4) => target.set(0, 0, 300, 150),
      setScissor: () => undefined,
      getScissorTest: () => false,
      setScissorTest: () => undefined,
      async compileAsync(this: FakeRenderer, target: Scene, camera: Camera) {
        target.onBeforeRender(this as never, target, camera, null as never, null as never, null as never);
      },
    });
    await world.warmup(renderer as never, new PerspectiveCamera(), { mode: 'async' });
    const main = new PerspectiveCamera();
    let mainInside: Camera | null = null;
    scene.add(
      Object.assign(new Mesh(box, new MeshStandardMaterial()), {
        onBeforeRender: () => void (mainInside = world.mainCamera),
      }),
    );
    renderer.render(scene, main);
    expect(mainInside, 'the next render is an outermost render: its camera is the main camera').toBe(main);
    expect(world.mainCamera).toBe(main);
  });

  it('async mode forgets the render compileAsync opened even when compileAsync rejects', async () => {
    const scene = new Scene();
    for (let i = 0; i < 4; i++) scene.add(tag.static(new Mesh(box, new MeshStandardMaterial({ name: `m${i}` }))));
    const world = new World(scene);
    world.compile();
    const renderer = Object.assign(new FakeRenderer({ sceneHooks: true }), {
      getScissor: (target: Vector4) => target.set(0, 0, 300, 150),
      setScissor: () => undefined,
      getScissorTest: () => false,
      setScissorTest: () => undefined,
      async compileAsync(this: FakeRenderer, target: Scene, camera: Camera) {
        target.onBeforeRender(this as never, target, camera, null as never, null as never, null as never);
        throw new Error('compile failed');
      },
    });
    await expect(world.warmup(renderer as never, new PerspectiveCamera(), { mode: 'async' })).rejects.toThrow(
      'compile failed',
    );
    const main = new PerspectiveCamera();
    renderer.render(scene, main);
    expect(world.mainCamera, 'the next render is an outermost render').toBe(main);
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
