import { BoxGeometry, DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial, Vector3, Vector4, WebGLCoordinateSystem, type BatchedMesh, type Box3, type Camera, type CoordinateSystem, type InstancedMesh, type Intersection, type Material, type Object3D, type Scene, type Sprite, type Texture } from 'three';
import type { DrawCallLedger } from '../ledger/DrawCallLedger.js';
import { displayName } from '../ledger/reasons.js';
import { MaterialRegistry, type RegistryStats } from '../registry/MaterialRegistry.js';
import { batchStatics, type GroupReport, type Slot, rebake, type BakedGroup } from './batchStatics.js';
import type { BakeOptions } from './bake.js';
import type { CulledInstancedMesh, InstanceCullingHandle } from './instancing.js';
import { animatedRoots, classify, exclusionRule, type AnimationSource, type Classification } from './classify.js';
import { freezableObjects } from './freeze.js';
import { buildSpriteBatch, type SpriteBatch } from './spriteBatch.js';
import { groupSprites } from './sprites.js';
import { attachBvhCulling, prependAfterRenderHook, prependRenderHook, type CullingHandle, type NestedPassPolicy } from './culling.js';
import { PassTracker } from './passTracker.js';
import { SceneSpace } from './space.js';
import { cameraNearProxy } from './occlusionProxy.js';

/** Hidden originals live on this layer: invisible to default cameras and default raycasters, matrices still valid. */
export const FORGE_HIDDEN_LAYER = 31;

const _local = new Matrix4();
const _size = new Vector3();
const _center = new Vector3();

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
   * their matrices are copied in (in the scene's space) whenever their world matrices change, before each cull. Colour
   * changes are not synced.
   */
  dynamics?: 'separate' | 'batch-sync';
  /** World-space cell size. Splits each material group into one batch per cell: tight bounds for whole-chunk culling and a unit for streaming. */
  chunkSize?: number;
  /**
   * Level-of-detail by camera distance. Geometries need levels attached first (`await prepareLods(scene)`).
   * Level i is used from `distances[i-1]` onward; batches need `culling: 'bvh'` (the default) for this.
   */
  lod?: { distances: number[] };
  /**
   * Occlusion culling per batch / instanced group through three's occlusion queries: an invisible proxy box per
   * target carries `occlusionTest`; a target whose proxy was reported fully occluded (two or more renders late) is
   * skipped. Only the outermost render of the scene decides, and a proxy the camera is inside of, or whose box the near
   * plane reaches into, issues no query and shows its target; so does `warmup()`'s scissored frame. A batch or instanced
   * group holding batch-synced movers gets no proxy (`report.occlusion.skippedSynced`). One outermost camera per frame
   * is assumed. Costs one cheap submission per target. Needs a renderer with `isOccluded()` (WebGPURenderer, either
   * backend).
   *
   * A skipped target is skipped in *every* pass of that frame, so it also disappears from shadow maps and reflections:
   * a batch hidden behind a wall stops casting its shadow and stops appearing in a mirror, which is visible whenever
   * the light or the mirror sees what the camera cannot. Leave `occlusion` off where those matter
   * (`docs/threeforge.md`, "Occlusion").
   */
  occlusion?: boolean;
  /** Clips that will drive this scene (e.g. `gltf.animations`), or `{ root, clips }` per animated character. */
  animations?: AnimationSource[];
  /**
   * Culling of batches in render passes nested in another render of the scene (shadow maps, reflections, portals).
   * A batch an enclosing pass has already culled keeps that pass's index rows as a stable prefix under either policy:
   * the nested pass zeroes the rows its camera does not need and appends the ones it lacks (see `attachBvhCulling`).
   * The policy decides a batch no enclosing pass has culled yet: `per-pass` culls it for the nested camera,
   * `reuse-main` keeps the rows of its last outermost-render cull and appends. Compacted instanced meshes keep a
   * stable prefix too, the same under both policies: shadow passes append every shadow light's casters, other nested
   * passes draw the main camera's list (see `createCulledInstancedMesh`). `auto` (default) is `per-pass` on both
   * backends.
   */
  nestedPasses?: NestedPassPolicy | 'auto';
  /** `canonical` (default): meshes left unbatched get the registry's canonical material; `keep`: materials are left alone. */
  materials?: 'canonical' | 'keep';
  /**
   * Bake finished static groups into one world-space mesh each instead of a BatchedMesh: contact seams between
   * touching modules and duplicated faces are removed, vertices welded where position, normal, uv and colour
   * agree; `removeBuried` is opt-in. Every removal is counted in the report and returned by `bakeDebug()`.
   * Modules with `userData.forgeBake = false` pass through untouched. Hiding a baked module rebakes its group.
   */
  bake?: boolean | BakeOptions;
  /**
   * `batch` (default): sprites sharing a material (by registry keys) become one instanced billboard draw whose
   * instances follow the originals every frame; `keep` leaves every Sprite its own draw.
   */
  sprites?: 'batch' | 'keep';
  /**
   * `batch` (default): transparent statics batch/bake like any other group. Three sorts a `BatchedMesh`
   * back-to-front by its own bounding-sphere centre, not per instance, so a transparent batch composites in
   * creation order relative to other transparent submissions instead of true per-object depth (the
   * `transparent-batch-order` hint names this). `keep` leaves transparent statics as individual meshes, annotated
   * `transparent-kept`, so their draw order against other transparent objects is exact.
   */
  transparent?: 'batch' | 'keep';
  /** Sprites a material needs before its group is batched (default 4). */
  spriteThreshold?: number;
  /**
   * `true` (default): after batching, unbatched static-tagged meshes and every ancestor whose whole subtree is
   * static get `matrixAutoUpdate = false`, so three stops recomposing their matrices every frame. Move a frozen
   * object with `world.markDirty(object)`. `decompile()` restores the flags.
   */
  freeze?: boolean;
}

