import { WebGLCoordinateSystem, type BatchedMesh, type Camera, type CoordinateSystem, type Intersection, type Material, type Mesh, type Object3D, type Scene, type Texture } from 'three';
import type { DrawCallLedger } from '../ledger/DrawCallLedger.js';
import { displayName } from '../ledger/reasons.js';
import { MaterialRegistry, type RegistryStats } from '../registry/MaterialRegistry.js';
import { batchStatics, type GroupReport, type Slot } from './batchStatics.js';
import { classify, type Classification } from './classify.js';
import { attachBvhCulling, type CullingHandle } from './culling.js';

/** Hidden originals live on this layer: invisible to default cameras and default raycasters, matrices still valid. */
export const FORGE_HIDDEN_LAYER = 31;

export interface WorldOptions {
  registry?: MaterialRegistry;
  ledger?: DrawCallLedger;
  policy?: 'tagged' | 'auto';
  /** `hide` (default) keeps originals in the graph on the hidden layer; `detach` removes them. Both reversible. */
  originals?: 'hide' | 'detach';
  /** `bvh` (default) installs O(log n) per-instance frustum culling on every batch; `linear` keeps three's scan. */
  culling?: 'bvh' | 'linear';
}

export interface CompileOptions {
  /** `renderer.coordinateSystem`; needed for BVH frustum planes. Defaults to WebGL. */
  coordinateSystem?: CoordinateSystem;
}

export interface CompileReport {
  before: { meshes: number; materials: number };
  after: { batches: number; meshes: number };
  groups: GroupReport[];
  skipped: { name: string; rule: string }[];
  registry: RegistryStats;
  culling: { mode: 'bvh' | 'linear'; coordinateSystem: CoordinateSystem };
}

export interface WarmupRenderer {
  compileAsync(scene: Object3D, camera: Camera): Promise<unknown>;
  initTexture?(texture: Texture): void;
}

interface OriginalState {
  mesh: Mesh;
  parent: Object3D;
  index: number;
  layersMask: number;
  matrixAutoUpdate: boolean;
}

/**
 * Rewrites a scene in place: statics become BatchedMesh instances, every remaining material is canonicalised,
 * and everything is reversible with `decompile()`. Three.js keeps rendering the same `scene` object.
 */
export class World {
  readonly scene: Scene;
  readonly registry: MaterialRegistry;
  readonly ledger: DrawCallLedger | undefined;
  private readonly policy: 'tagged' | 'auto';
  private readonly originalsMode: 'hide' | 'detach';
  private readonly cullingMode: 'bvh' | 'linear';
  private cullingHandles = new Map<BatchedMesh, CullingHandle>();
  private batches: BatchedMesh[] = [];
  private slots = new Map<Mesh, Slot>();
  private originalsByBatch = new Map<BatchedMesh, Mesh[]>();
  private hidden: OriginalState[] = [];
  private materialSwaps: { mesh: Mesh; material: Material }[] = [];
  private compiled = false;

  constructor(scene: Scene, options: WorldOptions = {}) {
    this.scene = scene;
    this.registry = options.registry ?? options.ledger?.registry ?? new MaterialRegistry();
    this.ledger = options.ledger;
    this.policy = options.policy ?? 'tagged';
    this.originalsMode = options.originals ?? 'hide';
    this.cullingMode = options.culling ?? 'bvh';
  }

  /** The BVH culling handle for a batch, when `culling: 'bvh'` is active. */
  cullingOf(batch: BatchedMesh): CullingHandle | undefined {
    return this.cullingHandles.get(batch);
  }

  get batchedMeshes(): readonly BatchedMesh[] {
    return this.batches;
  }

