import type { BufferGeometry, Material, Object3D, Texture } from 'three';
import {
  collectResources,
  disposeGeometries,
  emptyResourceSets,
  isRenderTargetTexture,
  type ResourceSets,
} from './resources.js';

export interface ResourceTrackerOptions {
  /**
   * The scene's `MaterialRegistry`. A material it knows is shared across the scene and is never disposed here; when
   * the released owner was the last one holding it, it is dropped from the registry instead (`forget`), so the
   * registry's records stop keeping a material nothing references alive. Both extra methods are optional: without
   * `forget` a known material is simply left registered, as before, and without `dependentsOf` only materials merged
   * into a canonical are forgotten — a canonical cannot be shown free of dependents, so it is kept.
   */
  registry?: {
    canonicalOf(material: Material): Material | undefined;
    forget?(material: Material): void;
    dependentsOf?(material: Material): number;
  };
  /**
   * The scene the owners live in. A released interleaved geometry stays uploaded while a mesh in it that the tracker
   * was never given reads the same `InterleavedBuffer` (see `disposeGeometries`). An Object3D owner still attached
   * when it is released finds its own root, so this is for owners that are not objects, or are detached already.
   */
  scene?: Object3D;
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

/** The top of the graph `object` hangs in, or undefined when it hangs in none. */
function rootOf(object: Object3D): Object3D | undefined {
  let root = object.parent ?? undefined;
  while (root?.parent) root = root.parent;
  return root;
}

/**
 * Reference-counted disposal. Each owner (a loaded subtree, a chunk, a screen) holds the resources reachable from
 * what it tracked; `release(owner)` disposes those no other owner still holds and detaches an Object3D owner.
 */
export class ResourceTracker {
  private readonly owners = new Map<object, ResourceSets>();
  /** Released geometries `disposeGeometries` left uploaded; the next release tries them again. */
  private left = new Set<BufferGeometry>();
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

  /** Disposes the materials no other owner holds, forgets the registry's, and returns how many it disposed. */
  private releaseMaterials(materials: Iterable<Material>, heldElsewhere: (material: Material) => boolean): number {
    let disposed = 0;
    const registry = this.options.registry;
    const forgettable: Material[] = [];
    for (const m of materials) {
      const held = heldElsewhere(m);
      if (registry?.canonicalOf(m) !== undefined) {
        if (!held) forgettable.push(m);
        continue;
      }
      if (held) continue;
      m.dispose();
      disposed++;
    }
    if (registry?.forget) {
      // Merged duplicates first, so `dependentsOf` below sees only the dependents this release does not also drop.
      for (const m of forgettable) if (registry.canonicalOf(m) !== m) registry.forget(m);
      for (const m of forgettable) {
        const canonical = registry.canonicalOf(m);
        if (canonical === undefined) continue; // already forgotten above
        // Without `dependentsOf` there is no way to show nothing still merges into this canonical, so it is kept.
        if (canonical === m && (registry.dependentsOf === undefined || registry.dependentsOf(m) > 0)) continue;
        registry.forget(m);
      }
    }
    return disposed;
  }

  /**
   * Detaches an Object3D owner and returns the scene whose other meshes may read its buffers. Detached before that
   * scene is read: the owner's own meshes must not count as readers of the buffers it gives up.
   */
  private detach(owner: object): Object3D | undefined {
    const object = (owner as Object3D).isObject3D ? (owner as Object3D) : undefined;
    const scene = this.options.scene ?? (object && rootOf(object));
    object?.removeFromParent();
    return scene;
  }

  /**
   * Disposes the owner's resources no other owner references; an Object3D owner is detached from its parent.
   *
   * A material the registry knows is still never disposed (it is shared with the rest of the scene), but one no
   * other owner holds any more is forgotten, so the registry does not keep it alive for the process's lifetime.
   * Materials merged into a canonical are forgotten before canonicals, and a canonical another *registered* material
   * still resolves to is kept: dropping it would leave that material pointing at an object the registry no longer
   * knows. Such a canonical is not revisited when its last dependent is released later; it stays registered. A
   * registry without `dependentsOf` keeps every canonical, since none of them can be shown free.
   */
  release(owner: object): ReleaseReport {
    const report: ReleaseReport = { geometries: 0, materials: 0, textures: 0 };
    const sets = this.owners.get(owner);
    if (!sets) return report;
    this.owners.delete(owner);
    const others = [...this.owners.values()];
    const heldElsewhere = <T>(pick: (s: ResourceSets) => Set<T>, item: T): boolean =>
      others.some((s) => pick(s).has(item));
    const inUse = new Set(others.flatMap((s) => [...s.geometries]));
    const scene = this.detach(owner);
    // What the rest of the scene still reaches, the tracker's owners or not: reaching a resource is not owning it.
    const elsewhere = scene ? collectResources(scene) : undefined;
    const geometries = disposeGeometries([...sets.geometries, ...this.left], inUse, () => elsewhere?.geometries ?? []);
    this.left = new Set(geometries.left);
    report.geometries = geometries.disposed;
    for (const t of sets.textures) {
      if (heldElsewhere((s) => s.textures, t) || elsewhere?.textures.has(t) || isRenderTargetTexture(t)) continue;
      t.dispose();
      report.textures++;
    }
    for (const targets of sets.targetOwners)
      if (!heldElsewhere((s) => s.targetOwners, targets) && !elsewhere?.targetOwners.has(targets)) targets.dispose();
    report.materials = this.releaseMaterials(sets.materials, (m) => heldElsewhere((o) => o.materials, m));
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
    return {
      owners: this.owners.size,
      geometries: all.geometries.size,
      materials: all.materials.size,
      textures: all.textures.size,
    };
  }
}
