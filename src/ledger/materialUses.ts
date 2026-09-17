import type { Material } from 'three';

/** The registry surface `MaterialUses` reads: which material an instance resolves to, and when those answers moved. */
export interface UsesRegistry {
  /** The material `register()` would return for this one, or undefined when the registry does not know it. */
  canonicalOf(material: Material): Material | undefined;
  /** Moves whenever cached keys are dropped (`invalidate()`, `forget()`); see `MaterialRegistry.keysRevision`. */
  readonly keysRevision: number;
}

/**
 * A canonical material's marks for the frame in progress: one per material the ledger has seen, reused frame after
 * frame and reset when first used in a new frame. It holds no material or object, so a mark outliving its frame
 * retains nothing.
 */
interface MaterialMark {
  /** The frame stamp the fields below belong to. */
  frame: number;
  /** `SubmissionRecord.material`: the order this frame first drew the material in. */
  index: number;
  /** The `Object3D.id` of the first object that counted a use of the material this frame, or -1. */
  user: number;
  /** Another object counted a use of it this frame too. */
  shared: boolean;
}

/**
 * The frame's material uses: the per-frame index every submission record carries (`SubmissionRecord.material`, in
 * first-draw order) and the mark behind the `static-unbatched` relabel — whether more than one object counted a use of
 * a material in the frame. Materials are keyed by the registry's canonical, by identity rather than by hashes, so
 * materials the registry deliberately keeps apart (instance functions, own data) stay apart.
 *
 * The canonical of a drawn material is resolved at most once per material instance per frame, and again once
 * `registry.keysRevision` moves, even mid-frame — the same memo and the same invalidation the ledger's hash reads use.
 * A material whose canonical changes without moving that revision (a `register()` call made between two
 * draws of the same frame) keeps the canonical the frame started with, as its hashes do.
 */
export class MaterialUses {
  private readonly registry: UsesRegistry;
  /** Canonical material → its marks. Reused frame after frame; a mark resets when the frame first uses it. */
  private readonly marks = new WeakMap<Material, MaterialMark>();
  /** This frame's marks by index; entries from `count` on are earlier frames' and never read. */
  private readonly byIndex: MaterialMark[] = [];
  private count = 0;
  /** Frames begun: marks compare against it, so nothing is cleared between frames. */
  private frameStamp = 0;
  /** This frame's resolved marks, by the material instance drawn. Cleared at frame boundaries and on a key revision. */
  private readonly resolved = new Map<Material, MaterialMark>();
  private revision = -1;
  private lastMaterial: Material | null = null;
  private lastMark: MaterialMark | null = null;

  constructor(registry: UsesRegistry) {
    this.registry = registry;
  }

  /** Starts a frame: indices begin again at 0 and every mark resets on its first use. */
  beginFrame(): void {
    this.frameStamp++;
    this.count = 0;
    this.clear();
  }

  /** Drops the per-frame memo, so nothing here holds a material between frames. */
  clear(): void {
    this.resolved.clear();
    this.lastMaterial = null;
    this.lastMark = null;
  }

  /**
   * Files one submission's material and returns its index for the record. `counts` says whether this submission counts
   * as a use — the ledger passes true for a main-pass submission that is not renderer-internal — and uses count per
   * object, so an object the main pass draws twice (the back-side pass of a double-sided transmissive material) is one
   * use. A submission that does not count is still indexed: every record carries a material index.
   */
  use(material: Material, objectId: number, counts: boolean): number {
    const mark = this.markOf(material);
    if (counts) {
      if (mark.user === -1) mark.user = objectId;
      else if (mark.user !== objectId) mark.shared = true;
    }
    return mark.index;
  }

  /** Whether more than one object counted a use of the material at `index` this frame. */
  shared(index: number): boolean {
    return this.byIndex[index]!.shared;
  }

  private markOf(material: Material): MaterialMark {
    const revision = this.registry.keysRevision;
    if (revision !== this.revision) {
      // invalidate() or forget() dropped cached keys: resolve every material again, even mid-frame.
      this.clear();
      this.revision = revision;
    } else if (material === this.lastMaterial) {
      return this.lastMark!;
    }
    let mark = this.resolved.get(material);
    if (mark === undefined) {
      const canonical = this.registry.canonicalOf(material) ?? material;
      mark = this.marks.get(canonical);
      if (mark === undefined) {
        mark = { frame: -1, index: 0, user: -1, shared: false };
        this.marks.set(canonical, mark);
      }
      if (mark.frame !== this.frameStamp) {
        mark.frame = this.frameStamp;
        mark.index = this.count;
        mark.user = -1;
        mark.shared = false;
        this.byIndex[this.count++] = mark;
      }
      this.resolved.set(material, mark);
    }
    this.lastMaterial = material;
    this.lastMark = mark;
    return mark;
  }
}
