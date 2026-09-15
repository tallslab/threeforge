import { Vector2, type Camera, type Object3D, type Scene } from 'three';

/** The slice of three's renderer the scheduler drives. */
export interface SchedulerRenderer {
  render(scene: Scene, camera: Camera): unknown;
  setAnimationLoop(callback: ((time: number) => void) | null): unknown;
  getDrawingBufferSize(target: Vector2): Vector2;
}

/** An AnimationMixer, structurally: updated every tick, its running actions keep frames coming. */
export interface SchedulerMixer {
  update(deltaSeconds: number): unknown;
  stats: { actions: { inUse: number } };
}

/**
 * Reflects three r186's private `AnimationMixer`/`AnimationAction` fields (not part of three's public types, so
 * they are read through an `unknown` cast rather than declared on `SchedulerMixer`): `AnimationMixer.js` ~201-202
 * (`_actions`, active actions stored first then inactive ones; `_nActiveActions`, ~271's `_isActiveAction` checks
 * an action's cache index against it). `AnimationAction.js`'s `_startTime` is set by `startAt()` (~246) and
 * cleared at construction (~73) and by `reset()` (~209, called from `play()`). Pinned by the canary test in
 * test/unit/render-scheduler.test.ts.
 */
interface MixerInternals {
  _actions: ActionInternals[];
  _nActiveActions: number;
}
interface ActionInternals {
  isRunning?(): boolean;
  _startTime?: number | null;
}

/**
 * A mixer is animating when an active action (`_actions[0.._nActiveActions)`) is actually running
 * (`isRunning()`), or is scheduled to start later (`_startTime !== null`). `AnimationMixer.js` ~233's
 * `stats.actions.inUse` getter returns `_nActiveActions` directly with no filtering, so it keeps counting a
 * finished `LoopOnce` action that stays active — `clampWhenFinished` pauses it (`AnimationAction.js` ~771),
 * without clamping it is only disabled (~772), and neither removes it from `_actions`. `isRunning()` (~220)
 * requires enabled, not paused, `timeScale !== 0` and `_startTime === null`, so it is false in both cases: that
 * is the bug this replaces. Falls back to `stats.actions.inUse` when `_actions` / `_nActiveActions` are absent
 * (mixer-like test doubles that do not model three's internals).
 */
function isMixerAnimating(mixer: SchedulerMixer): boolean {
  const internals = mixer as unknown as Partial<MixerInternals>;
  const actions = internals._actions;
  const nActive = internals._nActiveActions;
  if (!Array.isArray(actions) || typeof nActive !== 'number') return mixer.stats.actions.inUse > 0;
  for (let i = 0; i < nActive; i++) {
    const action = actions[i];
    if (!action) continue;
    if ((typeof action.isRunning === 'function' && action.isRunning()) || (action._startTime !== null && action._startTime !== undefined)) return true;
  }
  return false;
}

export interface RenderSchedulerOptions {
  renderer: SchedulerRenderer;
  scene: Scene;
  camera: Camera;
  /** Reports `js.skipped` in snapshots; detached on `dispose()`. */
  ledger?: { attachScheduler(scheduler: { skippedRecently(): number } | null): void };
  /** Graph changes through the World (`markDirty`, `setVisible`, `compile`, `decompile`) invalidate. */
  world?: { onDirty(listener: () => void): () => void };
  mixers?: SchedulerMixer[];
  /** Objects whose world matrix changes should render (a player, a moving platform). */
  watch?: Object3D[];
  /** Render at least this often in milliseconds even when nothing changed; 0 (default) never. */
  keepAliveMs?: number;
  /** Runs right before a render with the elapsed seconds (game logic that only matters when a frame is drawn). */
  onRender?(deltaSeconds: number): void;
}

const WINDOW = 60;

/**
 * Render on change. A tick renders when something invalidated the frame, the camera's world or projection matrix
 * changed, a watched object moved, a mixer has running actions, the drawing buffer was resized, or `keepAliveMs`
 * elapsed; otherwise it skips, and three does no work at all for that tick. Menus, editors, turn-based games and
 * anything with a still camera spend most ticks skipping.
 */
export class RenderScheduler {
  readonly stats = { ticks: 0, renders: 0, skipped: 0 };
  /** Why the last rendered tick rendered; null before the first. */
  lastReason: 'invalidate' | 'animation' | 'camera' | 'watched' | 'resize' | 'keep-alive' | null = null;
  private readonly renderer: SchedulerRenderer;
  private readonly scene: Scene;
  private readonly camera: Camera;
  private readonly ledger: RenderSchedulerOptions['ledger'];
  private readonly mixers: SchedulerMixer[];
  private readonly keepAliveMs: number;
  private readonly onRender: RenderSchedulerOptions['onRender'];
  // Baselines are float64: three's matrix elements are, and a float32 copy would never compare equal.
  private readonly watched = new Map<Object3D, Float64Array>();
  private readonly lastCamera = new Float64Array(32);
  private readonly lastSize = new Vector2(-1, -1);
  private readonly size = new Vector2();
  private readonly ring: boolean[] = [];
  private invalidated = true;
  private lastTick = -1;
  private lastRender = -Infinity;
  private unsubscribeWorld: (() => void) | null = null;