  compile(options: CompileOptions = {}): CompileReport {
    if (this.compiled) throw new Error('World is already compiled; call decompile() first.');
    const coordinateSystem = options.coordinateSystem ?? WebGLCoordinateSystem;
    const classifications = classify(this.scene, { policy: this.policy });
    const before = {
      meshes: classifications.length,
      materials: new Set(classifications.flatMap((c) => (Array.isArray(c.object.material) ? c.object.material : [c.object.material]))).size,
    };

    const statics = classifications.filter((c) => c.kind === 'static').map((c) => c.object);
    const result = batchStatics(statics, this.registry, this.scene);
    this.batches = result.batches;
    this.slots = result.slots;
    this.originalsByBatch = result.originals;
    if (this.cullingMode === 'bvh') {
      for (const batch of this.batches) this.cullingHandles.set(batch, attachBvhCulling(batch, coordinateSystem));
    }

    // Record parent indices before touching the graph so detach/restore round-trips exactly.
    for (const mesh of result.slots.keys()) {
      const parent = mesh.parent;
      if (parent) this.hidden.push({ mesh, parent, index: parent.children.indexOf(mesh), layersMask: mesh.layers.mask, matrixAutoUpdate: mesh.matrixAutoUpdate });
    }
    for (const state of this.hidden) this.hideOriginal(state.mesh);

    const skipped: CompileReport['skipped'] = [];
    for (const c of classifications) {
      if (c.kind === 'static' && result.slots.has(c.object)) continue;
      const rule = c.kind === 'static' ? 'singleton' : c.rule;
      skipped.push({ name: displayName(c.object, this.scene), rule });
      if (c.kind === 'excluded') this.ledger?.annotate(c.object, `excluded:${c.rule}`);
      this.canonicalise(c.object);
    }

    this.compiled = true;
    return {
      before,
      after: { batches: this.batches.length, meshes: classifications.length - result.slots.size },
      groups: result.groups,
      skipped,
      registry: this.registry.stats(),
      culling: { mode: this.cullingMode, coordinateSystem },
    };
  }

  /** Compile shaders and upload textures now instead of on first render. Call after `compile()`. */
  async warmup(renderer: WarmupRenderer, camera: Camera): Promise<void> {
    if (renderer.initTexture) {
      const textures = new Set<Texture>();
      this.scene.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          for (const value of Object.values(material as unknown as Record<string, unknown>)) {
            if ((value as Texture | null)?.isTexture) textures.add(value as Texture);
          }
        }
      });
      for (const texture of textures) renderer.initTexture(texture);
    }
    await renderer.compileAsync(this.scene, camera);
  }

  decompile(): void {
    if (!this.compiled) return;
    for (const batch of this.batches) {
      this.cullingHandles.get(batch)?.detach();
      batch.removeFromParent();
      (batch.material as Material).dispose();
      batch.dispose();
    }
    for (const swap of this.materialSwaps) swap.mesh.material = swap.material;
    const restore = [...this.hidden].sort((a, b) => a.index - b.index);
    for (const state of restore) {
      state.mesh.layers.mask = state.layersMask;
      state.mesh.matrixAutoUpdate = state.matrixAutoUpdate;
      if (this.originalsMode === 'detach') {
        state.parent.add(state.mesh);
        const children = state.parent.children;
        children.splice(children.indexOf(state.mesh), 1);
        children.splice(Math.min(state.index, children.length), 0, state.mesh);
      }
    }
    this.batches = [];
    this.slots = new Map();
    this.originalsByBatch = new Map();
    this.cullingHandles = new Map();
    this.hidden = [];
    this.materialSwaps = [];
    this.compiled = false;
  }

  slotOf(mesh: Mesh): Slot | undefined {
    return this.slots.get(mesh);
  }

  /** The original mesh behind a raycast hit on a batch; the hit object itself otherwise. */
  resolve(intersection: Intersection): Object3D {
    const batch = intersection.object as BatchedMesh;
    if (batch.isBatchedMesh && intersection.batchId !== undefined) {
      const original = this.originalsByBatch.get(batch)?.[intersection.batchId];
      if (original) return original;
    }
    return intersection.object;
  }

  private hideOriginal(mesh: Mesh): void {
    if (this.originalsMode === 'detach') {
      mesh.removeFromParent();
    } else {
      mesh.layers.set(FORGE_HIDDEN_LAYER);
      mesh.matrixAutoUpdate = false;
    }
  }

  private canonicalise(mesh: Mesh): void {
    if (Array.isArray(mesh.material)) return;
    const canonical = this.registry.register(mesh.material);
    if (canonical !== mesh.material) {
      this.materialSwaps.push({ mesh, material: mesh.material });
      mesh.material = canonical;
    }
  }
}

export type { Classification };
