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
      if (mixer.stats.actions.inUse > 0) animating = true;
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
