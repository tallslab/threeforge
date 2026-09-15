import { Matrix4, type Object3D } from 'three';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

/**
 * The space of the root the compiler adds its objects to (the scene). Batches, instanced meshes, baked meshes and
 * sprite batches are children of that root, so three draws them with `root.matrixWorld`: instance data taken from an
 * original's `matrixWorld` has to be multiplied by the inverse of that matrix first, or a translated, turned or scaled
 * scene applies its transform twice.
 *
 * The inverse is cached. Every `update()` (and so every `toLocal()`) compares the root's 16 world-matrix elements
 * with the ones it was derived from and derives it again when any differs, so writes made after the scene moved
 * (matrix sync, `markDirty`, sprite fills) use the scene's current matrix. While the root's world matrix is the
 * identity, `toLocal()` copies the world matrix unchanged (no multiplication, bit for bit).
 *
 * The root's `matrixWorld` is read as it stands: three refreshes it at the start of every `render()`; outside a
 * render, call `root.updateMatrixWorld()` after moving it.
 */
export class SceneSpace {
  readonly root: Object3D;
  /** The inverse of the root's world matrix as of the last `update()` (the identity while the root has no transform). */
  readonly inverse = new Matrix4();
  /** The elements `inverse` was derived from. */
  private readonly seen = new Float64Array(IDENTITY);
  private identity = true;
  private columnX = 1;
  private columnY = 1;

  constructor(root: Object3D) {
    this.root = root;
  }

  /** The length of the root world matrix's first column (its x scale) as of the last `update()`. */
  get scaleX(): number {
    return this.columnX;
  }

  /** The length of the root world matrix's second column (its y scale) as of the last `update()`. */
  get scaleY(): number {
    return this.columnY;
  }

  /** Re-reads the root's world matrix, re-deriving the inverse if it changed; returns true when it is the identity. */
  update(): boolean {
    const e = this.root.matrixWorld.elements;
    const seen = this.seen;
    let i = 0;
    while (i < 16 && e[i] === seen[i]) i++;
    if (i === 16) return this.identity;
    let identity = true;
    for (let k = 0; k < 16; k++) {
      seen[k] = e[k]!;
      if (e[k] !== IDENTITY[k]) identity = false;
    }
    this.identity = identity;
    if (identity) {
      this.inverse.identity();
      this.columnX = 1;
      this.columnY = 1;
    } else {
      this.inverse.copy(this.root.matrixWorld).invert();
      this.columnX = Math.hypot(e[0]!, e[1]!, e[2]!);
      this.columnY = Math.hypot(e[4]!, e[5]!, e[6]!);
    }
    return identity;
  }

  /** Writes `world` expressed in the root's space into `out` (`inverse(root.matrixWorld) * world`) and returns `out`. */
  toLocal(world: Matrix4, out: Matrix4): Matrix4 {
    if (this.update()) return out.copy(world);
    return out.multiplyMatrices(this.inverse, world);
  }
}
