import { WebGLCoordinateSystem, type BatchedMesh, type Camera, type CoordinateSystem, type InstancedMesh, type Intersection, type Material, type Mesh, type Object3D, type Scene, type Texture } from 'three';
import type { DrawCallLedger } from '../ledger/DrawCallLedger.js';
import { displayName } from '../ledger/reasons.js';
import { MaterialRegistry, type RegistryStats } from '../registry/MaterialRegistry.js';
import { batchStatics, type GroupReport, type Slot } from './batchStatics.js';
import type { CulledInstancedMesh } from './instancing.js';
import { classify, exclusionRule, type Classification } from './classify.js';
import { attachBvhCulling, prependRenderHook, type CullingHandle } from './culling.js';

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
  /** Opaque geometry repeated at least this many times in one material group becomes an InstancedMesh (default 64). */
  instanceThreshold?: number;
  /**
   * `separate` (default): tagged dynamics stay their own draws. `batch-sync`: batchable dynamics join batches and
   * their world matrices are copied in whenever they change, before each cull. Colour changes are not synced.
   */
  dynamics?: 'separate' | 'batch-sync';
  /** World-space cell size. Splits each material group into one batch per cell: tight bounds for whole-chunk culling and a unit for streaming. */
  chunkSize?: number;
  /**
   * Level-of-detail by camera distance. Geometries need levels attached first (`await prepareLods(scene)`).
   * Level i is used from `distances[i-1]` onward; batches need `culling: 'bvh'` (the default) for this.
   */
  lod?: { distances: number[] };
}

export interface CompileOptions {
  /** `renderer.coordinateSystem`; needed for BVH frustum planes. Defaults to WebGL. */
  coordinateSystem?: CoordinateSystem;
}

export interface CompileReport {
  before: { meshes: number; materials: number };
  after: { batches: number; instanced: number; meshes: number };
  groups: GroupReport[];
  skipped: { name: string; rule: string }[];
  registry: RegistryStats;
  culling: { mode: 'bvh' | 'linear'; coordinateSystem: CoordinateSystem };
  /** Dynamics folded into batches with matrix sync (0 unless `dynamics: 'batch-sync'`). */
  synced: number;
  lod: { distances: number[] } | null;
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
  /** Synced dynamics stay in the graph with auto-updating matrices even in detach mode. */
  synced: boolean;
}

