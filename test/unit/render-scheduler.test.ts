import { describe, expect, it } from 'vitest';
import { Mesh, Object3D, PerspectiveCamera, Scene, Vector2 } from 'three';
import { RenderScheduler } from '../../src/scheduler/RenderScheduler.js';

function fakeRenderer(width = 800, height = 600) {
  const r = {
    renders: 0,
    loop: undefined as ((time: number) => void) | null | undefined,
    size: new Vector2(width, height),
    render() {
      r.renders++;
    },
    setAnimationLoop(cb: ((time: number) => void) | null) {
      r.loop = cb;
    },
    getDrawingBufferSize(target: Vector2) {
      return target.copy(r.size);
    },
  };
  return r;
}
function fakeMixer(inUse: number) {
  const m = { deltas: [] as number[], stats: { actions: { inUse } }, update(dt: number) { m.deltas.push(dt); } };
  return m;
}
function setup(extra: Record<string, unknown> = {}) {
  const renderer = fakeRenderer();
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld();
  const scheduler = new RenderScheduler({ renderer, scene, camera, ...extra });
  return { renderer, scene, camera, scheduler };
}

describe('RenderScheduler', () => {
  it('renders on the first tick, skips idle ticks, and renders again when the camera moves or invalidate() is called', () => {
    const { renderer, camera, scheduler } = setup();
    expect(scheduler.tick(0)).toBe(true);
    for (let i = 1; i <= 9; i++) expect(scheduler.tick(i * 16)).toBe(false);
    expect(scheduler.stats).toEqual({ ticks: 10, renders: 1, skipped: 9 });
    expect(scheduler.skippedRecently()).toBe(9);
    camera.position.x = 1;
    camera.updateMatrixWorld();
    expect(scheduler.tick(160)).toBe(true);
    expect(scheduler.tick(176)).toBe(false);
    scheduler.invalidate();
    expect(scheduler.tick(192)).toBe(true);
    expect(scheduler.tick(208)).toBe(false);
    expect(renderer.renders).toBe(3);
  });

  it('renders when a watched object moves, while a mixer has running actions, on buffer resize, and on keep-alive', () => {
    const mixer = fakeMixer(0);
    const { renderer, scene, scheduler } = setup({ mixers: [mixer], keepAliveMs: 100 });
    const watched = new Mesh();
    scene.add(watched);
    scheduler.watch(watched);
    scheduler.tick(0);
    expect(scheduler.tick(16)).toBe(false);
    watched.position.y = 2;
    watched.updateMatrixWorld();
    expect(scheduler.tick(32)).toBe(true);
    expect(scheduler.tick(48)).toBe(false);
    mixer.stats.actions.inUse = 1;
    expect(scheduler.tick(64)).toBe(true);
    expect(scheduler.tick(80)).toBe(true);
    expect(mixer.deltas.slice(-2)).toEqual([0.016, 0.016]);
    mixer.stats.actions.inUse = 0;
    expect(scheduler.tick(96)).toBe(false);
    renderer.size.set(400, 300);
    expect(scheduler.tick(112)).toBe(true);
    expect(scheduler.tick(128)).toBe(false);
    expect(scheduler.tick(212)).toBe(true); // 100 ms after the last render at 112
    scheduler.unwatch(watched);
    watched.position.y = 5;
    watched.updateMatrixWorld();
    expect(scheduler.tick(228)).toBe(false);
    expect(renderer.renders).toBe(6);
  });

  it('drives the animation loop, subscribes to the world and the ledger, and disposes cleanly', () => {
    const attached: unknown[] = [];
    const ledger = { attachScheduler: (s: unknown) => attached.push(s) };
    let listener: (() => void) | null = null;
    const world = { onDirty: (l: () => void) => { listener = l; return () => { listener = null; }; } };
    const { renderer, scheduler } = setup({ ledger, world });
    expect(attached).toEqual([scheduler]);
    scheduler.start();
    expect(typeof renderer.loop).toBe('function');
    renderer.loop!(0);
    expect(renderer.renders).toBe(1);
    renderer.loop!(16);
    expect(renderer.renders).toBe(1);
    listener!();
    renderer.loop!(32);
    expect(renderer.renders).toBe(2);
    scheduler.stop();
    expect(renderer.loop).toBeNull();
    scheduler.dispose();
    expect(attached.at(-1)).toBeNull();
    expect(listener).toBeNull();
    expect(new Object3D().visible).toBe(true);
  });
});
