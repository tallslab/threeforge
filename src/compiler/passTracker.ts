import type { Camera, Scene } from 'three';
import { prependAfterRenderHook, prependRenderHook } from './culling.js';

/** The slice of a renderer the tracker reads: three's animation loop stores the animation-frame id in `info.frame` every tick (`Animation.js`). */
interface FrameSource {
  info?: { frame?: number };
}

/**
 * Follows the nesting of `render()` calls of one scene through its `onBeforeRender`/`onAfterRender` hooks, which three
 * r186 calls at the start and at the very end of every `_renderScene` (`Renderer.js` ~1799 and ~1930), nested renders
 * included. The end hook runs after `backend.finishRender`, so every draw of that pass has been issued (and on WebGPU
 * submitted) by then.
 *
 * Depth 1 is the outermost render (its camera is the main camera); a shadow map, a reflection or a portal rendered
 * from inside it runs at depth 2, and so on. Every render gets an id that never repeats, so a culling hook can tell
 * whether the pass that culled an object is still open (`passAt`), and `atEnd` lets it put state back once that pass
 * is over. `frame` counts outermost renders.
 */
export class PassTracker {
  /** 0 outside any render; 1 inside the outermost render; +1 per nested render. */
  depth = 0;
  /** Increments at the start of every outermost render. */
  frame = 0;
  /** The camera of the outermost render in the current or last frame. */
  mainCamera: Camera | null = null;
  private counter = 0;
  /** `open[d]` is the id of the render open at depth d (0 when none); index 0 is unused. */
  private readonly open: number[] = [0];
  private infoFrame: number | undefined;
  /** Callbacks waiting for the end of the render open at `endDepths[i]`, innermost last. */
  private readonly endCallbacks: ((depth: number) => void)[] = [];
  private readonly endDepths: number[] = [];

  /**
   * A render starts. `source.info.frame` (three's animation-frame id) heals a depth left open by a render that threw
   * before its end hook: a new animation frame that finds a render still open starts over (see `reset`).
   */
  begin(camera: Camera, source?: FrameSource): void {
    const frame = source?.info?.frame;
    if (this.depth > 0 && frame !== undefined && frame !== this.infoFrame) this.reset();
    if (this.depth === 0) {
      this.frame++;
      this.mainCamera = camera;
      this.infoFrame = frame;
    }
    this.depth++;
    this.open[this.depth] = ++this.counter;
  }

  /** A render ends: the callbacks registered while it was the innermost open render run, last registered first. */
  end(): void {
    if (this.depth === 0) return;
    this.flush(this.depth);
    this.open[this.depth] = 0;
    this.depth--;
  }

  /** The id of the render open at `depth`, 0 when no render is open there. */
  passAt(depth: number): number {
    return depth >= 1 && depth <= this.depth ? (this.open[depth] ?? 0) : 0;
  }

  /** The id of the innermost open render, 0 outside any render. */
  get pass(): number {
    return this.passAt(this.depth);
  }

  /**
   * Runs `fn(depth)` when the innermost open render (at `depth`) ends, or when the tracker resets. Outside a render
   * it runs at once with depth 0. Pass a function created once: the tracker keeps a reference until then.
   */
  atEnd(fn: (depth: number) => void): void {
    if (this.depth === 0) {
      fn(0);
      return;
    }
    this.endCallbacks.push(fn);
    this.endDepths.push(this.depth);
  }

  /** Forgets every open render (after `decompile()`, or a render that threw) and runs the callbacks still waiting. Pass ids never repeat. */
  reset(): void {
    for (let d = 1; d <= this.depth; d++) this.open[d] = 0;
    this.depth = 0;
    this.mainCamera = null;
    this.flush(0);
  }

  /** Installs the scene hooks (marked `FORGE_HOOK`, composed with any existing hooks); returns the uninstaller. */
  install(scene: Scene): () => void {
    const restoreBefore = prependRenderHook(scene, (renderer, _scene, camera) =>
      this.begin(camera, renderer as unknown as FrameSource),
    );
    const restoreAfter = prependAfterRenderHook(scene, () => this.end());
    return () => {
      restoreAfter();
      restoreBefore();
      this.reset();
    };
  }

  private flush(depth: number): void {
    const depths = this.endDepths;
    while (depths.length > 0 && depths[depths.length - 1]! >= depth) {
      const registered = depths.pop()!;
      this.endCallbacks.pop()!(registered);
    }
  }
}
