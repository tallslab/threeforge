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
  colorHex: string;
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

/**
 * Every material passes through here. Identical-by-value materials collapse to one canonical instance;
 * everything else is recorded as a colour, uniform or shader variant so the ledger can attribute cost.
 * Keys are computed at registration time; a material mutated afterwards is not re-keyed.
 */
export class MaterialRegistry {
  private readonly keyCache = new WeakMap<Material, MaterialKeys>();
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

    const programHash = hashKey(keys.programKey);
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
      programHash: hashKey(keys.programKey),
      variantHash: hashKey(keys.variantKey),
      colorHex: keys.colorKey,
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

  /** The raw keys for a material (computed once and cached). */
  keys(material: Material): MaterialKeys {
    let keys = this.keyCache.get(material);
    if (!keys) {
      keys = computeMaterialKeys(material);
      this.keyCache.set(material, keys);
    }
    return keys;
  }
}
