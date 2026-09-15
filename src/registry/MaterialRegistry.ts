import type { Material } from 'three';
import { computeMaterialKeys, hashKey, type MaterialKeys } from './materialKey.js';

export type RegisterOutcome =
  | 'new'
  | 'merged'
  | 'color-variant'
  | 'uniform-variant'
  | 'shader-variant'
  | 'unsupported'
  | 'unregistered';

export interface MaterialDescription {
  programHash: string;
  variantHash: string;
  /** `color.getHexString()`: display-only 8-bit sRGB hex. */
  colorHex: string;
  /** Exact linear-float encoding of `color`. Identity/grouping key (e.g. sprite batching); never for display. */
  colorKey: string;
  outcome: RegisterOutcome;
  description: string;
  unsupported: boolean;
  /** The material `register()` returned for this one (itself when canonical). */
  canonical: Material | null;
}

export interface ProgramStats {
  programHash: string;
  type: string;
  description: string;
  /** Distinct uniform variants under this program. */
  variants: number;
  /** Distinct canonical materials (variant x colour) under this program. */
  colorVariants: number;
  /** Materials registered under this program, including merged duplicates. */
  materials: number;
}

export interface RegistryStats {
  registered: number;
  canonical: number;
  merged: number;
  unsupported: number;
  programs: number;
  byProgram: ProgramStats[];
}

/** The part of a material's cached keys the ledger reads for every submission (`hashesOf`). */
export interface MaterialHashes {
  readonly programHash: string;
  readonly variantHash: string;
  readonly description: string;
  readonly unsupported: boolean;
}

interface ProgramEntry {
  type: string;
  description: string;
  variants: Set<string>;
  canonicals: Set<Material>;
  materials: number;
}

/** `MaterialKeys` plus the two hashes derived from it, computed and cached together (Ruling R6). */
type CachedKeys = MaterialKeys & { programHash: string; variantHash: string };

/** The key `canonicalByFullKey` is indexed by: same variant and colour merge into one canonical. */
function fullKeyOf(keys: Pick<CachedKeys, 'variantKey' | 'colorKey'>): string {
  return `${keys.variantKey}|#${keys.colorKey}`;
}

/**
 * Every material passes through here. Identical-by-value materials collapse to one canonical instance;
 * everything else is recorded as a colour, uniform or shader variant so the ledger can attribute cost.
 *
 * A material is immutable once registered: `register()` and `describe()` compute its keys once and cache them
 * (this class never re-reads a material's properties after that first pass). Mutating a registered material's
 * properties afterwards is outside the contract — anything already built from its old keys (a BatchedMesh, a
 * sprite batch) stays built from them. `invalidate()` and `forget()` are the two ways to react to it, and
 * `dependentsOf()` supports using `forget()` safely around disposal: see their doc comments.
 */
export class MaterialRegistry {
  private readonly keyCache = new WeakMap<Material, CachedKeys>();
  private readonly records = new Map<Material, { outcome: RegisterOutcome; canonical: Material | null }>();
  private readonly canonicalByFullKey = new Map<string, Material>();
  private readonly variantsByKey = new Map<string, string>();
  private readonly programs = new Map<string, ProgramEntry>();
  private registered = 0;
  private merged = 0;
  private unsupported = 0;
  private revision = 0;

  /**
   * Moves whenever `invalidate()` or `forget()` drops a material's cached keys, and at no other time. A caller that
   * memoizes `hashesOf()` results (the ledger does, per frame) reads again when it changes.
   */
  get keysRevision(): number {
    return this.revision;
  }

  register(material: Material): Material {
    this.registered++;
    const existing = this.records.get(material);
    if (existing) return existing.canonical ?? material;

    const keys = this.keys(material);
    if (keys.unsupported) {
      this.unsupported++;
      this.records.set(material, { outcome: 'unsupported', canonical: null });
      return material;
    }

    const fullKey = fullKeyOf(keys);
    const canonical = this.canonicalByFullKey.get(fullKey);
    const program = this.ensureProgram(keys, material);
    program.materials++;

    if (canonical) {
      this.merged++;
      this.records.set(material, { outcome: 'merged', canonical });
      return canonical;
    }

    let outcome: RegisterOutcome;
    if (program.canonicals.size === 0) outcome = this.programs.size === 1 ? 'new' : 'shader-variant';
    else if (program.variants.has(keys.variantKey)) outcome = 'color-variant';
    else outcome = 'uniform-variant';

    program.variants.add(keys.variantKey);
    program.canonicals.add(material);
    this.canonicalByFullKey.set(fullKey, material);
    this.records.set(material, { outcome, canonical: material });
    return material;
  }

