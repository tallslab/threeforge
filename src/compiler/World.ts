import {
  type BatchedMesh,
  type Camera,
  type CoordinateSystem,
  DoubleSide,
  Group,
  type InstancedMesh,
  type Intersection,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  type Scene,
  type Sprite,
  WebGLCoordinateSystem,
} from 'three';
import type { DrawCallLedger } from '../ledger/DrawCallLedger.js';
import { displayName } from '../ledger/reasons.js';
import { MaterialRegistry } from '../registry/MaterialRegistry.js';
import type { BakeOptions } from './bake.js';
import { type BakedGroup, batchStatics, rebake, type Slot } from './batchStatics.js';
import { type AnimationSource, animatedRoots, type Classification, classify, exclusionRule } from './classify.js';
import { attachBvhCulling, type CullingHandle, type NestedPassPolicy } from './culling.js';
import { freezableObjects } from './freeze.js';
import type { CulledInstancedMesh, InstanceCullingHandle } from './instancing.js';
import { PassTracker } from './passTracker.js';
import { SceneSpace } from './space.js';
import { buildSpriteBatch, type SpriteBatch } from './spriteBatch.js';
import { groupSprites } from './sprites.js';
import { installSync } from './world/batchSync.js';
import { CompileMaterials } from './world/materials.js';
import { OcclusionProxies } from './world/occlusion.js';
import { FORGE_HIDDEN_LAYER, Originals } from './world/originals.js';
import { bakeSummary } from './world/report.js';
import type {
  BakeSummary,
  CompileOptions,
  CompileReport,
  DirtyEvent,
  WarmupOptions,
  WarmupRenderer,
  WarmupResult,
  WorldOptions,
} from './world/types.js';
import { warmup } from './world/warmup.js';

export type {
  BakeSummary,
  CompileOptions,
  CompileReport,
  DirtyEvent,
  WarmupOptions,
  WarmupRenderer,
  WarmupResult,
  WorldOptions,
};
export { FORGE_HIDDEN_LAYER };

const _local = new Matrix4();

/**
 * Rewrites a scene in place: statics become BatchedMesh instances, every remaining material is canonicalised,
 * and everything is reversible with `decompile()`. Three.js keeps rendering the same `scene` object.
 */
export class World {
  readonly scene: Scene;
  readonly registry: MaterialRegistry;
  readonly ledger: DrawCallLedger | undefined;
  private readonly policy: 'tagged' | 'auto';
  private readonly cullingMode: 'bvh' | 'linear';
  private readonly instanceThreshold: number;
  private readonly dynamicsMode: 'separate' | 'batch-sync';
  private readonly chunkSizeOption: number | undefined;
  private readonly lod: { distances: number[] } | null;
  private readonly occlusion: boolean;
  private readonly animations: AnimationSource[];
  private readonly nestedPassesOption: NestedPassPolicy | 'auto';
  /** Follows render nesting through the scene hooks: the main camera, and which passes are open (culling). */
  private readonly passes = new PassTracker();
  /** The scene's space: batches, instanced meshes, baked meshes and sprite batches are its children, so instance data is written in it. */
  private readonly space: SceneSpace;
  private sceneHookRestores: (() => void)[] = [];
  private readonly occluders = new OcclusionProxies();
  private cullingHandles = new Map<BatchedMesh, CullingHandle>();
  private syncRestores: (() => void)[] = [];
  private syncedSet = new Set<Mesh>();
  private batches: BatchedMesh[] = [];
  private instanced: InstancedMesh[] = [];
  private baked: BakedGroup[] = [];
  private bakedByMesh = new Map<Object3D, BakedGroup>();
  private readonly bakeOptions: BakeOptions | null;
  private readonly spriteMode: 'batch' | 'keep';
  private readonly spriteThreshold: number;
  private readonly transparentMode: 'batch' | 'keep';
  private readonly freezeStatics: boolean;
  private frozenList: Array<{ object: Object3D; matrixAutoUpdate: boolean }> = [];
  private dirtyListeners = new Set<(event: DirtyEvent) => void>();
  private spriteBatchList: SpriteBatch[] = [];
  private slots = new Map<Mesh, Slot>();
  private originalsByBatch = new Map<BatchedMesh | InstancedMesh, Mesh[]>();
  private readonly originals: Originals;
  private readonly materials: CompileMaterials;
  private compiled = false;
  /** `BatchResult.unbakeable` of the current compile. */
  private unbakeableEntries = 0;
  private disposed = false;
  private disposing = false;

