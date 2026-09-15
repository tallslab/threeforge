import { describe, expect, it } from 'vitest';
import { AnimationClip, AnimationMixer, LoopOnce, Mesh, Object3D, PerspectiveCamera, Scene, Vector2, VectorKeyframeTrack } from 'three';
import { RenderScheduler } from '../../src/scheduler/RenderScheduler.js';
import { World } from '../../src/compiler/World.js';

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
/** A real three AnimationMixer/AnimationAction pair on a fresh clip (1 second, default LoopRepeat). Not played. */
function makeAnimatedMixer() {
  const root = new Object3D();
  const mixer = new AnimationMixer(root);
  const clip = new AnimationClip('clip', 1, [new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 1, 0, 0])]);
  const action = mixer.clipAction(clip);
  return { root, mixer, action };
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

// Canary: pins the three r186 AnimationMixer/AnimationAction internals the running-mixer fallback reflection
// depends on. Exercises three directly, not RenderScheduler — if it ever fails, three changed its internals and
// the reflection in RenderScheduler.ts (isMixerAnimating) needs to change with it. Expected to pass unmodified
// on this repo's three version both before and after the RenderScheduler fix.
describe('RenderScheduler running-mixer internals (canary)', () => {
  it('pins AnimationMixer._actions/_nActiveActions and AnimationAction.isRunning()/_startTime', () => {
    // AnimationMixer.js ~201-202: `_actions` (active actions first, then inactive) and `_nActiveActions` start
    // empty/0. ~233: the `stats.actions.inUse` getter returns `_nActiveActions` directly (no filtering for
    // actions that finished but stayed active — that is the bug this task fixes). ~271: `_isActiveAction`
    // checks an action's cache index against `_nActiveActions`.
    const { mixer, action } = makeAnimatedMixer();
    const internals = mixer as unknown as { _actions: unknown[]; _nActiveActions: number };

    // clipAction() already added the action to `_actions` (inactive section); it is not active until play().
    expect(internals._actions).toHaveLength(1);
    expect(internals._nActiveActions).toBe(0);
    expect(mixer.stats.actions.inUse).toBe(0);

    action.play();
    expect(internals._actions[0]).toBe(action);
    expect(internals._nActiveActions).toBe(1);
    expect(mixer.stats.actions.inUse).toBe(internals._nActiveActions);

    // AnimationAction.js ~220: isRunning() is true only when enabled, not paused, timeScale !== 0, _startTime
    // === null, and the mixer considers the action active. _startTime is set by startAt() (~246) and cleared
    // at ~73 (construction) and ~209 (reset(), called by play()).
    const startTimeOf = (a: typeof action) => (a as unknown as { _startTime: number | null })._startTime;
    expect(action.isRunning()).toBe(true);
    expect(startTimeOf(action)).toBeNull();

    action.startAt(10);
    // Scheduled to start later: still active (inUse unaffected — it is still in _actions[0.._nActiveActions)),
    // but isRunning() is false until the mixer's global time reaches _startTime and clears it.
    expect(mixer.stats.actions.inUse).toBe(1);
    expect(action.isRunning()).toBe(false);
    expect(startTimeOf(action)).toBe(10);
  });
});