interface SyncEntry {
  mesh: Mesh;
  instanceId: number;
  last: Float32Array;
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
  private readonly instanceThreshold: number;
  private readonly dynamicsMode: 'separate' | 'batch-sync';
  private readonly chunkSize: number | undefined;
  private readonly lod: { distances: number[] } | null;
  private cullingHandles = new Map<BatchedMesh, CullingHandle>();
  private syncRestores: (() => void)[] = [];
  private syncedSet = new Set<Mesh>();
  private batches: BatchedMesh[] = [];
  private instanced: InstancedMesh[] = [];
  private slots = new Map<Mesh, Slot>();
  private originalsByBatch = new Map<BatchedMesh | InstancedMesh, Mesh[]>();
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
    this.instanceThreshold = options.instanceThreshold ?? 64;
    this.dynamicsMode = options.dynamics ?? 'separate';
    this.chunkSize = options.chunkSize;
    this.lod = options.lod ?? null;
  }

  get instancedMeshes(): readonly InstancedMesh[] {
    return this.instanced;
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
    // Dynamics that obey every batch rule can ride along and have their matrices synced each frame.
    const syncRule = new Map<Mesh, string | null>();
    if (this.dynamicsMode === 'batch-sync') {
      for (const c of classifications) {
        if (c.kind !== 'dynamic') continue;
        const rule = Array.isArray(c.object.material) ? 'multi-material' : exclusionRule(c.object);
        syncRule.set(c.object, rule);
        if (rule === null) statics.push(c.object);
      }
    }
    const result = batchStatics(statics, this.registry, this.scene, { instanceThreshold: this.instanceThreshold, coordinateSystem, chunkSize: this.chunkSize, ...(this.lod ? { lodDistances: this.lod.distances } : {}) });
    this.batches = result.batches;
    this.instanced = result.instanced;
    this.slots = result.slots;
    this.originalsByBatch = result.originals;
    if (this.cullingMode === 'bvh') {
      for (const batch of this.batches) {
        const geometryIds = result.lodGeometryIds.get(batch);
        const lod = this.lod && geometryIds ? { distances: this.lod.distances, geometryIds } : undefined;
        this.cullingHandles.set(batch, attachBvhCulling(batch, coordinateSystem, lod ? { lod } : {}));
      }
    }
    for (const [mesh, rule] of syncRule) if (rule === null && result.slots.has(mesh)) this.syncedSet.add(mesh);
    this.installSync(result.slots);

    // Record parent indices before touching the graph so detach/restore round-trips exactly.
    for (const mesh of result.slots.keys()) {
      const parent = mesh.parent;
      if (parent) {
        this.hidden.push({ mesh, parent, index: parent.children.indexOf(mesh), layersMask: mesh.layers.mask, matrixAutoUpdate: mesh.matrixAutoUpdate, synced: this.syncedSet.has(mesh) });
      }
    }
    for (const state of this.hidden) this.hideOriginal(state);

    const skipped: CompileReport['skipped'] = [];
    for (const c of classifications) {
      if (result.slots.has(c.object)) continue;
      let rule = c.kind === 'static' ? 'singleton' : c.rule;
      if (c.kind === 'dynamic') rule = syncRule.get(c.object) ?? rule;
      skipped.push({ name: displayName(c.object, this.scene), rule });
      if (c.kind === 'excluded') this.ledger?.annotate(c.object, `excluded:${c.rule}`);
      this.canonicalise(c.object);
    }

    this.compiled = true;
    return {
      before,
      after: { batches: this.batches.length, instanced: this.instanced.length, meshes: classifications.length - result.slots.size },
      groups: result.groups,
      skipped,
      registry: this.registry.stats(),
      culling: { mode: this.cullingMode, coordinateSystem },
      synced: this.syncedSet.size,
      lod: this.lod,
    };
  }

  /** Show or hide an original mesh, wherever it ended up. */
  setVisible(original: Mesh, visible: boolean): void {
    const slot = this.slots.get(original);
    if (!slot) {
      original.visible = visible;
      return;
    }
    const target = slot.batch as BatchedMesh | CulledInstancedMesh;
    if ((target as BatchedMesh).isBatchedMesh) (target as BatchedMesh).setVisibleAt(slot.instanceId, visible);
    else (target as CulledInstancedMesh).forgeCulling.setVisibleAt(slot.instanceId, visible);
  }

  private installSync(slots: Map<Mesh, Slot>): void {
    if (this.syncedSet.size === 0) return;
    const perTarget = new Map<BatchedMesh | InstancedMesh, SyncEntry[]>();
    for (const mesh of this.syncedSet) {
      const slot = slots.get(mesh)!;
      let list = perTarget.get(slot.batch);
      if (!list) perTarget.set(slot.batch, (list = []));
      list.push({ mesh, instanceId: slot.instanceId, last: Float32Array.from(mesh.matrixWorld.elements) });
    }
    for (const [target, entries] of perTarget) {
      // A synced instance can leave the precomputed bounds; per-instance culling still applies.
      target.frustumCulled = false;
      const batched = (target as BatchedMesh).isBatchedMesh ? (target as BatchedMesh) : null;
      const handle = batched ? this.cullingHandles.get(batched) : undefined;
      const instanced = batched ? null : (target as CulledInstancedMesh);
      const sync = (): void => {
        for (const entry of entries) {
          const e = entry.mesh.matrixWorld.elements;
          const last = entry.last;
          let changed = false;
          for (let i = 0; i < 16; i++) {
            if (e[i] !== last[i]) {
              changed = true;
              break;
            }
          }
          if (!changed) continue;
          last.set(e);
          if (batched) {
            batched.setMatrixAt(entry.instanceId, entry.mesh.matrixWorld);
            handle?.move(entry.instanceId);
          } else if (instanced) {
            instanced.forgeCulling.setMatrixAt(entry.instanceId, entry.mesh.matrixWorld);
          }
        }
      };
      this.syncRestores.push(prependRenderHook(target, sync));
    }
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
    for (const restore of this.syncRestores.reverse()) restore();
    this.syncRestores = [];
    this.syncedSet = new Set();
    for (const batch of this.batches) {
      this.cullingHandles.get(batch)?.detach();
      batch.removeFromParent();
      (batch.material as Material).dispose();
      batch.dispose();
    }
    for (const mesh of this.instanced) {
      (mesh as CulledInstancedMesh).forgeCulling?.detach();
      mesh.removeFromParent();
      (mesh.material as Material).dispose();
      mesh.dispose();
    }
    for (const swap of this.materialSwaps) swap.mesh.material = swap.material;
    const restore = [...this.hidden].sort((a, b) => a.index - b.index);
    for (const state of restore) {
      state.mesh.layers.mask = state.layersMask;
      state.mesh.matrixAutoUpdate = state.matrixAutoUpdate;
      if (this.originalsMode === 'detach' && !state.synced) {
        state.parent.add(state.mesh);
        const children = state.parent.children;
        children.splice(children.indexOf(state.mesh), 1);
        children.splice(Math.min(state.index, children.length), 0, state.mesh);
      }
    }
    this.batches = [];
    this.instanced = [];
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
    const object = intersection.object as BatchedMesh | CulledInstancedMesh;
    if ((object as BatchedMesh).isBatchedMesh && intersection.batchId !== undefined) {
      const original = this.originalsByBatch.get(object)?.[intersection.batchId];
      if (original) return original;
    }
    if ((object as InstancedMesh).isInstancedMesh && intersection.instanceId !== undefined) {
      const compacted = intersection.instanceId;
      const master = (object as CulledInstancedMesh).visibleIds?.[compacted] ?? compacted;
      const original = this.originalsByBatch.get(object)?.[master];
      if (original) return original;
    }
    return intersection.object;
  }

  private hideOriginal(state: OriginalState): void {
    const { mesh, synced } = state;
    if (this.originalsMode === 'detach' && !synced) {
      mesh.removeFromParent();
    } else {
      mesh.layers.set(FORGE_HIDDEN_LAYER);
      if (!synced) mesh.matrixAutoUpdate = false;
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