  constructor(scene: Scene, options: WorldOptions = {}) {
    this.scene = scene;
    this.space = new SceneSpace(scene);
    this.registry = options.registry ?? options.ledger?.registry ?? new MaterialRegistry();
    this.ledger = options.ledger;
    this.policy = options.policy ?? 'tagged';
    this.originals = new Originals(options.originals ?? 'hide');
    this.cullingMode = options.culling ?? 'bvh';
    this.instanceThreshold = options.instanceThreshold ?? 64;
    this.dynamicsMode = options.dynamics ?? 'separate';
    this.chunkSizeOption = options.chunkSize;
    this.lod = options.lod ?? null;
    this.occlusion = options.occlusion ?? false;
    this.animations = options.animations ?? [];
    this.nestedPassesOption = options.nestedPasses ?? 'auto';
    this.materials = new CompileMaterials(this.registry, options.materials ?? 'canonical');
    this.bakeOptions = options.bake === true ? {} : options.bake ? options.bake : null;
    this.spriteMode = options.sprites ?? 'batch';
    this.spriteThreshold = options.spriteThreshold ?? 4;
    this.transparentMode = options.transparent ?? 'batch';
    this.freezeStatics = options.freeze ?? true;
  }

  /** The camera of the outermost render in the current or last frame (tracked through the scene hooks once compiled). */
  get mainCamera(): Camera | null {
    return this.passes.mainCamera;
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

  /** The `chunkSize` option: world-space cell size, or undefined when statics are not split by cell. */
  get chunkSize(): number | undefined {
    return this.chunkSizeOption;
  }

  /** Compiled batches, instanced groups and baked meshes by cell (`x,y,z`); empty without `chunkSize` or before compile. */
  chunks(): Map<string, Object3D[]> {
    const out = new Map<string, Object3D[]>();
    for (const object of [...this.batches, ...this.instanced, ...this.baked.map((b) => b.mesh)]) {
      const cell = object.userData.forgeChunk as [number, number, number] | null | undefined;
      if (!cell) continue;
      const key = cell.join(',');
      const list = out.get(key) ?? [];
      list.push(object);
      out.set(key, list);
    }
    return out;
  }

  /** Objects `compile()` froze beyond the hidden originals (unbatched statics and all-static ancestors). */
  get frozenObjects(): readonly Object3D[] {
    return this.frozenList.map((f) => f.object);
  }

  /** One mesh per batched sprite group (`forge:sprites:<programHash>:<n>`). */
  get spriteBatches(): readonly Mesh[] {
    return this.spriteBatchList.map((b) => b.mesh);
  }

  /** One mesh per baked group (empty unless `bake` is on). */
  get bakedMeshes(): readonly Mesh[] {
    return this.baked.map((b) => b.mesh);
  }

  /**
   * The faces every bake removed, one unlit red double-sided mesh per group, for inspection. Not added to the scene. A
   * snapshot: each mesh holds a copy of the removed faces as of this call, which a later rebake or `decompile()` does not
   * touch. The returned group is the caller's: dispose its geometries and materials when done.
   */
  bakeDebug(): Group {
    const group = new Group();
    group.name = 'forge:bake-debug';
    this.baked.forEach((b, i) => {
      const mesh = new Mesh(
        b.removed.clone(),
        new MeshBasicMaterial({
          color: 0xff2040,
          side: DoubleSide,
          depthTest: false,
          transparent: true,
          opacity: 0.85,
        }),
      );
      mesh.name = `forge:bake-removed:${i}`;
      mesh.renderOrder = 1000;
      group.add(mesh);
    });
    return group;
  }

  compile(options: CompileOptions = {}): CompileReport {
    this.assertLive();
    if (this.compiled) throw new Error('World is already compiled; call decompile() first.');
    const coordinateSystem = options.coordinateSystem ?? WebGLCoordinateSystem;
    const nestedPasses: NestedPassPolicy = this.nestedPassesOption === 'auto' ? 'per-pass' : this.nestedPassesOption;
    // The scene hooks bracket every render() call, nested ones included: the tracker gives the batch and instanced
    // culling the depth of the current pass, which passes are still open and the main camera, which sprite batches
    // also sync for (see below).
    this.sceneHookRestores.push(this.passes.install(this.scene));
    try {
      return this.compileWithHooks(coordinateSystem, nestedPasses);
    } catch (error) {
      // A compile that throws leaves `compiled` false, so neither `decompile()` nor `dispose()` would ever run the
      // uninstallers, and a retried compile would install the tracker a second time (every outermost render then runs at
      // depth 2). Undo them on this exit path too.
      for (const restore of this.sceneHookRestores.reverse()) restore();
      this.sceneHookRestores = [];
      this.passes.reset();
      throw error;
    }
  }

  /** The body of `compile()` once the pass tracker's scene hooks are installed. */
  private compileWithHooks(coordinateSystem: CoordinateSystem, nestedPasses: NestedPassPolicy): CompileReport {
    // Resolved once for the whole compile: `classify` makes animated subtrees dynamic, and the freeze pass below
    // keeps them and their ancestors auto-updating. Each track costs a `PropertyBinding.findNode` walk of the graph.
    const animated = animatedRoots(this.scene, this.animations);
    const classifications = classify(this.scene, { policy: this.policy, animated });
    const before = {
      meshes: classifications.length,
      materials: new Set(
        classifications.flatMap((c) => (Array.isArray(c.object.material) ? c.object.material : [c.object.material])),
      ).size,
    };

    const statics = classifications.filter((c) => c.kind === 'static').map((c) => c.object);
    // Dynamics that obey every batch rule can ride along and have their matrices synced each frame.
    const syncRule = new Map<Mesh, string | null>();
    if (this.dynamicsMode === 'batch-sync') {
      for (const c of classifications) {
        if (c.kind !== 'dynamic') continue;
        const rule = Array.isArray(c.object.material) ? 'multi-material' : exclusionRule(c.object, this.scene);
        syncRule.set(c.object, rule);
        if (rule === null) statics.push(c.object);
      }
    }
    const noBake = new Set<Mesh>([...syncRule.entries()].filter(([, rule]) => rule === null).map(([mesh]) => mesh));
    const result = batchStatics(statics, this.registry, this.scene, {
      instanceThreshold: this.instanceThreshold,
      coordinateSystem,
      chunkSize: this.chunkSizeOption,
      passes: this.passes,
      space: this.space,
      transparent: this.transparentMode,
      ...(this.lod ? { lodDistances: this.lod.distances } : {}),
      ...(this.bakeOptions ? { bake: this.bakeOptions, noBake } : {}),
    });
    const transparentKeptSet = new Set<Mesh>(result.transparentKept);
    this.batches = result.batches;
    this.instanced = result.instanced;
    this.baked = result.baked;
    for (const group of result.baked) this.bakedByMesh.set(group.mesh, group);
    this.unbakeableEntries = result.unbakeable;
    this.slots = result.slots;
    this.originalsByBatch = result.originals;
    this.materials.claimClones([...result.batches, ...result.instanced], result.originals);
    // Every batch is culled through a marginless tree, movers included: the BVH prefilters candidates by their exact
    // box, which is strictly tighter than three's bounding-sphere test applied after it, so enlarging the boxes does
    // not merely cost a refit — it admits instances whose sphere meets the frustum while their exact box does not.
    // See `CullingOptions.margin`. A synced mover refits its own leaf instead, which is correct and cheaper.
    if (this.cullingMode === 'bvh') {
      for (const batch of this.batches) {
        const geometryIds = result.lodGeometryIds.get(batch);
        const lod = this.lod && geometryIds ? { distances: this.lod.distances, geometryIds } : undefined;
        this.cullingHandles.set(
          batch,
          attachBvhCulling(batch, coordinateSystem, { nestedPasses, passes: this.passes, ...(lod ? { lod } : {}) }),
        );
      }
    }
    for (const [mesh, rule] of syncRule) if (rule === null && result.slots.has(mesh)) this.syncedSet.add(mesh);
    this.syncRestores = installSync(this.syncedSet, result.slots, this.cullingHandles, this.space);
    if (this.occlusion)
      this.occluders.install({
        scene: this.scene,
        passes: this.passes,
        space: this.space,
        batches: this.batches,
        instanced: this.instanced,
        synced: this.syncedSet,
        slots: this.slots,
      });

    // Record parent indices before touching the graph so detach/restore round-trips exactly.
    for (const mesh of result.slots.keys()) this.originals.record(mesh, this.syncedSet.has(mesh));
    // Sprites: one instanced billboard draw per material, driven by the hidden originals every frame.
    const spriteSkips: CompileReport['skipped'] = [];
    if (this.spriteMode === 'batch') {
      const sprites: Sprite[] = [];
      this.scene.traverse((o) => {
        if ((o as Sprite).isSprite) sprites.push(o as Sprite);
      });
      const grouped = groupSprites(sprites, this.spriteThreshold, (m) => this.registry.describe(m), this.scene);
      // One sync per frame, for the main camera: three uploads the node-bound instance attributes once per frame,
      // so a second fill for a nested pass (a reflection) would be what the main pass draws. Nested passes draw the
      // main camera's list instead, on both backends.
      const sync = (camera: Camera): boolean => this.passes.mainCamera === null || camera === this.passes.mainCamera;
      grouped.groups.forEach((group, i) => {
        const batch = buildSpriteBatch(group, i, { sync, root: this.scene, space: this.space });
        this.scene.add(batch.mesh);
        this.spriteBatchList.push(batch);
        for (const sprite of group.sprites) this.originals.record(sprite, true);
      });
      for (const { sprite, rule } of grouped.skipped) spriteSkips.push({ name: displayName(sprite, this.scene), rule });
    }
    this.originals.hideAll();

    // Freeze what never moves: unbatched statics and all-static ancestors stop recomposing matrices every frame.
    if (this.freezeStatics) {
      const hidden = this.originals.hidden;
      const hiddenSet = new Set<Object3D>(hidden.map((h) => h.mesh));
      const syncedSet = new Set<Object3D>(hidden.filter((h) => h.synced).map((h) => h.mesh));
      for (const object of freezableObjects(this.scene, { hidden: hiddenSet, synced: syncedSet, animated })) {
        object.updateMatrix();
        this.frozenList.push({ object, matrixAutoUpdate: object.matrixAutoUpdate });
        object.matrixAutoUpdate = false;
      }
    }

    const skipped: CompileReport['skipped'] = [...spriteSkips];
    for (const c of classifications) {
      if (result.slots.has(c.object)) continue;
      const transparentKept = c.kind === 'static' && transparentKeptSet.has(c.object);
      let rule = c.kind === 'static' ? (transparentKept ? 'transparent-kept' : 'singleton') : c.rule;
      if (c.kind === 'dynamic') rule = syncRule.get(c.object) ?? rule;
      skipped.push({ name: displayName(c.object, this.scene), rule });
      if (c.kind === 'excluded') this.ledger?.annotate(c.object, `excluded:${c.rule}`);
      // A static with nothing to share a draw with: the ledger should say why, even under policy 'auto'. A
      // transparent static left unbatched by `transparent: 'keep'` gets its own reason, not `unique-material`. Whether its
      // canonical material is shared is a per-frame fact: the ledger relabels it `static-unbatched` in a frame where
      // another object of the main pass draws that material.
      if (c.kind === 'static')
        this.ledger?.annotate(c.object, transparentKept ? 'excluded:transparent-kept' : 'unique-material');
      // Dynamic by rule (under a bone, animated) rather than by tag: still a dynamic draw, not an untagged one.
      if (c.kind === 'dynamic') this.ledger?.annotate(c.object, 'dynamic');
      this.materials.canonicalise(c.object);
    }

    this.compiled = true;
    this.emitDirty({ kind: 'compile' });
    return {
      before,
      after: {
        batches: this.batches.length,
        instanced: this.instanced.length,
        baked: this.baked.length,
        spriteBatches: this.spriteBatchList.length,
        frozen: this.frozenList.length,
        meshes: classifications.length - result.slots.size,
      },
      bake: this.bakeOptions ? bakeSummary(this.baked, this.unbakeableEntries) : null,
      groups: result.groups,
      skipped,
      registry: this.registry.stats(),
      culling: { mode: this.cullingMode, coordinateSystem },
      synced: this.syncedSet.size,
      lod: this.lod,
      occlusion: this.occlusion ? { proxies: this.occluders.count, skippedSynced: this.occluders.skippedSynced } : null,
      nestedPasses,
    };
  }

  /** Listen for graph changes that need a new frame (`markDirty`, `setVisible`, `compile`, `decompile`); returns the disposer. */
  onDirty(listener: (event: DirtyEvent) => void): () => void {
    this.assertLive();
    this.dirtyListeners.add(listener);
    return () => {
      this.dirtyListeners.delete(listener);
    };
  }

  private emitDirty(event: DirtyEvent): void {
    for (const listener of this.dirtyListeners) listener(event);
  }

  /**
   * Move a frozen static (or a whole subtree) on demand: recomposes the matrices under `object` and pushes every
   * batched original in the subtree into its batch in the scene's space (BatchedMesh matrix and BVH leaf, InstancedMesh
   * through its culling handle, baked groups by one rebake), then recomputes each touched batch's bounds and refits its
   * occlusion proxy. Returns the number of instances updated. With `originals: 'detach'` a detached original's world
   * matrix is composed from its former parent's current one (refreshed by `markDirty` on that parent or an ancestor)
   * and its own recomposed local matrix, so `markDirty` on a former parent reaches its detached descendants.
   */
  markDirty(object: Object3D): number {
    this.assertLive();
    let updated = 0;
    const rebakes = new Set<BakedGroup>();
    const batches = new Set<BatchedMesh>();
    const handles = new Set<InstanceCullingHandle>();

    const visitSlot = (o: Object3D): void => {
      const slot = this.slots.get(o as Mesh);
      if (!slot) return;
      const bakedGroup = this.bakedByMesh.get(slot.batch);
      if (bakedGroup) {
        rebakes.add(bakedGroup);
        updated++;
        return;
      }
      const target = slot.batch as BatchedMesh | CulledInstancedMesh;
      const matrix = this.space.toLocal(o.matrixWorld, _local);
      if ((target as BatchedMesh).isBatchedMesh) {
        (target as BatchedMesh).setMatrixAt(slot.instanceId, matrix);
        this.cullingHandles.get(target as BatchedMesh)?.move(slot.instanceId);
        batches.add(target as BatchedMesh);
      } else {
        (target as CulledInstancedMesh).forgeCulling.setMatrixAt(slot.instanceId, matrix);
        handles.add((target as CulledInstancedMesh).forgeCulling);
      }
      updated++;
    };

    this.originals.updateSubtree(object, visitSlot);

    for (const group of rebakes) rebake(group);
    for (const batch of batches) {
      batch.computeBoundingBox();
      batch.computeBoundingSphere();
    }
    for (const handle of handles) handle.refreshBounds();
    this.occluders.refit(batches, handles);
    this.emitDirty({ kind: 'markDirty', object });
    return updated;
  }

  /** Show or hide an original mesh, wherever it ended up. A baked module rebakes its group. */
  setVisible(original: Mesh, visible: boolean): void {
    this.assertLive();
    this.emitDirty({ kind: 'setVisible', object: original });
    const slot = this.slots.get(original);
    if (!slot) {
      original.visible = visible;
      return;
    }
    const bakedGroup = this.bakedByMesh.get(slot.batch);
    if (bakedGroup) {
      if (visible === !bakedGroup.hidden.has(original)) return;
      if (visible) bakedGroup.hidden.delete(original);
      else bakedGroup.hidden.add(original);
      rebake(bakedGroup);
      return;
    }
    const target = slot.batch as BatchedMesh | CulledInstancedMesh;
    if ((target as BatchedMesh).isBatchedMesh) (target as BatchedMesh).setVisibleAt(slot.instanceId, visible);
    else (target as CulledInstancedMesh).forgeCulling.setVisibleAt(slot.instanceId, visible);
  }

  /**
   * Build shaders and upload textures now instead of on the first visible frame. Call after `compile()`.
   * The default renders one real frame under a 1x1 scissor, which is the only way in three r186 to get exactly
   * the pipelines the first frame will use: `compileAsync()` mis-compiles transparent double-sided and
   * transmissive materials (see `WarmupResult.repaired`), so `mode: 'async'` runs it and then repairs those.
   */
  async warmup(renderer: WarmupRenderer, camera: Camera, options: WarmupOptions = {}): Promise<WarmupResult> {
    this.assertLive();
    return warmup({ scene: this.scene, passes: this.passes, occlusion: this.occluders }, renderer, camera, options);
  }

  decompile(): void {
    if (!this.compiled) return;
    for (const restore of this.sceneHookRestores.reverse()) restore();
    this.sceneHookRestores = [];
    this.passes.reset();
    // Materials merged into another of this compile's own materials are forgotten first, so `release()` below sees,
    // per canonical, only the dependents this decompile is not also dropping.
    this.materials.forgetMerged(
      this.materials.created({
        proxies: this.occluders.materials(),
        targets: [...this.batches, ...this.instanced],
        baked: this.baked,
        spriteBatches: this.spriteBatchList.map((batch) => batch.material as Material),
      }),
    );
    this.occluders.teardown((material) => this.materials.release(material));
    for (const restore of this.syncRestores.reverse()) restore();
    this.syncRestores = [];
    this.syncedSet = new Set();
    for (const batch of this.batches) {
      this.cullingHandles.get(batch)?.detach();
      batch.removeFromParent();
      this.materials.releaseOwned(batch.material as Material);
      batch.dispose();
    }
    for (const mesh of this.instanced) {
      (mesh as CulledInstancedMesh).forgeCulling?.detach();
      mesh.removeFromParent();
      this.materials.releaseOwned(mesh.material as Material);
      mesh.dispose();
    }
    this.materials.dropOwned();
    for (const b of this.baked) {
      b.mesh.removeFromParent();
      b.mesh.geometry.dispose();
      b.removed.dispose();
      if (b.ownsMaterial) this.materials.release(b.mesh.material as Material);
    }
    this.baked = [];
    this.bakedByMesh = new Map();
    this.unbakeableEntries = 0;
    for (const batch of this.spriteBatchList) {
      batch.mesh.removeFromParent();
      // `SpriteBatch.dispose()` would dispose this material unconditionally; `release` decides instead, by the same
      // rule as every other material this compile created. So a material another registered material still merges
      // into is left registered *and* alive: that material resolves to this exact object, and a disposed canonical
      // would break every mesh drawn with it.
      batch.dispose({ material: false });
      this.materials.release(batch.material as Material);
    }
    this.spriteBatchList = [];
    for (const f of this.frozenList.reverse()) f.object.matrixAutoUpdate = f.matrixAutoUpdate;
    this.frozenList = [];
    this.materials.restoreSwaps();
    this.originals.restore();
    this.batches = [];
    this.instanced = [];
    this.slots = new Map();
    this.originalsByBatch = new Map();
    this.cullingHandles = new Map();
    this.compiled = false;
    this.emitDirty({ kind: 'decompile' });
  }

  /**
   * Tears the World down for good: decompiles first when compiled (listeners still hear `decompile`), then drops every
   * `onDirty` listener. The registry and the ledger stay the app's. `dispose()` and `decompile()` then do nothing, the
   * other methods throw, already while `dispose()` runs, and the World ends disposed even when a listener throws.
   */
  dispose(): void {
    if (this.disposed || this.disposing) return;
    this.disposing = true;
    try {
      this.decompile();
    } finally {
      this.dirtyListeners.clear();
      this.disposed = true;
      this.disposing = false;
    }
  }

  private assertLive(): void {
    if (this.disposed || this.disposing)
      throw new Error('World is disposed; create a new World to compile the scene again.');
  }

  slotOf(mesh: Mesh): Slot | undefined {
    return this.slots.get(mesh);
  }

  /** The original mesh behind a raycast hit on a batch, an instanced mesh or a baked mesh; the hit object itself otherwise. */
  resolve(intersection: Intersection): Object3D {
    const bakedGroup = this.bakedByMesh.get(intersection.object);
    if (bakedGroup && intersection.faceIndex !== undefined && intersection.faceIndex !== null) {
      const original = bakedGroup.entries[bakedGroup.triangleOrigins[intersection.faceIndex]!];
      if (original) return original;
    }
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
}

export type { Classification };