  describe(material: Material): MaterialDescription {
    const keys = this.keys(material);
    const record = this.records.get(material);
    return {
      programHash: keys.programHash,
      variantHash: keys.variantHash,
      colorHex: keys.colorHex,
      colorKey: keys.colorKey,
      outcome: record?.outcome ?? 'unregistered',
      description: keys.description,
      unsupported: keys.unsupported,
      canonical: record?.canonical ?? null,
    };
  }

  /**
   * The hashes, description and `unsupported` flag `describe()` reports, read straight from the key cache (Ruling R6):
   * nothing is allocated and no key or hash is recomputed once the material has been keyed (an unregistered material
   * is keyed and cached on first use, as `describe()` does). The result is the cache entry itself. `invalidate()` and
   * `forget()` replace an entry rather than change it, so a result held from before keeps its old values; after
   * either, `hashesOf()` returns the re-keyed hashes and `keysRevision` has moved. For per-submission callers such as
   * the ledger; `describe()` adds the outcome, colours and canonical.
   */
  hashesOf(material: Material): MaterialHashes {
    return this.keys(material);
  }

  /** The material `register()` would return for this one, without registering it. */
  canonicalOf(material: Material): Material | undefined {
    return this.records.get(material)?.canonical ?? undefined;
  }

  /**
   * How many other registered materials currently resolve to `material` as their canonical (an `outcome:
   * 'merged'` record whose `canonical` is this exact object) — `material` does not count itself. Read-only: a
   * live count taken by scanning `records`, never cached, so it can't go stale.
   *
   * Exists for `forget()`'s disposal hazard (see its doc comment): before disposing a canonical's GPU resources,
   * check `dependentsOf(material) === 0`. Kept a plain linear scan rather than a maintained reverse index, since
   * `MaterialRegistry` has no other by-canonical lookup to justify the bookkeeping cost of keeping one in sync
   * through every `register()`/`invalidate()`/`forget()`.
   */
  dependentsOf(material: Material): number {
    let count = 0;
    for (const [other, record] of this.records) {
      if (other !== material && record.canonical === material) count++;
    }
    return count;
  }