export interface CompileOptions {
  /** `renderer.coordinateSystem`; needed for BVH frustum planes. Defaults to WebGL. */
  coordinateSystem?: CoordinateSystem;
}

export interface BakeSummary {
  groups: number;
  inputTriangles: number;
  triangles: number;
  contactFaces: number;
  /** Faces of coincident, opposite-winding pairs the seam rule kept (not provably a seam between two touching solids) and no later rule removed. */
  keptCoincidentFaces: number;
  duplicateFaces: number;
  buriedFaces: number;
  weldedVertices: number;
  excludedEntries: number;
  /**
   * Faces of exactly coincident copies the duplicate rule kept, for any of its reasons: an excluded or non-removable copy
   * among them, a copy that draws differently, or another triangle drawn over them (`BakeReport.keptDuplicateFaces`).
   */
  keptDuplicateFaces: number;
  /**
   * Static meshes batched instead of baked because the bake cannot prove the merged mesh draws what they drew: their
   * material has a node in any slot, an instance function, a subclass or a `displacementMap`, any of which may read
   * the geometry in the module's own space the bake leaves, or their geometry carries an attribute the bake does not
   * carry faithfully (`unbakeableAttribute`: a four-component colour the material reads, or an attribute outside
   * position, normal, tangent, uv to uv3 and colour).
   */
  unbakeableEntries: number;
}

/** What `world.onDirty` reports: the graph changed in a way that needs a new frame. */
export interface DirtyEvent {
  kind: 'markDirty' | 'setVisible' | 'compile' | 'decompile';
  object?: Object3D;
}

export interface CompileReport {
  before: { meshes: number; materials: number };
  after: { batches: number; instanced: number; baked: number; spriteBatches: number; frozen: number; meshes: number };
  /** Totals over the baked groups, null when `bake` is off. */
  bake: BakeSummary | null;
  groups: GroupReport[];
  skipped: { name: string; rule: string }[];
  registry: RegistryStats;
  culling: { mode: 'bvh' | 'linear'; coordinateSystem: CoordinateSystem };
  /** Dynamics folded into batches with matrix sync (0 unless `dynamics: 'batch-sync'`). */
  synced: number;
  lod: { distances: number[] } | null;
  /** Occlusion proxies installed, and batches / instanced groups given none because they hold batch-synced movers; null without `occlusion`. */
  occlusion: { proxies: number; skippedSynced: number } | null;
  nestedPasses: NestedPassPolicy;
}

export interface WarmupRenderer {
  render(scene: Object3D, camera: Camera): unknown;
  /** Awaited before warm-up changes any state (three's `Renderer.init`; it returns the same promise once started). */
  init?(): Promise<unknown>;
  compileAsync?(scene: Object3D, camera: Camera): Promise<unknown>;
  initTexture?(texture: Texture): void;
  getScissor(target: Vector4): Vector4;
  setScissor(x: number, y: number, width: number, height: number): void;
  getScissorTest(): boolean;
  setScissorTest(value: boolean): void;
  coordinateSystem?: CoordinateSystem;
}

export interface WarmupOptions {
  /**
   * `frame` (default) renders one real frame inside a 1x1 scissor: every pipeline the first visible frame needs
   * is built exactly as that frame would build it. `async` pre-compiles with `renderer.compileAsync()` (yields
   * between objects, so a loading screen keeps animating) and then rebuilds the materials three r186 compiles
   * wrong that way, see `WarmupResult.repaired`.
   */
  mode?: 'frame' | 'async';
}

export interface WarmupResult {
  /** Which strategy ran; `async` falls back to `frame` when the renderer has no `compileAsync`. */
  mode: 'frame' | 'async';
  /** Textures handed to `initTexture`. */
  textures: number;
  /**
   * Materials whose render objects were discarded after `compileAsync` and rebuilt by the warm-up frame. In
   * three r186 `compileAsync` queues `renderObject()` work and runs it after the renderer has restored
   * `material.side`, so transparent double-sided materials and transmissive ones (which render in two passes)
   * are compiled as single-pass DoubleSide, and transmission samples a viewport texture that is never written;
   * `material.needsUpdate` cannot fix those cached render objects, only `material.dispose()` can.
   */
  repaired: number;
}

/**
 * Materials three r186 renders in two passes (`renderObject()` flips `side` for transparent DoubleSide,
 * `_renderTransparents()` for transmissive DoubleSide) or through a viewport texture (transmission, backdrop):
 * `compileAsync()` builds their render objects after that state is gone.
 */
