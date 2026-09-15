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

interface ProgramEntry {
  type: string;
  description: string;
  variants: Set<string>;
  canonicals: Set<Material>;
  materials: number;
}

/** `MaterialKeys` plus the two hashes derived from it, computed and cached together (Ruling R6). */
type CachedKeys = MaterialKeys & { programHash: string; variantHash: string };

/**
 * Every material passes through here. Identical-by-value materials collapse to one canonical instance;
 * everything else is recorded as a colour, uniform or shader variant so the ledger can attribute cost.
 *
 * A material is immutable once registered: `register()` and `describe()` compute its keys once and cache them
 * (this class never re-reads a material's properties after that first pass). Mutating a registered material's
 * properties afterwards is outside the contract — anything already built from its old keys (a BatchedMesh, a
 * sprite batch) stays built from them. `invalidate()` and `forget()` are the two ways to react to it: see their
 * doc comments.
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

    const programHash = keys.programHash;
    const fullKey = `${keys.variantKey}|#${keys.colorKey}`;
    const canonical = this.canonicalByFullKey.get(fullKey);
    let program = this.programs.get(programHash);
    if (!program) {
      program = { type: material.type, description: keys.description, variants: new Set(), canonicals: new Set(), materials: 0 };
      this.programs.set(programHash, program);
    }
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

  /** The material `register()` would return for this one, without registering it. */
  canonicalOf(material: Material): Material | undefined {
    return this.records.get(material)?.canonical ?? undefined;
  }

  /**
   * Drops the cached keys for `material` so the next `keys()` / `describe()` call recomputes them from its
   * current property values. This does not touch what `register()` already decided (its outcome, its canonical,
   * `stats()`): anything built from the old keys stays built from them, per the immutability contract on this
   * class. Use it to keep `describe()`'s reporting (hashes, `colorHex`/`colorKey`, `description`) accurate after
   * code outside that contract mutates an already-registered material — for example a live material editor.
   */
  invalidate(material: Material): void {
    this.keyCache.delete(material);
  }

  /**
   * Removes `material` from the registry entirely, as if it had never been registered: its cached keys and
   * registration record are dropped, `registered`/`merged`/`unsupported` and its program's bookkeeping are
   * unwound, and — when it was itself a canonical — its entry in `canonicalByFullKey` and its program's
   * `canonicals`/`variants` sets are cleared too. Not wired into disposal in this task: `World.decompile()` and
   * `ResourceTracker` start calling it in a later phase.
   *
   * Forgetting a canonical that other materials were merged into does not break those materials — `records`
   * still points them at that exact `Material` object, which keeps working — but the registry can no longer
   * find it by key, so a future material with the same keys registers as a new canonical rather than merging
   * into it. Forgetting an unknown material is a no-op.
   */
  forget(material: Material): void {
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

    const program = this.programs.get(keys.programHash);

    if (record.canonical !== material) {
      // Merged into some other canonical, which is untouched.
      this.merged--;
      if (program) {
        program.materials--;
        if (program.materials <= 0) this.programs.delete(keys.programHash);
      }
      return;
    }

    const fullKey = `${keys.variantKey}|#${keys.colorKey}`;
    if (this.canonicalByFullKey.get(fullKey) === material) this.canonicalByFullKey.delete(fullKey);
    if (program) {
      program.canonicals.delete(material);
      program.materials--;
      const variantStillUsed = [...program.canonicals].some((c) => this.keys(c).variantKey === keys.variantKey);
      if (!variantStillUsed) program.variants.delete(keys.variantKey);
      if (program.materials <= 0) this.programs.delete(keys.programHash);
    }
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