describe('RenderScheduler running-mixer rule (real AnimationMixer)', () => {
  it('lets ticks skip once a LoopOnce clip with clampWhenFinished finishes, even though the mixer still reports it in use', () => {
    const { mixer, action } = makeAnimatedMixer();
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    const { scheduler } = setup({ mixers: [mixer] });

    let time = 0;
    expect(scheduler.tick(time)).toBe(true); // first tick always renders (invalidated)
    for (let i = 0; i < 5; i++) {
      time += 500;
      scheduler.tick(time);
    } // 2.5s of mixer time, well past the clip's 1s duration

    expect(action.isRunning()).toBe(false);
    expect(action.paused).toBe(true); // clampWhenFinished holds the last frame (AnimationAction.js ~771)
    expect(mixer.stats.actions.inUse).toBe(1); // the bug's premise: still "in use" per AnimationMixer.js ~233

    time += 16;
    expect(scheduler.tick(time)).toBe(false); // fixed scheduler: a finished action lets the tick skip
  });

  it('lets ticks skip once a LoopOnce clip without clampWhenFinished finishes', () => {
    const { mixer, action } = makeAnimatedMixer();
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = false;
    action.play();
    const { scheduler } = setup({ mixers: [mixer] });

    let time = 0;
    expect(scheduler.tick(time)).toBe(true);
    for (let i = 0; i < 5; i++) {
      time += 500;
      scheduler.tick(time);
    }

    expect(action.isRunning()).toBe(false);
    expect(action.enabled).toBe(false); // no clamp: disabled instead of paused (AnimationAction.js ~772)
    expect(mixer.stats.actions.inUse).toBe(1); // still counted in use

    time += 16;
    expect(scheduler.tick(time)).toBe(false);
  });

  it('keeps rendering while a looping clip plays', () => {
    const { mixer, action } = makeAnimatedMixer();
    action.play(); // default loop mode is LoopRepeat
    const { scheduler } = setup({ mixers: [mixer] });

    let time = 0;
    expect(scheduler.tick(time)).toBe(true);
    for (let i = 0; i < 5; i++) {
      time += 500;
      expect(scheduler.tick(time)).toBe(true); // still looping past 2.5s, across multiple 1s cycles
    }
  });

  it('treats an action scheduled with startAt(future) as running before it starts', () => {
    const { mixer, action } = makeAnimatedMixer();
    action.play().startAt(10); // starts 10s of mixer time from now
    expect(action.isRunning()).toBe(false); // AnimationAction.js ~220 requires _startTime === null
    expect(mixer.stats.actions.inUse).toBe(1);
    const { scheduler } = setup({ mixers: [mixer] });

    expect(scheduler.tick(0)).toBe(true); // first tick always renders (invalidated)
    expect(scheduler.tick(16)).toBe(true); // still waiting to start: scheduled counts as running
    expect(scheduler.tick(32)).toBe(true);
  });

  it('falls back to stats.actions.inUse when a mixer-like object has no private _actions/_nActiveActions fields', () => {
    const fake = { deltas: [] as number[], stats: { actions: { inUse: 0 } }, update(dt: number) { fake.deltas.push(dt); } };
    const { scheduler } = setup({ mixers: [fake] });
    expect(scheduler.tick(0)).toBe(true);
    expect(scheduler.tick(16)).toBe(false); // inUse stays 0: not animating
    fake.stats.actions.inUse = 1;
    expect(scheduler.tick(32)).toBe(true); // inUse > 0: fallback reports animating
    fake.stats.actions.inUse = 0;
    expect(scheduler.tick(48)).toBe(false);
  });
});

describe('RenderScheduler matrix updates', () => {
  it('renders when the camera moves even without an explicit updateMatrixWorld() call', () => {
    const { camera, scheduler } = setup();
    expect(scheduler.tick(0)).toBe(true);
    expect(scheduler.tick(16)).toBe(false);
    camera.position.x = 5; // no updateMatrixWorld() call
    expect(scheduler.tick(32)).toBe(true); // the scheduler updates the camera's own matrix before comparing
    expect(scheduler.tick(48)).toBe(false);
  });

  it('renders when a watched object moves even without an explicit updateMatrixWorld() call', () => {
    const { scene, scheduler } = setup();
    const watched = new Mesh();
    scene.add(watched);
    scheduler.watch(watched);
    expect(scheduler.tick(0)).toBe(true);
    expect(scheduler.tick(16)).toBe(false);
    watched.position.y = 2; // no updateMatrixWorld() call
    expect(scheduler.tick(32)).toBe(true);
    expect(scheduler.tick(48)).toBe(false);
  });
});

describe('RenderScheduler and a disposed World', () => {
  it('throws at construction against an already-disposed World (World.onDirty\'s own fail-fast, not new scheduler code)', () => {
    const world = new World(new Scene());
    world.dispose();
    expect(() => setup({ world })).toThrow(/disposed/i);
  });

  it('does not throw when the World is disposed mid-lifecycle, and other change signals keep working', () => {
    const world = new World(new Scene());
    const { camera, scheduler } = setup({ world });

    expect(() => world.dispose()).not.toThrow();
    expect(scheduler.tick(0)).toBe(true); // first tick always renders
    expect(scheduler.tick(16)).toBe(false); // idle: a disposed World can never fire another dirty event
    camera.position.x = 3;
    camera.updateMatrixWorld();
    expect(scheduler.tick(32)).toBe(true); // camera-change detection is independent of the World subscription
    expect(() => scheduler.dispose()).not.toThrow(); // teardown after a disposed World must not throw
  });
});