function compiledWrongByCompileAsync(material: Material): boolean {
  const m = material as Material & { transmission?: number; transmissionNode?: unknown; backdropNode?: unknown };
  const transmissive = (m.transmission ?? 0) > 0 || !!m.transmissionNode || !!m.backdropNode;
  const doublePass = m.transparent && m.side === DoubleSide && m.forceSinglePass === false;
  return transmissive || doublePass;
}

interface OriginalState {
  mesh: Object3D;
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

interface OcclusionEntry {
  proxy: Mesh;
  targets: Object3D[];
  /** Its query was turned off in a render at tracker depth 0; a microtask turns it back on. */
  parked: boolean;
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
  private readonly chunkSizeOption: number | undefined;
  private readonly lod: { distances: number[] } | null;
  private readonly occlusion: boolean;
  private readonly animations: AnimationSource[];
  private readonly nestedPassesOption: NestedPassPolicy | 'auto';
  private readonly materialsMode: 'canonical' | 'keep';
  /** Follows render nesting through the scene hooks: the main camera, and which passes are open (culling). */
  private readonly passes = new PassTracker();
  /** The scene's space: batches, instanced meshes, baked meshes and sprite batches are its children, so instance data is written in it. */
  private readonly space: SceneSpace;
  private sceneHookRestores: (() => void)[] = [];
  private occluders: OcclusionEntry[] = [];
  /** Batches and instanced groups `installOcclusion` gave no proxy because they hold batch-synced movers. */
  private occlusionSkippedSynced = 0;
  private occlusionResumeQueued = false;
  /** Turns the query of proxies parked at tracker depth 0 back on. Queued as a microtask, so it never runs inside a render. */
  private readonly resumeParkedProxies = (): void => {
    this.occlusionResumeQueued = false;
    for (const entry of this.occluders) {
      if (!entry.parked) continue;
      entry.parked = false;
      entry.proxy.occlusionTest = true;
    }
  };
  private occlusionRestores: (() => void)[] = [];
  private cullingHandles = new Map<BatchedMesh, CullingHandle>();
  private syncRestores: (() => void)[] = [];
  private syncedSet = new Set<Mesh>();
  private batches: BatchedMesh[] = [];
  private instanced: InstancedMesh[] = [];
  private baked: BakedGroup[] = [];
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
  private hidden: OriginalState[] = [];
  /**
   * `originals: 'detach'` only: each detached original's former parent (still in the graph; only slotted originals
   * are ever detached). `markDirty` reads this instead of the parentless `matrixWorld` `updateMatrixWorld` would give.
   */
  private detachedParents = new Map<Object3D, Object3D>();
  /**
   * The reverse index: former parent -> its detached originals, so `markDirty` on that parent (or an ancestor
   * reached through the still-attached graph) can reach them even though they are no longer its children.
   */
  private detachedByParent = new Map<Object3D, Set<Object3D>>();
  private materialSwaps: { mesh: Mesh; material: Material }[] = [];
  /**
   * Batch and instanced materials the compiler created (white clones for per-instance colour); `decompile` disposes only
   * these. A material shared from the registry is the app's and stays usable.
   */
  private ownedMaterials = new Set<Material>();
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
    this.originalsMode = options.originals ?? 'hide';
    this.cullingMode = options.culling ?? 'bvh';
    this.instanceThreshold = options.instanceThreshold ?? 64;
    this.dynamicsMode = options.dynamics ?? 'separate';
    this.chunkSizeOption = options.chunkSize;
    this.lod = options.lod ?? null;
    this.occlusion = options.occlusion ?? false;
    this.animations = options.animations ?? [];
    this.nestedPassesOption = options.nestedPasses ?? 'auto';
    this.materialsMode = options.materials ?? 'canonical';
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

  /** One mesh per baked group (empty unless `bake` is on). */
  /** Objects `compile()` froze beyond the hidden originals (unbatched statics and all-static ancestors). */
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

  get frozenObjects(): readonly Object3D[] {
    return this.frozenList.map((f) => f.object);
  }