  /**
   * Re-keys `material` after it was mutated outside the immutable-once-registered contract: current property
   * values are read again, and the result replaces both the cached keys (so `describe()` reports them) and every
   * index entry `register()` filed under the *old* keys, which is what closes the defect this method exists to
   * fix — see the "stale index entries" history in `docs/threeforge.md` section 5 / the commit that added this
   * comment for the trace. Concretely:
   *
   * 1. If `material` was itself the canonical for its old key, that old `canonicalByFullKey` entry and its
   *    program's `canonicals`/`variants` bookkeeping are removed first (shared with `forget()`'s removal via
   *    `deindex()`) — otherwise a *different*, unrelated material built later with `material`'s old property
   *    values would still find the stale entry and merge into `material`, rendering with its new, mutated state.
   * 2. Its keys are recomputed from its current properties and cached.
   * 3. It is re-filed under the new key: if no other canonical already holds that key, `material` stays (or
   *    becomes) the canonical for it, added back to `canonicalByFullKey` and its (possibly different) program.
   *    If another canonical already holds the new key, `material`'s own record is demoted to
   *    `{ outcome: 'merged', canonical: <that other material> }` instead — the same outcome a fresh material
   *    with those exact properties would get from `register()`.
   *
   * A material already merged into `material` before this call keeps its own record — `{ outcome: 'merged',
   * canonical: material }` — completely untouched, so it keeps resolving to `material` (a live, valid `Material`
   * object) even though `material`'s properties have since changed. Re-keying the canonical after the app
   * mutates a shared material is the app's choice; `invalidate` does not chase down and re-key every dependent to
   * match (`dependentsOf(material)` tells you how many there are, if you need to decide).
   *
   * A no-op for a material that was never registered, or one recorded `unsupported` (never indexed by key here;
   * `describe()` will recompute its keys lazily on the next call regardless, same as before).
   */
  invalidate(material: Material): void {
    this.revision++;
    const record = this.records.get(material);
    if (!record) {
      this.keyCache.delete(material);
      return;
    }

    const oldKeys = this.keys(material); // the pre-mutation keys: nothing has touched the cache yet
    this.keyCache.delete(material);

    if (record.outcome === 'unsupported') return; // never indexed; nothing to move

    const wasCanonical = record.canonical === material;

    // Step 1: remove whatever `material` held under its old keys (nothing, if it was a merged duplicate — it was
    // never itself indexed — but its program.materials tally still needs to move off the old program).
    this.deindex(material, oldKeys, wasCanonical);

    // Step 2: recompute and cache the new keys.
    const newKeys = this.keys(material);

    // Step 3: re-file under the new key. `stats().merged` (like `stats().registered`, shrunk by `forget()`) is a
    // live count of currently-merged materials, not a cumulative call counter, so it moves here too whenever
    // re-filing changes `material`'s own canonical/merged status.
    const fullKey = fullKeyOf(newKeys);
    const existingCanonical = this.canonicalByFullKey.get(fullKey);
    const program = this.ensureProgram(newKeys, material);
    program.materials++;

    if (existingCanonical && existingCanonical !== material) {
      if (wasCanonical) this.merged++; // was the canonical itself, now merges into someone else's
      this.records.set(material, { outcome: 'merged', canonical: existingCanonical });
      return;
    }

    // The new/color-variant/uniform-variant/shader-variant classification `register()` computes (below the
    // `program.canonicals.size === 0` check) is inherently about registration order and first-seen state; when
    // `material` was already the canonical, re-running it on every `invalidate()` call would be both wrong (its
    // own prior entries are still in `program.canonicals`/`variants` until the two lines after this) and
    // pointless (it wasn't a fresh registration), so that case keeps the outcome recorded at original
    // registration. But a material *promoted* from merged back to canonical here was never classified before —
    // its stale `outcome: 'merged'` would be actively wrong — so that case runs the same classification
    // `register()` would for a brand new canonical, in the same order (before adding it to the sets below).
    let outcome: RegisterOutcome;
    if (wasCanonical) {
      outcome = record.outcome;
    } else {
      this.merged--; // was merged into another canonical, now (re)becomes one itself
      if (program.canonicals.size === 0) outcome = this.programs.size === 1 ? 'new' : 'shader-variant';
      else if (program.variants.has(newKeys.variantKey)) outcome = 'color-variant';
      else outcome = 'uniform-variant';
    }

    program.variants.add(newKeys.variantKey);
    program.canonicals.add(material);
    this.canonicalByFullKey.set(fullKey, material);
    this.records.set(material, { outcome, canonical: material });
  }

