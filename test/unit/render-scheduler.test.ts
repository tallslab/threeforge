import {
  AnimationClip,
  AnimationMixer,
  BoxGeometry,
  LoopOnce,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector2,
  VectorKeyframeTrack,
} from 'three';
import { describe, expect, it } from 'vitest';
import { World } from '../../src/compiler/World.js';
import { RenderScheduler } from '../../src/scheduler/RenderScheduler.js';
import { tag } from '../../src/tags.js';

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
  const m = {
    deltas: [] as number[],
    stats: { actions: { inUse } },
    update(dt: number) {
      m.deltas.push(dt);
    },
  };
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
    const world = {
      onDirty: (l: () => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    };
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

  it('pins AnimationAction._weightInterpolant: set by fadeOut(), evaluated while paused, cleared at the end of the fade', () => {
    // AnimationAction.js ~922 (_scheduleFading) sets `_weightInterpolant`; ~638 (_updateWeight) evaluates it whenever
    // the action is enabled, before ~386 (stopFading) clears it and a fade to 0 disables the action.
    const { mixer, action } = makeAnimatedMixer();
    const weightInterpolantOf = () => (action as unknown as { _weightInterpolant: unknown })._weightInterpolant;
    action.play();
    expect(weightInterpolantOf()).toBeNull();
    action.paused = true;
    action.fadeOut(1);
    expect(weightInterpolantOf()).not.toBeNull();
    mixer.update(0.5);
    expect(action.getEffectiveWeight()).toBeCloseTo(0.5);
    mixer.update(0.6);
    expect(weightInterpolantOf()).toBeNull();
    expect(action.enabled).toBe(false);
  });
});

