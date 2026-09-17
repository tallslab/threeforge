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

/** The part of a material's cached keys the ledger reads for every submission (`keys`). */
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

/** `MaterialKeys` plus the two hashes derived from it, computed and cached together. */
type CachedKeys = MaterialKeys & { programHash: string; variantHash: string };

/** The key `canonicalByFullKey` is indexed by: same variant and colour merge into one canonical. */
function fullKeyOf(keys: Pick<CachedKeys, 'variantKey' | 'colorKey'>): string {
  return `${keys.variantKey}|#${keys.colorKey}`;
}

/**
 * Every material passes through here. Identical-by-value materials collapse to one canonical instance;
 * everything else is recorded as a colour, uniform or shader variant so the ledger can attribute cost.
 *
 * A material is immutable once registered: `register()` and `describe()` compute its keys once and cache them, and
 * nothing here re-reads a material's properties after that first pass. Mutating a registered material afterwards is
 * outside the contract: anything already built from its old keys (a BatchedMesh, a sprite batch) stays built from
 * them. `invalidate()` and `forget()` are the two ways to react to it, and `dependentsOf()` supports using `forget()`
 * safely around disposal.
 */
export class MaterialRegistry {
  private readonly keyCache = new WeakMap<Material, CachedKeys>();
  private readonly records = new Map<Material, { outcome: RegisterOutcome; canonical: Material | null }>();
  private readonly canonicalByFullKey = new Map<string, Material>();
  private readonly programs = new Map<string, ProgramEntry>();
  private revision = 0;

  /**
   * Moves whenever `invalidate()` or `forget()` drops a material's cached keys, and at no other time. A caller that
   * memoizes `keys()` results (the ledger does, per frame) reads again when it changes.
   */
  get keysRevision(): number {
    return this.revision;
  }

  register(material: Material): Material {
    const existing = this.records.get(material);
    if (existing) return existing.canonical ?? material;

    const keys = this.keys(material);
    if (keys.unsupported) {
      this.records.set(material, { outcome: 'unsupported', canonical: null });
      return material;
    }

    const fullKey = fullKeyOf(keys);
    const canonical = this.canonicalByFullKey.get(fullKey);
    const program = this.ensureProgram(keys, material);
    program.materials++;

    if (canonical) {
      this.records.set(material, { outcome: 'merged', canonical });
      return canonical;
    }

    const outcome = this.outcomeFor(program, keys.variantKey);
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
   * Re-keys `material` after it was mutated outside the immutable-once-registered contract: its current properties
   * are read again, the cached keys are replaced, and every index entry filed under the old keys moves with them.
   * The old entries are removed before the new keys are computed: a stale `canonicalByFullKey` entry would otherwise
   * let an unrelated material built later with `material`'s old property values merge into it and render with its
   * mutated state.
   *
   * Re-filing follows `register()`: `material` stays (or becomes) the canonical when no other canonical holds the
   * new key, else its record is demoted to `{ outcome: 'merged', canonical: <that material> }`. Materials already
   * merged into `material` keep their records untouched and keep resolving to it; re-keying the dependents of a
   * mutated shared material is the app's job (`dependentsOf(material)` counts them).
   *
   * A no-op for a material never registered, or recorded `unsupported` (never indexed by key); `describe()`
   * recomputes its keys lazily on the next call either way.
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
    this.deindex(material, oldKeys, wasCanonical);
    const newKeys = this.keys(material);

    const fullKey = fullKeyOf(newKeys);
    const existingCanonical = this.canonicalByFullKey.get(fullKey);
    const program = this.ensureProgram(newKeys, material);
    program.materials++;

    if (existingCanonical && existingCanonical !== material) {
      this.records.set(material, { outcome: 'merged', canonical: existingCanonical });
      return;
    }

    // The outcome `register()` computes is about registration order and first-seen state. A material that was already
    // the canonical keeps the outcome recorded at registration (classifying it again would read its own entries, still
    // in `program.canonicals`/`variants`). One promoted from merged back to canonical was never classified, so it is
    // classified as a fresh registration would be, before it joins the sets below.
    const outcome = wasCanonical ? record.outcome : this.outcomeFor(program, newKeys.variantKey);

    program.variants.add(newKeys.variantKey);
    program.canonicals.add(material);
    this.canonicalByFullKey.set(fullKey, material);
    this.records.set(material, { outcome, canonical: material });
  }

