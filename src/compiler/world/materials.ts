import type { BatchedMesh, InstancedMesh, Material, Mesh } from 'three';
import type { MaterialRegistry } from '../../registry/MaterialRegistry.js';
import type { BakedGroup } from '../batchStatics.js';

/** The materials one compile touched: the clones it owns, the canonical swaps it made, and how each is released. */
export class CompileMaterials {
  private readonly registry: MaterialRegistry;
  private readonly mode: 'canonical' | 'keep';
  /**
   * Batch and instanced materials the compiler created (white clones for per-instance colour); `decompile` disposes only
   * these. A material shared from the registry is the app's and stays usable.
   */
  private owned = new Set<Material>();
  private swaps: { mesh: Mesh; material: Material }[] = [];

  constructor(registry: MaterialRegistry, mode: 'canonical' | 'keep') {
    this.registry = registry;
    this.mode = mode;
  }

  // A batch draws with its group's canonical when every instance is white (the app's registered material, or an
  // unsupported one the registry kept as is), else with a white clone made here: only the clone is the World's to dispose.
  claimClones(targets: (BatchedMesh | InstancedMesh)[], originals: Map<BatchedMesh | InstancedMesh, Mesh[]>): void {
    for (const target of targets) {
      const material = target.material as Material;
      const shared = (originals.get(target) ?? []).some(
        (o) => o.material === material || this.registry.canonicalOf(o.material as Material) === material,
      );
      if (!shared) this.owned.add(material);
    }
  }

  canonicalise(mesh: Mesh): void {
    if (Array.isArray(mesh.material)) return;
    const canonical = this.registry.register(mesh.material);
    if (this.mode === 'keep') return;
    if (canonical !== mesh.material) {
      this.swaps.push({ mesh, material: mesh.material });
      mesh.material = canonical;
    }
  }

  /**
   * Every material this compile created and `decompile()` disposes: the white clones carrying per-instance colours
   * for batches and instanced groups, a baked group's vertex-colour clone, and the occlusion proxies' and sprite
   * batches' own materials. Never a material the app registered and the compiler only shared.
   */
  created(parts: {
    proxies: Material[];
    targets: (BatchedMesh | InstancedMesh)[];
    baked: BakedGroup[];
    spriteBatches: Material[];
  }): Material[] {
    const created: Material[] = [];
    for (const material of parts.proxies) created.push(material);
    for (const target of parts.targets) {
      const material = target.material as Material;
      if (this.owned.has(material)) created.push(material);
    }
    for (const b of parts.baked) if (b.ownsMaterial) created.push(b.mesh.material as Material);
    for (const material of parts.spriteBatches) created.push(material);
    return created;
  }

  /** Forgets each of `materials` that merged into another material (of this compile or the app's). */
  forgetMerged(materials: Material[]): void {
    for (const material of materials) {
      const canonical = this.registry.canonicalOf(material);
      if (canonical !== undefined && canonical !== material) this.registry.forget(material);
    }
  }

  /**
   * Drops a material this compile created from the registry and disposes it, so nothing the registry hands out ever
   * points at a disposed object. A canonical another *registered* material still merges into is left exactly as it
   * is — registered and undisposed — because that material resolves to this very object: disposing it would break
   * every mesh drawn with it, and forgetting it would leave it resolving to an object the registry no longer knows.
   * Such a material is the app's to release once it stops using the duplicate (`registry.dependentsOf`).
   */
  release(material: Material): void {
    const canonical = this.registry.canonicalOf(material);
    if (canonical !== undefined) {
      if (canonical === material && this.registry.dependentsOf(material) > 0) return;
      this.registry.forget(material);
    }
    material.dispose();
  }

  /** Releases `material` when this compile owns it (a batch's or instanced group's white clone). */
  releaseOwned(material: Material): void {
    if (this.owned.has(material)) this.release(material);
  }

  dropOwned(): void {
    this.owned = new Set();
  }

  /** Gives every canonicalised mesh its own material back. */
  restoreSwaps(): void {
    for (const swap of this.swaps) swap.mesh.material = swap.material;
    this.swaps = [];
  }
}
