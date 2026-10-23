import { type Camera, type Object3D, type Scene, Vector2 } from 'three';

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
 * three r186's private `AnimationMixer`/`AnimationAction` fields, read through an `unknown` cast: `_actions` stores
 * the active actions first and `_nActiveActions` counts them (`AnimationMixer.js` ~201-202); `_startTime` is set by
 * `startAt()` and cleared by `reset()` (`AnimationAction.js` ~246, ~209). A canary test in
 * test/unit/render-scheduler.test.ts pins them.
 */
interface MixerInternals {
  _actions: ActionInternals[];
  _nActiveActions: number;
}
interface ActionInternals {
  isRunning?(): boolean;
  _startTime?: number | null;
  enabled?: boolean;
  _weightInterpolant?: unknown;
}

/**
 * A mixer is animating when an active action (`_actions[0.._nActiveActions)`) is running (`isRunning()`), scheduled
 * to start (`_startTime !== null`), or enabled with a weight fade under way (`_weightInterpolant !== null`: a clamped
 * clip given `fadeOut()` still blends although `isRunning()` is false). `stats.actions.inUse` keeps counting a
 * finished `LoopOnce` action, which stays in `_actions` paused or disabled, so it is only the fallback for mixer-like
 * doubles without three's internals. An action at `weight === 0` still counts: `fadeIn()` starts its target there, and
 * skipping that tick would miss the start of the fade. A time-scale fade on a paused action does not count.
 */
