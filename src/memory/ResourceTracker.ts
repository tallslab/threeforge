import type { BufferGeometry, Material, Object3D, Texture } from 'three';
import { collectResources, emptyResourceSets, type ResourceSets } from './resources.js';

export interface ResourceTrackerOptions {
  /**
   * The scene's `MaterialRegistry`. A material it knows is shared across the scene and is never disposed here; when
   * the released owner was the last one holding it, it is dropped from the registry instead (`forget`), so the
   * registry's records stop keeping a material nothing references alive. `forget` and `dependentsOf` are optional:
   * without them a known material is simply left registered, as before.
   */
  registry?: {
    canonicalOf(material: Material): Material | undefined;
    forget?(material: Material): void;
    dependentsOf?(material: Material): number;
  };
}

export interface ReleaseReport {
  geometries: number;
  materials: number;
  textures: number;
}

export interface TrackerStats {
  owners: number;
  geometries: number;
  materials: number;
  textures: number;
}

/**
 * Reference-counted disposal. Each owner (a loaded subtree, a chunk, a screen) holds the resources reachable from
 * what it tracked; `release(owner)` disposes those no other owner still holds and detaches an Object3D owner.
 */
export class ResourceTracker {
  private readonly owners = new Map<object, ResourceSets>();
  private readonly options: ResourceTrackerOptions;

  constructor(options: ResourceTrackerOptions = {}) {
    this.options = options;
  }

  track(target: Object3D | BufferGeometry | Texture | Material, owner: object = target): this {
    let sets = this.owners.get(owner);
    if (!sets) this.owners.set(owner, (sets = emptyResourceSets()));
    const t = target as { isObject3D?: boolean; isBufferGeometry?: boolean; isTexture?: boolean; isMaterial?: boolean };
    if (t.isObject3D) collectResources(target as Object3D, sets);
    else if (t.isBufferGeometry) sets.geometries.add(target as BufferGeometry);
    else if (t.isTexture) sets.textures.add(target as Texture);
    else if (t.isMaterial) sets.materials.add(target as Material);
    return this;
  }

  /**
   * Disposes the owner's resources no other owner references; an Object3D owner is detached from its parent.
   *
   * A material the registry knows is still never disposed (it is shared with the rest of the scene), but one no
   * other owner holds any more is forgotten, so the registry does not keep it alive for the process's lifetime.
   * Materials merged into a canonical are forgotten before canonicals, and a canonical another *registered* material
   * still resolves to is kept: dropping it would leave that material pointing at an object the registry no longer
   * knows. Such a canonical is not revisited when its last dependent is released later; it stays registered.
   */
  release(owner: object): ReleaseReport {
    const report: ReleaseReport = { geometries: 0, materials: 0, textures: 0 };
    const sets = this.owners.get(owner);
    if (!sets) return report;
    this.owners.delete(owner);
    const others = [...this.owners.values()];
    const heldElsewhere = <T>(pick: (s: ResourceSets) => Set<T>, item: T): boolean => others.some((s) => pick(s).has(item));
    for (const g of sets.geometries) {
      if (heldElsewhere((s) => s.geometries, g)) continue;
      g.dispose();
      report.geometries++;
    }
    for (const t of sets.textures) {
      if (heldElsewhere((s) => s.textures, t)) continue;
      t.dispose();
      report.textures++;
    }
    const registry = this.options.registry;
    const forgettable: Material[] = [];
    for (const m of sets.materials) {
      const held = heldElsewhere((s) => s.materials, m);
      if (registry?.canonicalOf(m) !== undefined) {
        if (!held) forgettable.push(m);
        continue;
      }
      if (held) continue;
      m.dispose();
      report.materials++;
    }
    if (registry?.forget) {
      // Merged duplicates first, so `dependentsOf` below sees only the dependents this release does not also drop.
      for (const m of forgettable) if (registry.canonicalOf(m) !== m) registry.forget(m);
      for (const m of forgettable) {
        const canonical = registry.canonicalOf(m);
        if (canonical === undefined) continue; // already forgotten above
        if (canonical === m && (registry.dependentsOf?.(m) ?? 0) > 0) continue;
        registry.forget(m);
      }
    }
    if ((owner as Object3D).isObject3D) (owner as Object3D).removeFromParent();
    return report;
  }

  /** Releases every owner. */
  dispose(): void {
    for (const owner of [...this.owners.keys()]) this.release(owner);
  }

  stats(): TrackerStats {
    const all = emptyResourceSets();
    for (const s of this.owners.values()) {
      for (const g of s.geometries) all.geometries.add(g);
      for (const m of s.materials) all.materials.add(m);
      for (const t of s.textures) all.textures.add(t);
    }
    return { owners: this.owners.size, geometries: all.geometries.size, materials: all.materials.size, textures: all.textures.size };
  }
}
