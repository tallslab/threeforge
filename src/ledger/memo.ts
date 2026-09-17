import type { Material } from 'three';

/** The registry surface the memo reads: when the answers it holds may have moved. */
export interface RevisionSource {
  /** Moves whenever cached keys are dropped (`invalidate()`, `forget()`); see `MaterialRegistry.keysRevision`. */
  readonly keysRevision: number;
}

/**
 * A per-frame memo of something resolved from a material: the ledger's registry reads (`MaterialRegistry.keys`) and
 * the material uses' canonical resolves both go through one. `get` resolves a material at most once between `clear()`
 * calls (the frame boundary) and answers the material just seen without a Map lookup: a scene draws the same material
 * many times in a row. It resolves everything again once `registry.keysRevision` moves — `invalidate()` or `forget()`
 * dropped cached keys — even in the middle of a frame; the fast path is dropped with the rest. Nothing here holds a
 * material between frames once cleared.
 */
export class PerFrameMemo<T> {
  private readonly registry: RevisionSource;
  private readonly resolve: (material: Material) => T;
  private readonly entries = new Map<Material, T>();
  private revision = -1;
  private lastMaterial: Material | null = null;
  private lastValue: T | null = null;

  constructor(registry: RevisionSource, resolve: (material: Material) => T) {
    this.registry = registry;
    this.resolve = resolve;
  }

  get(material: Material): T {
    const revision = this.registry.keysRevision;
    if (revision !== this.revision) {
      // invalidate() or forget() dropped cached keys: resolve every material again, even mid-frame.
      this.clear();
      this.revision = revision;
    } else if (material === this.lastMaterial) {
      return this.lastValue!;
    }
    let value = this.entries.get(material);
    if (value === undefined) {
      value = this.resolve(material);
      this.entries.set(material, value);
    }
    this.lastMaterial = material;
    this.lastValue = value;
    return value;
  }

  /** Drops every answer, so nothing here holds a material between frames. */
  clear(): void {
    this.entries.clear();
    this.lastMaterial = null;
    this.lastValue = null;
  }
}