  /**
   * Removes `material` from the registry entirely, as if it had never been registered: its cached keys and
   * registration record are dropped, `registered`/`merged`/`unsupported` and its program's bookkeeping are
   * unwound, and — when it was itself a canonical — its entry in `canonicalByFullKey` and its program's
   * `canonicals`/`variants` sets are cleared too (shared with `invalidate()`'s removal step via `deindex()`).
   * Not wired into disposal in this task: `World.decompile()` and `ResourceTracker` start calling it in a later
   * phase. Forgetting an unknown material is a no-op.
   *
   * **`forget` does not track or release dependents, and this is a real disposal hazard, not just bookkeeping.**
   * If `material` was a canonical that other registered materials were merged into (`dependentsOf(material) > 0`
   * beforehand), those materials' own records still point at this exact `Material` object and keep resolving to
   * it via `register()`/`canonicalOf()` after `forget()` — that part stays correct, nothing crashes. But
   * `forget()` returning is **not** a signal that `material`'s GPU resources are now safe to release: every one
   * of those dependents is still relying on this *exact* object rendering correctly (a `BatchedMesh`, a mesh's
   * `material` reference, anything built while it was the canonical). Calling `material.dispose()` (or disposing
   * its textures) right after `forget()` breaks every mesh still drawn with one of those merged materials — the
   * registry no longer stops you, and nothing else in this class will. Check `dependentsOf(material) === 0`
   * before disposing, or `forget()` (and, separately, arrange disposal for) every dependent first.
   */
  forget(material: Material): void {
    this.revision++;
    const record = this.records.get(material);
    if (!record) {
      this.keyCache.delete(material);
      return;
    }

    const keys = this.keys(material);
    this.keyCache.delete(material);
    this.records.delete(material);
    this.registered--;

    if (record.outcome === 'unsupported') {
      this.unsupported--;
      return;
    }

    if (record.canonical !== material) this.merged--;
    this.deindex(material, keys, record.canonical === material);
  }

  /**
   * Ensures a `ProgramEntry` exists for `keys.programHash` (creating one from `keys`/`material` if not) and
   * returns it, without incrementing `materials` — callers do that themselves, since `register()` counts every
   * registration (including merges) while `invalidate()` counts a re-file. Shared by `register()` and
   * `invalidate()`.
   */
  private ensureProgram(keys: CachedKeys, material: Material): ProgramEntry {
    let program = this.programs.get(keys.programHash);
    if (!program) {
      program = { type: material.type, description: keys.description, variants: new Set(), canonicals: new Set(), materials: 0 };
      this.programs.set(keys.programHash, program);
    }
    return program;
  }

  /**
   * Removes every index entry `material` was filed under by its OLD `keys`: when `wasCanonical` is true, its
   * `canonicalByFullKey` entry (only if it still points here — it may already have been overwritten or removed),
   * its program's `canonicals` set, and — when no other remaining canonical in that program still needs it —
   * its program's `variants` entry. Either way, the program's `materials` tally is decremented (the program
   * entry itself is dropped once it reaches zero). Only touches `programs`/`canonicalByFullKey`; the caller owns
   * `records`, `keyCache`, and the `registered`/`merged`/`unsupported` counters. Shared by `forget()` (removing a
   * material for good) and `invalidate()` (removing it from its old keys before re-filing it under new ones).
   */
  private deindex(material: Material, keys: CachedKeys, wasCanonical: boolean): void {
    const program = this.programs.get(keys.programHash);
    if (!program) return;

    if (wasCanonical) {
      const fullKey = fullKeyOf(keys);
      if (this.canonicalByFullKey.get(fullKey) === material) this.canonicalByFullKey.delete(fullKey);
      program.canonicals.delete(material);
      const variantStillUsed = [...program.canonicals].some((c) => this.keys(c).variantKey === keys.variantKey);
      if (!variantStillUsed) program.variants.delete(keys.variantKey);
    }

    program.materials--;
    if (program.materials <= 0) this.programs.delete(keys.programHash);
  }

  stats(): RegistryStats {
    const byProgram: ProgramStats[] = [...this.programs.entries()]
      .map(([programHash, p]) => ({
        programHash,
        type: p.type,
        description: p.description,
        variants: p.variants.size,
        colorVariants: p.canonicals.size,
        materials: p.materials,
      }))
      .sort((a, b) => b.materials - a.materials || a.programHash.localeCompare(b.programHash));
    return {
      registered: this.registered,
      canonical: this.canonicalByFullKey.size,
      merged: this.merged,
      unsupported: this.unsupported,
      programs: this.programs.size,
      byProgram,
    };
  }

  /** The raw keys for a material, plus their `programHash`/`variantHash` (computed once and cached; Ruling R6). */
  keys(material: Material): CachedKeys {
    let keys = this.keyCache.get(material);
    if (!keys) {
      const computed = computeMaterialKeys(material);
      keys = { ...computed, programHash: hashKey(computed.programKey), variantHash: hashKey(computed.variantKey) };
      this.keyCache.set(material, keys);
    }
    return keys;
  }
}