  /**
   * Removes `material` from the registry as if it had never been registered: its cached keys and record are dropped,
   * its program's bookkeeping is unwound, and a canonical's `canonicalByFullKey` and program entries are cleared
   * (`deindex()`, shared with `invalidate()`). `World.decompile()`
   * and `ResourceTracker.release()` call it for the materials they release. Forgetting an unknown material is a no-op.
   *
   * Dependents are neither tracked nor released. Materials merged into `material` keep resolving to this exact object
   * through `register()`/`canonicalOf()`, and every mesh built while it was the canonical still draws with it, so
   * `forget()` returning does not make its GPU resources safe to dispose: check `dependentsOf(material) === 0` first,
   * or forget (and arrange disposal for) every dependent.
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
    if (record.outcome === 'unsupported') return; // never indexed; nothing to deindex
    this.deindex(material, keys, record.canonical === material);
  }

  /**
   * How a material that is becoming a canonical is labelled: the first canonical of the first program is `new`, the
   * first of any later program a `shader-variant`, and inside a program a repeat of a known `variantKey` is a
   * `color-variant` while a new one is a `uniform-variant`. Reads `program`'s state as it is, so callers must ask
   * before adding the material to `canonicals`/`variants`. Shared by `register()` and `invalidate()`'s promotion
   * branch, which has to classify a material promoted from merged exactly as a fresh registration would.
   */
  private outcomeFor(program: ProgramEntry, variantKey: string): RegisterOutcome {
    if (program.canonicals.size === 0) return this.programs.size === 1 ? 'new' : 'shader-variant';
    return program.variants.has(variantKey) ? 'color-variant' : 'uniform-variant';
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
      program = {
        type: material.type,
        description: keys.description,
        variants: new Set(),
        canonicals: new Set(),
        materials: 0,
      };
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
   * `records` and `keyCache`. Shared by `forget()` (removing a material for good) and `invalidate()` (removing it
   * from its old keys before re-filing it under new ones).
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

  /**
   * `registered`, `merged` and `unsupported` are read off `records` here, in one pass like `dependentsOf()`: a
   * material is registered once however many times `register()` saw it, merged while its record resolves to another
   * material, unsupported while its record says so. Not a per-frame call, so nothing keeps counters in step through
   * `register()`, `invalidate()` and `forget()`.
   */
  stats(): RegistryStats {
    let merged = 0;
    let unsupported = 0;
    for (const record of this.records.values()) {
      if (record.outcome === 'merged') merged++;
      else if (record.outcome === 'unsupported') unsupported++;
    }
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
      registered: this.records.size,
      canonical: this.canonicalByFullKey.size,
      merged,
      unsupported,
      programs: this.programs.size,
      byProgram,
    };
  }

  /**
   * The raw keys for a material, plus their `programHash`/`variantHash`, computed once and cached: the hashes,
   * description and `unsupported` flag `describe()` reports, read straight from the key cache. Nothing is allocated
   * and no key or hash is recomputed once the material has been keyed (an unregistered material is keyed and cached
   * on first use, as `describe()` does). The result is the cache entry itself. `invalidate()` and `forget()` replace
   * an entry rather than change it, so a result held from before keeps its old values; after either, `keys()` returns
   * the re-keyed entry and `keysRevision` has moved. For per-submission callers such as the ledger (`MaterialHashes`
   * is the slice it reads); `describe()` adds the outcome, colours and canonical.
   */
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