  /** One mesh per batched sprite group (`forge:sprites:<programHash>:<n>`). */
  get spriteBatches(): readonly Mesh[] {
    return this.spriteBatchList.map((b) => b.mesh);
  }

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
      const mesh = new Mesh(b.removed.clone(), new MeshBasicMaterial({ color: 0xff2040, side: DoubleSide, depthTest: false, transparent: true, opacity: 0.85 }));
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
      materials: new Set(classifications.flatMap((c) => (Array.isArray(c.object.material) ? c.object.material : [c.object.material]))).size,
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
    const result = batchStatics(statics, this.registry, this.scene, { instanceThreshold: this.instanceThreshold, coordinateSystem, chunkSize: this.chunkSizeOption, nestedPasses, passes: this.passes, space: this.space, transparent: this.transparentMode, ...(this.lod ? { lodDistances: this.lod.distances } : {}), ...(this.bakeOptions ? { bake: this.bakeOptions, noBake } : {}) });
    const transparentKeptSet = new Set<Mesh>(result.transparentKept);
    this.batches = result.batches;
    this.instanced = result.instanced;
    this.baked = result.baked;
    this.unbakeableEntries = result.unbakeable;
    this.slots = result.slots;
    this.originalsByBatch = result.originals;
    // A batch draws with its group's canonical when every instance is white (the app's registered material, or an
    // unsupported one the registry kept as is), else with a white clone made here: only the clone is the World's to dispose.
    for (const target of [...result.batches, ...result.instanced]) {
      const material = target.material as Material;
      const shared = (result.originals.get(target) ?? []).some((o) => o.material === material || this.registry.canonicalOf(o.material as Material) === material);
      if (!shared) this.ownedMaterials.add(material);
    }
    // Every batch is culled through a marginless tree, movers included: the BVH prefilters candidates by their exact
    // box, which is strictly tighter than three's bounding-sphere test applied after it, so enlarging the boxes does
    // not merely cost a refit — it admits instances whose sphere meets the frustum while their exact box does not.
    // See `CullingOptions.margin`. A synced mover refits its own leaf instead, which is correct and cheaper.
    if (this.cullingMode === 'bvh') {
      for (const batch of this.batches) {
        const geometryIds = result.lodGeometryIds.get(batch);
        const lod = this.lod && geometryIds ? { distances: this.lod.distances, geometryIds } : undefined;
        this.cullingHandles.set(batch, attachBvhCulling(batch, coordinateSystem, { nestedPasses, passes: this.passes, ...(lod ? { lod } : {}) }));
      }
    }
    for (const [mesh, rule] of syncRule) if (rule === null && result.slots.has(mesh)) this.syncedSet.add(mesh);
    this.installSync(result.slots);
    if (this.occlusion) this.installOcclusion();