describe('RenderScheduler running-mixer rule (real AnimationMixer)', () => {
  it.each([
    ['with', true],
    ['without', false],
  ])(
    'lets ticks skip once a LoopOnce clip %s clampWhenFinished finishes, even though the mixer still reports it in use',
    (_label, clampWhenFinished) => {
      const { mixer, action } = makeAnimatedMixer();
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = clampWhenFinished;
      action.play();
      const { scheduler } = setup({ mixers: [mixer] });

      let time = 0;
      expect(scheduler.tick(time)).toBe(true); // first tick always renders (invalidated)
      for (let i = 0; i < 5; i++) {
        time += 500;
        scheduler.tick(time);
      } // 2.5s of mixer time, well past the clip's 1s duration

      expect(action.isRunning()).toBe(false);
      // clampWhenFinished holds the last frame, paused (AnimationAction.js ~771); without it the action is disabled instead.
      expect(action.paused).toBe(clampWhenFinished);
      expect(action.enabled).toBe(clampWhenFinished);
      expect(mixer.stats.actions.inUse).toBe(1); // the bug's premise: still "in use" per AnimationMixer.js ~233

      time += 16;
      expect(scheduler.tick(time)).toBe(false); // fixed scheduler: a finished action lets the tick skip
    },
  );

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

  it('keeps counting as running through isRunning() once startAt(future) hands off to actual playback', () => {
    const { mixer, action } = makeAnimatedMixer();
    action.play().startAt(2); // starts 2s of mixer time from now
    const startTimeOf = () => (action as unknown as { _startTime: number | null })._startTime;
    const { scheduler } = setup({ mixers: [mixer] });

    let time = 0;
    expect(scheduler.tick(time)).toBe(true); // first tick always renders (invalidated)
    expect(action.isRunning()).toBe(false); // still waiting: _startTime !== null
    expect(startTimeOf()).toBe(2);

    for (let i = 0; i < 4; i++) {
      time += 800; // four 0.8s ticks: 3.2s of mixer time total, crossing the 2s start
      expect(scheduler.tick(time)).toBe(true);
    }

    // three cleared _startTime once its global time passed it (AnimationAction.js ~587): the action now counts
    // as running through isRunning() itself, not the "scheduled to start" branch.
    expect(startTimeOf()).toBeNull();
    expect(action.isRunning()).toBe(true);

    time += 16;
    expect(scheduler.tick(time)).toBe(true); // still running, now via the isRunning() branch
  });

  it('keeps rendering while a finished, clamped (paused) clip fades out, through the tick the fade ends on, then skips', () => {
    const { root, mixer, action } = makeAnimatedMixer();
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    const { scheduler } = setup({ mixers: [mixer] });
    let time = 0;
    scheduler.tick(time);
    for (let i = 0; i < 5; i++) scheduler.tick((time += 500));
    expect(action.paused).toBe(true);
    expect(scheduler.tick((time += 16))).toBe(false); // finished and clamped: nothing changes
    const clamped = root.position.x;

    // AnimationAction._updateWeight evaluates the weight interpolant whenever the action is enabled, paused or not, so
    // the mixer blends the clamped pose back towards the original over the fade although isRunning() is false.
    action.fadeOut(1);
    expect(action.isRunning()).toBe(false);
    const xs: number[] = [];
    for (let i = 0; i < 3; i++) {
      expect(scheduler.tick((time += 250)), `fading, tick ${i}`).toBe(true);
      xs.push(root.position.x);
    }
    expect(xs[0]).toBeLessThan(clamped);
    expect(xs[2]).toBeLessThan(xs[0]!);
    // The tick that crosses the end of the fade applies its last step (and disables the action): still a change.
    expect(scheduler.tick((time += 300)), 'the tick the fade ends on').toBe(true);
    expect(action.enabled).toBe(false);
    expect(scheduler.tick((time += 16))).toBe(false);
  });

  it('treats an active, enabled, unpaused action with weight 0 as running (a fadeIn() target starts there)', () => {
    const { mixer, action } = makeAnimatedMixer();
    action.play();
    action.weight = 0; // e.g. the action fadeIn() is fading in, before any weight has been applied
    expect(action.isRunning()).toBe(true); // isRunning() does not consult weight
    const { scheduler } = setup({ mixers: [mixer] });

    expect(scheduler.tick(0)).toBe(true); // first tick always renders (invalidated)
    expect(scheduler.tick(16)).toBe(true); // still counts as running despite weight 0: errs toward rendering
  });

  it('falls back to stats.actions.inUse when a mixer-like object has no private _actions/_nActiveActions fields', () => {
    const fake = {
      deltas: [] as number[],
      stats: { actions: { inUse: 0 } },
      update(dt: number) {
        fake.deltas.push(dt);
      },
    };
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
  it("throws at construction against an already-disposed World (World.onDirty's own fail-fast, not new scheduler code)", () => {
    const world = new World(new Scene());
    world.dispose();
    expect(() => setup({ world })).toThrow(/disposed/i);
  });

  it('does not throw when an uncompiled World is disposed mid-lifecycle, and other change signals keep working', () => {
    // Uncompiled: World.decompile() (called by dispose()) returns early when `!this.compiled`, so no 'decompile'
    // dirty event is ever emitted here. Kept separate from the compiled case below, which does emit one.
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

  it('renders once more when a compiled World is disposed mid-lifecycle (its own decompile event), then lets ticks skip', () => {
    // Compiled: dispose() -> decompile() emits a 'decompile' dirty event to still-attached listeners (World.ts
    // emitDirty(), before dirtyListeners.clear() in dispose()'s finally block), and the scheduler's onDirty
    // callback calls invalidate() synchronously. The next tick sees `invalidated` and renders once; nothing
    // further ever arrives from the World, since every mutator throws once it is disposed.
    const scene = new Scene();
    const mesh = tag.static(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
    scene.add(mesh);
    const world = new World(scene);
    world.compile();

    const { camera, scheduler } = setup({ world });
    const dirtyListeners = (world as unknown as { dirtyListeners: Set<unknown> }).dirtyListeners;
    expect(dirtyListeners.size).toBe(1); // just the scheduler's own subscription

    expect(scheduler.tick(0)).toBe(true); // settle: first tick always renders
    expect(scheduler.tick(16)).toBe(false); // idle before disposal

    expect(() => world.dispose()).not.toThrow();
    expect(dirtyListeners.size).toBe(0); // World.dispose() clears every dirty listener, including the scheduler's

    expect(scheduler.tick(32)).toBe(true); // renders once more: the decompile event invalidated this tick
    expect(scheduler.tick(48)).toBe(false); // idle again: a disposed World cannot fire another dirty event
    expect(scheduler.tick(64)).toBe(false);

    camera.position.x = 3; // other detectors still work independently of the (now-dead) World subscription
    camera.updateMatrixWorld();
    expect(scheduler.tick(80)).toBe(true);

    expect(() => scheduler.dispose()).not.toThrow(); // teardown after a disposed, compiled World must not throw
  });
});