  constructor(options: RenderSchedulerOptions) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;
    this.ledger = options.ledger;
    this.mixers = options.mixers ?? [];
    this.keepAliveMs = options.keepAliveMs ?? 0;
    this.onRender = options.onRender;
    for (const object of options.watch ?? []) this.watch(object);
    this.ledger?.attachScheduler(this);
    this.unsubscribeWorld = options.world?.onDirty(() => this.invalidate()) ?? null;
  }

  /** The next tick renders. Call it after changing anything the scheduler cannot see. */
  invalidate(): void {
    this.invalidated = true;
  }

  watch(object: Object3D): void {
    object.updateWorldMatrix(true, false);
    this.watched.set(object, Float64Array.from(object.matrixWorld.elements));
  }

  unwatch(object: Object3D): void {
    this.watched.delete(object);
  }

  /** Drives `renderer.setAnimationLoop` with `tick`. */
  start(): void {
    this.renderer.setAnimationLoop((time) => {
      this.tick(time);
    });
  }

  stop(): void {
    this.renderer.setAnimationLoop(null);
  }

  /** Skipped ticks among the last 60 (what `js.skipped` reports). */
  skippedRecently(): number {
    let n = 0;
    for (const skipped of this.ring) if (skipped) n++;
    return n;
  }

  /** One animation-frame tick; returns whether a frame was rendered. */
  tick(time: number = typeof performance !== 'undefined' ? performance.now() : Date.now()): boolean {
    const delta = this.lastTick < 0 ? 0 : Math.max(0, (time - this.lastTick) / 1000);
    this.lastTick = time;
    let animating = false;
    for (const mixer of this.mixers) {
      mixer.update(delta);
      if (isMixerAnimating(mixer)) animating = true;
    }
    // Every detector runs every tick (no short-circuit) so each keeps its baseline current.
    const cameraChanged = this.cameraChanged();
    const watchedChanged = this.watchedChanged();
    const sizeChanged = this.sizeChanged();
    const keepAlive = this.keepAliveMs > 0 && time - this.lastRender >= this.keepAliveMs;
    const dirty = this.invalidated || animating || cameraChanged || watchedChanged || sizeChanged || keepAlive;
    const reason = this.invalidated ? 'invalidate' : animating ? 'animation' : cameraChanged ? 'camera' : watchedChanged ? 'watched' : sizeChanged ? 'resize' : keepAlive ? 'keep-alive' : null;
    this.stats.ticks++;
    this.ring.push(!dirty);
    if (this.ring.length > WINDOW) this.ring.shift();
    if (!dirty) {
      this.stats.skipped++;
      return false;
    }
    this.invalidated = false;
    this.lastReason = reason;
    this.onRender?.(delta);
    this.renderer.render(this.scene, this.camera);
    // Rendering can change what we compare (three updates the camera's matrices and, on its first WebGPU frame,
    // its projection): re-baseline on the state the frame was drawn with.
    this.cameraChanged();
    this.watchedChanged();
    this.sizeChanged();
    this.lastRender = time;
    this.stats.renders++;
    return true;
  }

  dispose(): void {
    this.stop();
    this.unsubscribeWorld?.();
    this.unsubscribeWorld = null;
    this.ledger?.attachScheduler(null);
    this.watched.clear();
  }

  private cameraChanged(): boolean {
    // Moving `camera.position` (or its parent) does not itself recompute `matrixWorld` — only a render pass or
    // an explicit update call does. Bring it current before comparing so an app that moves the camera without
    // calling `updateMatrixWorld()` still gets detected.
    this.camera.updateWorldMatrix(true, false);
    const w = this.camera.matrixWorld.elements;
    const p = this.camera.projectionMatrix.elements;
    let changed = false;
    for (let i = 0; i < 16; i++) {
      if (this.lastCamera[i] !== w[i] || this.lastCamera[16 + i] !== p[i]) {
        changed = true;
        this.lastCamera[i] = w[i]!;
        this.lastCamera[16 + i] = p[i]!;
      }
    }
    return changed;
  }

  private watchedChanged(): boolean {
    let changed = false;
    for (const [object, last] of this.watched) {
      // Same reason as cameraChanged(): a watched object's matrixWorld is stale until something updates it.
      object.updateWorldMatrix(true, false);
      const e = object.matrixWorld.elements;
      for (let i = 0; i < 16; i++) {
        if (last[i] !== e[i]) {
          changed = true;
          last.set(e);
          break;
        }
      }
    }
    return changed;
  }

  private sizeChanged(): boolean {
    this.renderer.getDrawingBufferSize(this.size);
    if (this.size.equals(this.lastSize)) return false;
    this.lastSize.copy(this.size);
    return true;
  }
}
