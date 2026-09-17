import type { PassTracker } from './passTracker.js';

/**
 * The open passes that culled or served one object, innermost last, with strictly increasing depths. The batch and
 * instanced culling hooks share it: they keep their own per-layer data indexed by layer number, `pop` hands that number
 * to `restore` so the owner puts back what the layer changed, and `restoreAtEnd` asks the `PassTracker` to pop the
 * layers of the innermost open pass when that pass ends (from the scene's marked `onAfterRender`, after
 * `backend.finishRender`; or when the tracker resets).
 */
export class PassLayers {
  /** Layers on the stack. */
  size = 0;
  private readonly depths: number[] = [];
  private readonly ids: number[] = [];
  /** Per depth: the pass whose end is already set to pop this stack. */
  private readonly registered: number[] = [];
  private readonly endPass: (depth: number) => void;

  constructor(
    private readonly passes: PassTracker | undefined,
    private readonly restore: (layer: number) => void,
  ) {
    this.endPass = (depth) => {
      while (this.size > 0 && this.depths[this.size - 1]! >= depth) this.pop();
    };
  }

  /** The depth of the innermost layer, 0 when there is none. */
  get topDepth(): number {
    return this.size > 0 ? this.depths[this.size - 1]! : 0;
  }

  /** Pops the layers deeper than `depth` and those whose pass is over (their end already popped them unless a render threw). */
  popClosed(depth: number): void {
    while (this.size > 0) {
      const top = this.size - 1;
      if (this.depths[top]! <= depth && this.passes!.passAt(this.depths[top]!) === this.ids[top]) return;
      this.pop();
    }
  }

  /** Pushes a layer for the open pass `pass` at `depth` (by default the innermost open pass); returns its number. */
  push(depth: number, pass: number = this.passes!.pass): number {
    const layer = this.size++;
    this.depths[layer] = depth;
    this.ids[layer] = pass;
    return layer;
  }

  /** Pops the layers at `depth` and deeper when the innermost open pass (at `depth`) ends; registers once per pass. */
  restoreAtEnd(depth: number): void {
    const pass = this.passes!.pass;
    if (this.registered[depth] === pass) return;
    this.registered[depth] = pass;
    this.passes!.atEnd(this.endPass);
  }

  /** Pops the innermost layer, restoring it. */
  pop(): void {
    this.size--;
    this.restore(this.size);
  }

  /** Pops every layer. */
  clear(): void {
    while (this.size > 0) this.pop();
  }
}