    // Record parent indices before touching the graph so detach/restore round-trips exactly.
    for (const mesh of result.slots.keys()) {
      const parent = mesh.parent;
      if (parent) {
        this.hidden.push({ mesh, parent, index: parent.children.indexOf(mesh), layersMask: mesh.layers.mask, matrixAutoUpdate: mesh.matrixAutoUpdate, synced: this.syncedSet.has(mesh) });
      }
    }
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
        for (const sprite of group.sprites) {
          const parent = sprite.parent;
          if (parent) this.hidden.push({ mesh: sprite, parent, index: parent.children.indexOf(sprite), layersMask: sprite.layers.mask, matrixAutoUpdate: sprite.matrixAutoUpdate, synced: true });
        }
      });
      for (const { sprite, rule } of grouped.skipped) spriteSkips.push({ name: displayName(sprite, this.scene), rule });
    }
    for (const state of this.hidden) this.hideOriginal(state);

    // Freeze what never moves: unbatched statics and all-static ancestors stop recomposing matrices every frame.
    if (this.freezeStatics) {
      const hiddenSet = new Set<Object3D>(this.hidden.map((h) => h.mesh));
      const syncedSet = new Set<Object3D>(this.hidden.filter((h) => h.synced).map((h) => h.mesh));
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
      if (c.kind === 'static') this.ledger?.annotate(c.object, transparentKept ? 'excluded:transparent-kept' : 'unique-material');
      // Dynamic by rule (under a bone, animated) rather than by tag: still a dynamic draw, not an untagged one.
      if (c.kind === 'dynamic') this.ledger?.annotate(c.object, 'dynamic');
      this.canonicalise(c.object);
    }

    this.compiled = true;
    this.emitDirty({ kind: 'compile' });
    return {
      before,
      after: { batches: this.batches.length, instanced: this.instanced.length, baked: this.baked.length, spriteBatches: this.spriteBatchList.length, frozen: this.frozenList.length, meshes: classifications.length - result.slots.size },
      bake: this.bakeOptions ? this.bakeSummary() : null,
      groups: result.groups,
      skipped,
      registry: this.registry.stats(),
      culling: { mode: this.cullingMode, coordinateSystem },
      synced: this.syncedSet.size,
      lod: this.lod,
      occlusion: this.occlusion ? { proxies: this.occluders.length, skippedSynced: this.occlusionSkippedSynced } : null,
      nestedPasses,
    };
  }

  private installOcclusion(): void {
    // No proxy for a target holding batch-synced movers: a mover can leave the compile-time box, and while the proxy keeps
    // the target hidden three never calls the target's onBeforeRender (`Renderer._projectObject` returns at
    // `object.visible === false`), where the sync runs, so nothing could grow the box before the mover is on screen.
    const synced = new Set<Object3D>();
    for (const mesh of this.syncedSet) {
      const slot = this.slots.get(mesh);
      if (slot) synced.add(slot.batch);
    }
    const groups: Object3D[][] = this.batches.filter((b) => !synced.has(b)).map((b) => [b]);
    let skippedSynced = this.batches.length - groups.length;
    for (const mesh of this.instanced) {
      const levels = (mesh as CulledInstancedMesh).levels ?? [mesh];
      if (levels[0] !== mesh) continue;
      if (levels.some((level) => synced.has(level))) skippedSynced++;
      else groups.push(levels);
    }
    this.occlusionSkippedSynced = skippedSynced;
    const passes = this.passes;
    const space = this.space;
    const size = new Vector3();
    const center = new Vector3();
    for (const targets of groups) {
      const target = targets[0] as Object3D & { boundingBox?: { getSize(v: Vector3): Vector3; getCenter(v: Vector3): Vector3 } | null };
      const box = target.boundingBox;
      if (!box) continue;
      box.getSize(size);
      box.getCenter(center);
      const geometry = new BoxGeometry(Math.max(size.x, 1e-3), Math.max(size.y, 1e-3), Math.max(size.z, 1e-3));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const material = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
      const proxy = new Mesh(geometry, material);
      proxy.name = `forge:occluder:${target.name}`;
      proxy.position.copy(center);
      proxy.occlusionTest = true;
      proxy.renderOrder = 1; // after the opaque occluders it is tested against
      proxy.castShadow = false;
      proxy.receiveShadow = false;
      proxy.raycast = () => {};
      proxy.userData.forge = { kind: 'occlusion-proxy' };
      this.scene.add(proxy);
      const entry: OcclusionEntry = { proxy, targets, parked: false };
      this.occluders.push(entry);
      const resume = (): void => {
        proxy.occlusionTest = true;
      };
      this.occlusionRestores.push(
        // Before the proxy's draw in the outermost render: when a query from this camera could miss a visible target (the
        // eye inside the box, the near plane cutting into it: `cameraNearProxy`), issue none. three begins a query at the
        // draw and ends it at the next draw or at the end of the render, reading `occlusionTest` both times
        // (WebGPUBackend.draw / finishRender, WebGLBackend.draw / finishRender), so the flag stays off until the
        // outermost render is over (PassTracker.atEnd runs in the scene's onAfterRender, after finishRender). The render
        // list has already counted the proxy; its unused query slot is skipped when the results are read. A result set
        // without the proxy never reports it occluded, so no late answer from this render can hide the targets.
        prependRenderHook(proxy, (_renderer, _scene, camera) => {
          if (!proxy.occlusionTest) return;
          if (passes.depth === 0) {
            // Drawn without the scene's own hooks (the scene is a child of another root passed to render()): no pass to
            // tell the outermost render by, and no end-of-render hook. Fail safe: issue no query, and the after-render hook
            // shows the targets. The flag comes back in a microtask, once render() has returned: never inside a render,
            // where three reads it again to end the query.
            proxy.occlusionTest = false;
            entry.parked = true;
            if (!this.occlusionResumeQueued) {
              this.occlusionResumeQueued = true;
              queueMicrotask(this.resumeParkedProxies);
            }
            return;
          }
          if (passes.depth !== 1 || !cameraNearProxy(camera, proxy, space)) return;
          proxy.occlusionTest = false;
          passes.atEnd(resume);
        }),
        // Ask inside the proxy's own after-render hook: that runs within renderObject(), while the render context is
        // current (the scene-level hook runs after three has restored the outer context and would see nothing), and
        // returns the last result set published for that context, from a render at least two renders back. Only the
        // outermost render decides: a nested pass (a reflection, a portal) reads its own context's results. At depth 0 the
        // query was parked above, so the targets are shown.
        prependAfterRenderHook(proxy, (renderer) => {
          if (passes.depth > 1) return;
          const query = (renderer as { isOccluded?: (object: Object3D) => boolean }).isOccluded;
          if (typeof query !== 'function') return;
          const occluded = proxy.occlusionTest && query.call(renderer, proxy) === true;
          for (const t of targets) t.visible = !occluded;
        }),
      );
    }
  }

  /**
   * Fits an occlusion proxy to its target's bounding box again, the way `installOcclusion` sized it (the box's centre,
   * each extent 1 mm at least; target and proxy are both children of the scene). The proxy moves and the corners of its
   * one-segment box geometry are rewritten in place: every position component of such a box is plus or minus half an
   * extent, so no geometry is created and the values match a new `BoxGeometry` of that size exactly.
   */
  private fitProxy(entry: OcclusionEntry): void {
    const box = (entry.targets[0] as Object3D & { boundingBox?: Box3 | null }).boundingBox;
    if (!box) return;
    box.getSize(_size);
    box.getCenter(_center);
    const hx = Math.max(_size.x, 1e-3) / 2;
    const hy = Math.max(_size.y, 1e-3) / 2;
    const hz = Math.max(_size.z, 1e-3) / 2;
    const geometry = entry.proxy.geometry;
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) position.setXYZ(i, Math.sign(position.getX(i)) * hx, Math.sign(position.getY(i)) * hy, Math.sign(position.getZ(i)) * hz);
    position.needsUpdate = true;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    entry.proxy.position.copy(_center);
  }

  /** Show or hide an original mesh, wherever it ended up. A baked module rebakes its group. */
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
   * Move a frozen static (or a whole subtree) on demand: recomposes every local matrix under `object`, recomputes
   * the world matrices, and pushes every batched original in the subtree into its batch in the scene's space
   * (BatchedMesh matrix and BVH leaf, InstancedMesh through its culling handle, baked groups by rebaking once). Then
   * recomputes the bounds of each touched batch and instanced group once, so three's whole-object frustum test keeps a
   * moved instance, and fits their occlusion proxies to the new bounds. Sprite batches follow on their own. Returns the
   * number of batched instances updated.
   *
   * With `originals: 'detach'`, a detached original has no parent, so `updateMatrixWorld` alone would give its local
   * matrix, not its former scene-relative one: its world matrix is instead composed from its former parent's current
   * one (read, not recomputed here — `markDirty` on that parent, or an ancestor reached through the still-attached
   * graph, refreshes it) and the original's own freshly recomposed local matrix. `markDirty` on a former parent
   * reaches its detached descendants too, even though they are no longer its children.
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
      const bakedGroup = this.baked.find((b) => b.mesh === slot.batch);
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

    // A detached original's own children are off the graph too (removeFromParent leaves its subtree intact under
    // it), so they need the same manual matrixWorld composition, seeded from the parent's just-computed matrixWorld.
    // Nested detach (a detached original whose recorded former parent is itself detached) composes the same way.
    const rebuildDetached = (node: Object3D, parentWorld: Matrix4): void => {
      node.updateMatrix();
      node.matrixWorld.multiplyMatrices(parentWorld, node.matrix);
      // updateMatrix() left the flag set: an unforced updateMatrixWorld() on the parentless node would copy `matrix` over
      // what was just composed (Object3D.updateMatrixWorld). A node with matrixAutoUpdate on recomposes and sets it again.
      node.matrixWorldNeedsUpdate = false;
      visitSlot(node);
      const nested = this.detachedByParent.get(node);
      if (nested) for (const child of nested) rebuildDetached(child, node.matrixWorld);
      for (const child of node.children) rebuildDetached(child, node.matrixWorld);
    };

    const formerParent = this.detachedParents.get(object);
    if (formerParent) {
      // `object` is itself a detached original: rebuild it (and any of its own descendants) from its former parent.
      rebuildDetached(object, formerParent.matrixWorld);
    } else {
      object.traverse((o) => o.updateMatrix());
      object.updateMatrixWorld(true);
      object.traverse((o) => {
        visitSlot(o);
        const detachedChildren = this.detachedByParent.get(o);
        if (detachedChildren) for (const child of detachedChildren) rebuildDetached(child, o.matrixWorld);
      });
    }

    for (const group of rebakes) rebake(group);
    for (const batch of batches) {
      batch.computeBoundingBox();
      batch.computeBoundingSphere();
    }
    for (const handle of handles) handle.refreshBounds();
    if (batches.size + handles.size > 0) {
      for (const entry of this.occluders) {
        const target = entry.targets[0] as BatchedMesh | CulledInstancedMesh;
        if (batches.has(target as BatchedMesh) || handles.has((target as CulledInstancedMesh).forgeCulling)) this.fitProxy(entry);
      }
    }
    this.emitDirty({ kind: 'markDirty', object });
    return updated;
  }

  setVisible(original: Mesh, visible: boolean): void {
    this.assertLive();
    this.emitDirty({ kind: 'setVisible', object: original });
    const slot = this.slots.get(original);
    if (!slot) {
      original.visible = visible;
      return;
    }
    const bakedGroup = this.baked.find((b) => b.mesh === slot.batch);
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

  private installSync(slots: Map<Mesh, Slot>): void {
    if (this.syncedSet.size === 0) return;
    const perTarget = new Map<BatchedMesh | InstancedMesh, SyncEntry[]>();
    for (const mesh of this.syncedSet) {
      const slot = slots.get(mesh)!;
      // Synced dynamics never land in a baked group (batchStatics keeps their groups as BatchedMesh).
      const target = slot.batch as BatchedMesh | InstancedMesh;
      let list = perTarget.get(target);
      if (!list) perTarget.set(target, (list = []));
      list.push({ mesh, instanceId: slot.instanceId, last: Float32Array.from(mesh.matrixWorld.elements) });
    }
    for (const [target, entries] of perTarget) {
      // A synced instance can leave the precomputed bounds; per-instance culling still applies.
      target.frustumCulled = false;
      const batched = (target as BatchedMesh).isBatchedMesh ? (target as BatchedMesh) : null;
      const handle = batched ? this.cullingHandles.get(batched) : undefined;
      const instanced = batched ? null : (target as CulledInstancedMesh);
      const space = this.space;
      // What is written is inverse(scene) * world: once the scene moved since the last sync every entry is rewritten, also
      // one whose world matrix did not change (a world-anchored mover, a floating-origin shift of the scene root).
      space.update();
      let spaceVersion = space.version;
      const sync = (): void => {
        space.update();
        const sceneMoved = space.version !== spaceVersion;
        spaceVersion = space.version;
        for (const entry of entries) {
          const e = entry.mesh.matrixWorld.elements;
          const last = entry.last;
          let changed = sceneMoved;
          for (let i = 0; !changed && i < 16; i++) {
            if (e[i] !== last[i]) changed = true;
          }
          if (!changed) continue;
          last.set(e);
          // In the scene's space as of this render: three refreshes scene.matrixWorld before any object hook runs.
          const matrix = space.toLocal(entry.mesh.matrixWorld, _local);
          if (batched) {
            batched.setMatrixAt(entry.instanceId, matrix);
            handle?.move(entry.instanceId);
          } else if (instanced) {
            instanced.forgeCulling.setMatrixAt(entry.instanceId, matrix);
          }
        }
      };
      this.syncRestores.push(prependRenderHook(target, sync));
    }
  }

  /**
   * Build shaders and upload textures now instead of on the first visible frame. Call after `compile()`.
   * The default renders one real frame under a 1x1 scissor, which is the only way in three r186 to get exactly
   * the pipelines the first frame will use: `compileAsync()` mis-compiles transparent double-sided and
   * transmissive materials (see `WarmupResult.repaired`), so `mode: 'async'` runs it and then repairs those.
   */
  async warmup(renderer: WarmupRenderer, camera: Camera, options: WarmupOptions = {}): Promise<WarmupResult> {
    this.assertLive();
    // Awaiting init here, before any state is read or changed, leaves no yield between the suspension and scissor
    // below and the render: a queued re-enable (or any other microtask) cannot run in between. That is why warm-up
    // renders with `render()` rather than the deprecated `renderAsync` (docs/threeforge.md section 4, "How it hooks in").
    if (renderer.init) await renderer.init();
    // A proxy parked by a depth-0 render waits for its queued re-enable, which would re-enable it after the suspension
    // list below was built without it if anything yielded before the render. Resume now, so the list holds every proxy;
    // the queued call then finds nothing parked.
    this.resumeParkedProxies();
    const textures = new Set<Texture>();
    const materials = new Set<Material>();
    this.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material);
        for (const value of Object.values(material as unknown as Record<string, unknown>)) {
          if ((value as Texture | null)?.isTexture) textures.add(value as Texture);
        }
      }
    });
    if (renderer.initTexture) for (const texture of textures) renderer.initTexture(texture);
    const mode = options.mode === 'async' && renderer.compileAsync ? 'async' : 'frame';
    let repaired = 0;
    if (mode === 'async') {
      try {
        await renderer.compileAsync!(this.scene, camera);
      } finally {
        // three r186's compileAsync calls the scene's onBeforeRender but never its onAfterRender (Renderer.js ~967): the
        // tracker would count the next render as nested, also after a rejection. It renders no shadow maps, so only its
        // own render is open.
        this.passes.reset();
      }
      for (const material of materials) {
        if (!compiledWrongByCompileAsync(material)) continue;
        material.dispose(); // drops the renderer's cached render objects; the material stays usable
        repaired++;
      }
    }
    // One real frame, clipped to a single pixel: builds (or rebuilds) every pipeline the way `render()` does.
    const scissor = renderer.getScissor(new Vector4());
    const scissorTest = renderer.getScissorTest();
    // No occlusion query from this frame: the scissor discards every fragment, so each query would count no samples and,
    // once three publishes that answer a render or more later, hide every target whose proxy was drawn. A render whose
    // list counts no query publishes nothing (the `else` branch of both backends' beginRender), and render() has
    // returned by the `finally`, so no query is open when the flags come back.
    const suspended: Mesh[] = [];
    for (const { proxy } of this.occluders) {
      if (!proxy.occlusionTest) continue;
      proxy.occlusionTest = false;
      suspended.push(proxy);
    }
    renderer.setScissor(0, 0, 1, 1);
    renderer.setScissorTest(true);
    try {
      renderer.render(this.scene, camera);
    } finally {
      for (const proxy of suspended) proxy.occlusionTest = true;
      renderer.setScissorTest(scissorTest);
      renderer.setScissor(scissor.x, scissor.y, scissor.z, scissor.w);
    }
    return { mode, textures: renderer.initTexture ? textures.size : 0, repaired };
  }

  decompile(): void {
    if (!this.compiled) return;
    for (const restore of this.sceneHookRestores.reverse()) restore();
    this.sceneHookRestores = [];
    this.passes.reset();
    // Materials merged into another of this compile's own materials are forgotten first, so `releaseMaterial()`
    // below sees, per canonical, only the dependents this decompile is not also dropping.
    for (const material of this.createdMaterials()) {
      const canonical = this.registry.canonicalOf(material);
      if (canonical !== undefined && canonical !== material) this.registry.forget(material);
    }
    for (const restore of this.occlusionRestores) restore();
    this.occlusionRestores = [];
    for (const { proxy, targets } of this.occluders) {
      proxy.removeFromParent();
      proxy.geometry.dispose();
      this.releaseMaterial(proxy.material as Material);
      for (const t of targets) t.visible = true;
    }
    this.occluders = [];
    this.occlusionSkippedSynced = 0;
    for (const restore of this.syncRestores.reverse()) restore();
    this.syncRestores = [];
    this.syncedSet = new Set();
    for (const batch of this.batches) {
      this.cullingHandles.get(batch)?.detach();
      batch.removeFromParent();
      if (this.ownedMaterials.has(batch.material as Material)) this.releaseMaterial(batch.material as Material);
      batch.dispose();
    }
    for (const mesh of this.instanced) {
      (mesh as CulledInstancedMesh).forgeCulling?.detach();
      mesh.removeFromParent();
      if (this.ownedMaterials.has(mesh.material as Material)) this.releaseMaterial(mesh.material as Material);
      mesh.dispose();
    }
    this.ownedMaterials = new Set();
    for (const b of this.baked) {
      b.mesh.removeFromParent();
      b.mesh.geometry.dispose();
      b.removed.dispose();
      if (b.ownsMaterial) this.releaseMaterial(b.mesh.material as Material);
    }
    this.baked = [];
    this.unbakeableEntries = 0;
    for (const batch of this.spriteBatchList) {
      batch.mesh.removeFromParent();
      // `SpriteBatch.dispose()` would dispose this material unconditionally; `releaseMaterial` decides instead, by
      // the same rule as every other material this compile created. So a material another registered material still
      // merges into is left registered *and* alive: that material resolves to this exact object, and a disposed
      // canonical would break every mesh drawn with it.
      batch.dispose({ material: false });
      this.releaseMaterial(batch.material as Material);
    }
    this.spriteBatchList = [];
    for (const f of this.frozenList.reverse()) f.object.matrixAutoUpdate = f.matrixAutoUpdate;
    this.frozenList = [];
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
    this.detachedParents = new Map();
    this.detachedByParent = new Map();
    this.materialSwaps = [];
    this.compiled = false;
    this.emitDirty({ kind: 'decompile' });
  }

  /**
   * Tears the World down for good. Decompiles first when compiled (listeners still hear `decompile`): that uninstalls the
   * pass tracker's scene hooks, removes and disposes the occlusion proxies (a re-enable a depth-0 render queued finds no
   * proxy) and disposes what the World created, never a material the app registered. Then every `onDirty` listener is
   * dropped. The registry and the ledger stay the app's. Calling `dispose()` again, or `decompile()`, does nothing;
   * `compile`, `markDirty`, `setVisible`, `onDirty` and `warmup` throw, already while `dispose()` runs (a `decompile`
   * listener that recompiles is refused), and the World ends disposed even when a listener throws.
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

  /**
   * Every material this compile created and `decompile()` disposes: the white clones carrying per-instance colours
   * for batches and instanced groups, a baked group's vertex-colour clone, and the occlusion proxies' and sprite
   * batches' own materials. Never a material the app registered and the compiler only shared.
   */
  private createdMaterials(): Material[] {
    const created: Material[] = [];
    for (const { proxy } of this.occluders) created.push(proxy.material as Material);
    for (const target of [...this.batches, ...this.instanced]) {
      const material = target.material as Material;
      if (this.ownedMaterials.has(material)) created.push(material);
    }
    for (const b of this.baked) if (b.ownsMaterial) created.push(b.mesh.material as Material);
    for (const batch of this.spriteBatchList) created.push(batch.material as Material);
    return created;
  }

  /**
   * Drops a material this compile created from the registry and disposes it, so nothing the registry hands out ever
   * points at a disposed object. A canonical another *registered* material still merges into is left exactly as it
   * is — registered and undisposed — because that material resolves to this very object: disposing it would break
   * every mesh drawn with it, and forgetting it would leave it resolving to an object the registry no longer knows.
   * Such a material is the app's to release once it stops using the duplicate (`registry.dependentsOf`).
   */
  private releaseMaterial(material: Material): void {
    const canonical = this.registry.canonicalOf(material);
    if (canonical !== undefined) {
      if (canonical === material && this.registry.dependentsOf(material) > 0) return;
      this.registry.forget(material);
    }
    material.dispose();
  }

  private assertLive(): void {
    if (this.disposed || this.disposing) throw new Error('World is disposed; create a new World to compile the scene again.');
  }

  slotOf(mesh: Mesh): Slot | undefined {
    return this.slots.get(mesh);
  }

  /** The original mesh behind a raycast hit on a batch, an instanced mesh or a baked mesh; the hit object itself otherwise. */
  resolve(intersection: Intersection): Object3D {
    const bakedGroup = this.baked.find((b) => b.mesh === intersection.object);
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

  private bakeSummary(): BakeSummary {
    const sum: BakeSummary = { groups: this.baked.length, inputTriangles: 0, triangles: 0, contactFaces: 0, keptCoincidentFaces: 0, duplicateFaces: 0, buriedFaces: 0, weldedVertices: 0, excludedEntries: 0, keptDuplicateFaces: 0, unbakeableEntries: this.unbakeableEntries };
    for (const { report } of this.baked) {
      sum.inputTriangles += report.inputTriangles;
      sum.triangles += report.triangles;
      sum.contactFaces += report.contactFaces;
      sum.keptCoincidentFaces += report.keptCoincidentFaces;
      sum.duplicateFaces += report.duplicateFaces;
      sum.buriedFaces += report.buriedFaces;
      sum.weldedVertices += report.weldedVertices;
      sum.excludedEntries += report.excludedEntries;
      sum.keptDuplicateFaces += report.keptDuplicateFaces;
    }
    return sum;
  }

  private hideOriginal(state: OriginalState): void {
    const { mesh, parent, synced } = state;
    if (this.originalsMode === 'detach' && !synced) {
      mesh.removeFromParent();
      this.detachedParents.set(mesh, parent);
      let siblings = this.detachedByParent.get(parent);
      if (!siblings) this.detachedByParent.set(parent, (siblings = new Set()));
      siblings.add(mesh);
    } else {
      mesh.layers.set(FORGE_HIDDEN_LAYER);
      if (!synced) mesh.matrixAutoUpdate = false;
    }
  }

  private canonicalise(mesh: Mesh): void {
    if (Array.isArray(mesh.material)) return;
    const canonical = this.registry.register(mesh.material);
    if (this.materialsMode === 'keep') return;
    if (canonical !== mesh.material) {
      this.materialSwaps.push({ mesh, material: mesh.material });
      mesh.material = canonical;
    }
  }
}

export type { Classification };