function isMixerAnimating(mixer: SchedulerMixer): boolean {
  const internals = mixer as unknown as Partial<MixerInternals>;
  const actions = internals._actions;
  const nActive = internals._nActiveActions;
  if (!Array.isArray(actions) || typeof nActive !== 'number') return mixer.stats.actions.inUse > 0;
  for (let i = 0; i < nActive; i++) {
    const action = actions[i];
    if (!action) continue;
    if (
      (typeof action.isRunning === 'function' && action.isRunning()) ||
      (action._startTime !== null && action._startTime !== undefined)
    )
      return true;
    if (action.enabled === true && action._weightInterpolant !== null && action._weightInterpolant !== undefined)
      return true;
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
  /** Render at most this many frames per second (a battery mode, a menu); 0 (default) every tick that needs one. */
  maxFps?: number;
  /**
   * How a cap that does not divide the display's rate is met: `steady` (the default) waits the same whole number of
   * refreshes every frame and never runs more than 5 % over the cap (30 at 144 Hz is every 5th refresh, 28.8 fps);
   * `average` mixes two gaps to average the cap (4 and 5 refreshes at 144 Hz, 30 fps).
   */
  pacing?: 'steady' | 'average';
  /** Runs right before a render with the elapsed seconds (game logic that only matters when a frame is drawn). */
  onRender?(deltaSeconds: number): void;
}

const WINDOW = 60;
/** Tick intervals the refresh estimate reads: enough that a stall or a hidden tab moves it nowhere. */
const SAMPLES = 15;

type Reason = NonNullable<RenderScheduler['lastReason']>;

/**
 * Render on change. A tick renders when something invalidated the frame, the camera's world or projection matrix
 * changed, a watched object moved, a mixer has running actions, the drawing buffer was resized, or `keepAliveMs`
 * elapsed; otherwise it skips, and three does no work at all for that tick. Menus, editors, turn-based games and
 * anything with a still camera spend most ticks skipping. `maxFps` caps the frames that are rendered by counting
 * display refreshes, measured from recent tick intervals: a frame waits a whole number of them (accepted half a refresh
 * early, for vsync jitter), and what a waiting tick saw is rendered on the next allowed one.
 * Mixers advance only on rendered frames, by the time since the previous one.
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
  private fpsCap = 0;
  private readonly pacing: 'steady' | 'average';
  private readonly intervals = new Float64Array(SAMPLES);
  private readonly sorted = new Float64Array(SAMPLES);
  private intervalCount = 0;
  private intervalAt = 0;
  /** Refreshes the next capped frame waits after the last one. */
  private gap = 1;
  /** For `average` pacing, the part of a refresh the gaps so far have fallen short of the cap's interval. */
  private credit = 0;
  /** Seconds the mixers are owed: they advance only on rendered frames, by the time capped ticks held back. */
  private mixerDelta = 0;
  /** What a capped tick saw: the edge detectors re-baseline every tick, so it would be lost otherwise. */
  private pending: Reason | null = null;
  private unsubscribeWorld: (() => void) | null = null;

  constructor(options: RenderSchedulerOptions) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;
    this.ledger = options.ledger;
    this.mixers = options.mixers ?? [];
    this.keepAliveMs = options.keepAliveMs ?? 0;
    const pacing = options.pacing ?? 'steady';
    if (pacing !== 'steady' && pacing !== 'average')
      throw new RangeError(`RenderScheduler: pacing ${String(pacing)} must be 'steady' or 'average'`);
    this.pacing = pacing;
    this.maxFps = options.maxFps ?? 0;
    this.onRender = options.onRender;
    for (const object of options.watch ?? []) this.watch(object);
    this.ledger?.attachScheduler(this);
    this.unsubscribeWorld = options.world?.onDirty(() => this.invalidate()) ?? null;
  }

  /** The most frames rendered per second; 0 for no cap. Switch it at any time (entering a menu, on battery). */
  get maxFps(): number {
    return this.fpsCap;
  }

  set maxFps(fps: number) {
    if (!Number.isFinite(fps) || fps < 0) throw new RangeError(`RenderScheduler: maxFps ${fps} must be 0 or more`);
    this.fpsCap = fps;
    this.credit = 0;
    if (fps > 0) this.gap = this.nextGap();
  }

  /**
   * The display's refresh interval in ms, 60 Hz before there is a tick to measure: the mean of the recent intervals
   * within half of their median. The median drops stalls; the mean of what is left is steady under vsync jitter, which
   * cancels between consecutive intervals.
   */
  private refreshInterval(): number {
    const n = this.intervalCount;
    if (n === 0) return 1000 / 60;
    const sorted = this.sorted;
    for (let i = 0; i < n; i++) {
      const v = this.intervals[i]!;
      let j = i - 1;
      for (; j >= 0 && sorted[j]! > v; j--) sorted[j + 1] = sorted[j]!;
      sorted[j + 1] = v;
    }
    const median = n % 2 === 1 ? sorted[n >> 1]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(sorted[i]! - median) > median / 2) continue;
      sum += sorted[i]!;
      count++;
    }
    return sum / count;
  }

  /** Refreshes the frame after this one waits, by the pacing policy. */
  private nextGap(): number {
    const ratio = 1000 / this.fpsCap / this.refreshInterval();
    // The nearest whole gap, unless it would run more than 5 % over the cap.
    if (this.pacing === 'steady') return Math.max(1, Math.round(ratio), Math.ceil(ratio / 1.05));
    const gap = Math.max(1, Math.floor(this.credit + ratio));
    this.credit += ratio - gap;
    return gap;
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
    if (this.lastTick >= 0 && time > this.lastTick) {
      this.intervals[this.intervalAt] = time - this.lastTick;
      this.intervalAt = (this.intervalAt + 1) % SAMPLES;
      if (this.intervalCount < SAMPLES) this.intervalCount++;
    }
    this.lastTick = time;
    this.mixerDelta += delta;
    // Asked before the mixers advance, which they do only on a rendered frame: a clip still running asks for the next
    // frame, and the update on that frame applies its last step, so a clip that ends between frames shows its end pose.
    let animating = false;
    for (const mixer of this.mixers) if (isMixerAnimating(mixer)) animating = true;
    // Every detector runs every tick (no short-circuit) so each keeps its baseline current.
    const cameraChanged = this.cameraChanged();
    const watchedChanged = this.watchedChanged();
    const sizeChanged = this.sizeChanged();
    const keepAlive = this.keepAliveMs > 0 && time - this.lastRender >= this.keepAliveMs;
    const seen: Reason | null = this.invalidated
      ? 'invalidate'
      : animating
        ? 'animation'
        : cameraChanged
          ? 'camera'
          : watchedChanged
            ? 'watched'
            : sizeChanged
              ? 'resize'
              : keepAlive
                ? 'keep-alive'
                : null;
    const reason = this.pending ?? seen;
    const capped =
      reason !== null && this.fpsCap > 0 && time - this.lastRender < (this.gap - 0.5) * this.refreshInterval();
    if (capped) this.pending = reason;
    const render = reason !== null && !capped;
    this.stats.ticks++;
    this.ring.push(!render);
    if (this.ring.length > WINDOW) this.ring.shift();
    if (!render) {
      // A tick that wanted no frame has nothing animating, so its time is dropped: the mixers' clock pauses with them,
      // and a fade or `startAt` scheduled from it later runs at its own pace instead of jumping by the idle stretch.
      if (reason === null) this.mixerDelta = 0;
      this.stats.skipped++;
      return false;
    }
    this.invalidated = false;
    this.pending = null;
    this.lastReason = reason;
    if (this.fpsCap > 0) this.gap = this.nextGap();
    for (const mixer of this.mixers) mixer.update(this.mixerDelta);
    this.mixerDelta = 0;
    this.onRender?.(delta);
    this.renderer.render(this.scene, this.camera);
    // Rendering can change what is compared (three updates the camera's matrices and, on its first WebGPU frame,
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
