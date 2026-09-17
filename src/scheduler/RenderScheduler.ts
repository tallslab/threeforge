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
      // Asked before the update as well: the update that ends a clip or a fade applies its last step and stops the action,
      // so the frame showing that step would otherwise be skipped.
      if (isMixerAnimating(mixer)) animating = true;
      mixer.update(delta);
      if (isMixerAnimating(mixer)) animating = true;
    }
    // Every detector runs every tick (no short-circuit) so each keeps its baseline current.
    const cameraChanged = this.cameraChanged();
    const watchedChanged = this.watchedChanged();
    const sizeChanged = this.sizeChanged();
    const keepAlive = this.keepAliveMs > 0 && time - this.lastRender >= this.keepAliveMs;
    const dirty = this.invalidated || animating || cameraChanged || watchedChanged || sizeChanged || keepAlive;
    const reason = this.invalidated
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
