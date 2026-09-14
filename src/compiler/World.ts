import { BoxGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, Vector3, Vector4, WebGLCoordinateSystem, WebGPUCoordinateSystem, type BatchedMesh, type Camera, type CoordinateSystem, type InstancedMesh, type Intersection, type Material, type Object3D, type Scene, type Sprite, type Texture } from 'three';
import type { DrawCallLedger } from '../ledger/DrawCallLedger.js';
import { displayName } from '../ledger/reasons.js';
import { MaterialRegistry, type RegistryStats } from '../registry/MaterialRegistry.js';
import { batchStatics, type GroupReport, type Slot, rebake, type BakedGroup } from './batchStatics.js';
import type { BakeOptions } from './bake.js';
import type { CulledInstancedMesh } from './instancing.js';
import { classify, exclusionRule, type AnimationSource, type Classification } from './classify.js';
import { buildSpriteBatch, type SpriteBatch } from './spriteBatch.js';
import { groupSprites } from './sprites.js';
import { attachBvhCulling, prependAfterRenderHook, prependRenderHook, type CullingHandle, type NestedPassPolicy } from './culling.js';

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
  /**
   * Occlusion culling per batch / instanced group through three's occlusion queries: an invisible proxy box per
   * target carries `occlusionTest`; a target whose proxy was fully occluded last frame is skipped this frame.
   * Costs one cheap submission per target. Needs a renderer with `isOccluded()` (WebGPURenderer, either backend).
   */
  occlusion?: boolean;
  /** Clips that will drive this scene (e.g. `gltf.animations`), or `{ root, clips }` per animated character. */
  animations?: AnimationSource[];
  /**
   * Culling for nested render passes (reflections, portals). `auto` (default) is `reuse-main` on the WebGPU
   * backend, where a second instance-list change per frame is not picked up by the main pass, and `per-pass` on WebGL.
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
  /** Sprites a material needs before its group is batched (default 4). */
  spriteThreshold?: number;
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
  duplicateFaces: number;
  buriedFaces: number;
  weldedVertices: number;
  excludedEntries: number;
}

export interface CompileReport {
  before: { meshes: number; materials: number };
  after: { batches: number; instanced: number; baked: number; spriteBatches: number; meshes: number };
  /** Totals over the baked groups, null when `bake` is off. */
  bake: BakeSummary | null;
  groups: GroupReport[];
  skipped: { name: string; rule: string }[];
  registry: RegistryStats;
  culling: { mode: 'bvh' | 'linear'; coordinateSystem: CoordinateSystem };
  /** Dynamics folded into batches with matrix sync (0 unless `dynamics: 'batch-sync'`). */
  synced: number;
  lod: { distances: number[] } | null;
  occlusion: { proxies: number } | null;
  nestedPasses: NestedPassPolicy;
}

export interface WarmupRenderer {
  render(scene: Object3D, camera: Camera): unknown;
  renderAsync?(scene: Object3D, camera: Camera): Promise<unknown>;
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
  private readonly occlusion: boolean;
  private readonly animations: AnimationSource[];
  private readonly nestedPassesOption: NestedPassPolicy | 'auto';
  private readonly materialsMode: 'canonical' | 'keep';
  private _mainCamera: Camera | null = null;
  private renderDepth = 0;
  private sceneHookRestores: (() => void)[] = [];
  private occluders: OcclusionEntry[] = [];
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
  private spriteBatchList: SpriteBatch[] = [];
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
    this.occlusion = options.occlusion ?? false;
    this.animations = options.animations ?? [];
    this.nestedPassesOption = options.nestedPasses ?? 'auto';
    this.materialsMode = options.materials ?? 'canonical';
    this.bakeOptions = options.bake === true ? {} : options.bake ? options.bake : null;
    this.spriteMode = options.sprites ?? 'batch';
    this.spriteThreshold = options.spriteThreshold ?? 4;
  }

  /** The camera of the outermost render in the current or last frame (tracked once compiled with `reuse-main`). */
  get mainCamera(): Camera | null {
    return this._mainCamera;
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
  /** One mesh per batched sprite group (`forge:sprites:<programHash>:<n>`). */
  get spriteBatches(): readonly Mesh[] {
    return this.spriteBatchList.map((b) => b.mesh);
  }

  get bakedMeshes(): readonly Mesh[] {
    return this.baked.map((b) => b.mesh);
  }

  /** The faces every bake removed, one unlit red double-sided mesh per group, for inspection. Not added to the scene. */
  bakeDebug(): Group {
    const group = new Group();
    group.name = 'forge:bake-debug';
    this.baked.forEach((b, i) => {
      const mesh = new Mesh(b.removed, new MeshBasicMaterial({ color: 0xff2040, side: DoubleSide, depthTest: false, transparent: true, opacity: 0.85 }));
      mesh.name = `forge:bake-removed:${i}`;
      mesh.renderOrder = 1000;
      group.add(mesh);
    });
    return group;
  }

  compile(options: CompileOptions = {}): CompileReport {
    if (this.compiled) throw new Error('World is already compiled; call decompile() first.');
    const coordinateSystem = options.coordinateSystem ?? WebGLCoordinateSystem;
    const nestedPasses: NestedPassPolicy =
      this.nestedPassesOption === 'auto' ? (coordinateSystem === WebGPUCoordinateSystem ? 'reuse-main' : 'per-pass') : this.nestedPassesOption;
    const mainCamera = (): Camera | null => this._mainCamera;
    if (nestedPasses === 'reuse-main') {
      // Scene hooks bracket every render() call; depth 0 is the outermost render and its camera is the main camera.
      this.sceneHookRestores.push(
        prependRenderHook(this.scene, (_renderer, _scene, camera) => {
          if (this.renderDepth === 0) this._mainCamera = camera;
          this.renderDepth++;
        }),
        prependAfterRenderHook(this.scene, () => {
          this.renderDepth = Math.max(0, this.renderDepth - 1);
        }),
      );
    }
    const classifications = classify(this.scene, { policy: this.policy, animations: this.animations });
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
    const noBake = new Set<Mesh>([...syncRule.entries()].filter(([, rule]) => rule === null).map(([mesh]) => mesh));
    const result = batchStatics(statics, this.registry, this.scene, { instanceThreshold: this.instanceThreshold, coordinateSystem, chunkSize: this.chunkSize, nestedPasses, mainCamera, ...(this.lod ? { lodDistances: this.lod.distances } : {}), ...(this.bakeOptions ? { bake: this.bakeOptions, noBake } : {}) });
    this.batches = result.batches;
    this.instanced = result.instanced;
    this.baked = result.baked;
    this.slots = result.slots;
    this.originalsByBatch = result.originals;
    if (this.cullingMode === 'bvh') {
      for (const batch of this.batches) {
        const geometryIds = result.lodGeometryIds.get(batch);
        const lod = this.lod && geometryIds ? { distances: this.lod.distances, geometryIds } : undefined;
        this.cullingHandles.set(batch, attachBvhCulling(batch, coordinateSystem, { nestedPasses, mainCamera, ...(lod ? { lod } : {}) }));
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
      const grouped = groupSprites(sprites, this.spriteThreshold, (m) => this.registry.describe(m));
      const sync = (camera: Camera): boolean => nestedPasses === 'per-pass' || camera === this._mainCamera;
      grouped.groups.forEach((group, i) => {
        const batch = buildSpriteBatch(group, i, { sync, root: this.scene });
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

    const skipped: CompileReport['skipped'] = [...spriteSkips];
    for (const c of classifications) {
      if (result.slots.has(c.object)) continue;
      let rule = c.kind === 'static' ? 'singleton' : c.rule;
      if (c.kind === 'dynamic') rule = syncRule.get(c.object) ?? rule;
      skipped.push({ name: displayName(c.object, this.scene), rule });
      if (c.kind === 'excluded') this.ledger?.annotate(c.object, `excluded:${c.rule}`);
      // A static with nothing to share a draw with: the ledger should say why, even under policy 'auto'.
      if (c.kind === 'static') this.ledger?.annotate(c.object, 'unique-material');
      // Dynamic by rule (under a bone, animated) rather than by tag: still a dynamic draw, not an untagged one.
      if (c.kind === 'dynamic') this.ledger?.annotate(c.object, 'dynamic');
      this.canonicalise(c.object);
    }

    this.compiled = true;
    return {
      before,
      after: { batches: this.batches.length, instanced: this.instanced.length, baked: this.baked.length, spriteBatches: this.spriteBatchList.length, meshes: classifications.length - result.slots.size },
      bake: this.bakeOptions ? this.bakeSummary() : null,
      groups: result.groups,
      skipped,
      registry: this.registry.stats(),
      culling: { mode: this.cullingMode, coordinateSystem },
      synced: this.syncedSet.size,
      lod: this.lod,
      occlusion: this.occlusion ? { proxies: this.occluders.length } : null,
      nestedPasses,
    };
  }

  private installOcclusion(): void {
    const groups: Object3D[][] = [...this.batches.map((b) => [b])];
    for (const mesh of this.instanced) {
      const levels = (mesh as CulledInstancedMesh).levels ?? [mesh];
      if (levels[0] === mesh) groups.push(levels);
    }
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
      this.occluders.push({ proxy, targets });
      // Ask inside the proxy's own after-render hook: that runs within renderObject(), while the main pass's
      // render context is current, and returns the previously resolved query result (one frame of latency).
      // The scene-level hook runs after three has already restored the outer context and would see nothing.
      this.occlusionRestores.push(
        prependAfterRenderHook(proxy, (renderer) => {
          const query = (renderer as { isOccluded?: (object: Object3D) => boolean }).isOccluded;
          if (typeof query !== 'function') return;
          const occluded = query.call(renderer, proxy) === true;
          for (const t of targets) t.visible = !occluded;
        }),
      );
    }
  }

  /** Show or hide an original mesh, wherever it ended up. A baked module rebakes its group. */
  setVisible(original: Mesh, visible: boolean): void {
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

  /**
   * Build shaders and upload textures now instead of on the first visible frame. Call after `compile()`.
   * The default renders one real frame under a 1x1 scissor, which is the only way in three r186 to get exactly
   * the pipelines the first frame will use: `compileAsync()` mis-compiles transparent double-sided and
   * transmissive materials (see `WarmupResult.repaired`), so `mode: 'async'` runs it and then repairs those.
   */
  async warmup(renderer: WarmupRenderer, camera: Camera, options: WarmupOptions = {}): Promise<WarmupResult> {
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
      await renderer.compileAsync!(this.scene, camera);
      for (const material of materials) {
        if (!compiledWrongByCompileAsync(material)) continue;
        material.dispose(); // drops the renderer's cached render objects; the material stays usable
        repaired++;
      }
    }
    // One real frame, clipped to a single pixel: builds (or rebuilds) every pipeline the way `render()` does.
    const scissor = renderer.getScissor(new Vector4());
    const scissorTest = renderer.getScissorTest();
    renderer.setScissor(0, 0, 1, 1);
    renderer.setScissorTest(true);
    try {
      if (renderer.renderAsync) await renderer.renderAsync(this.scene, camera);
      else renderer.render(this.scene, camera);
    } finally {
      renderer.setScissorTest(scissorTest);
      renderer.setScissor(scissor.x, scissor.y, scissor.z, scissor.w);
    }
    return { mode, textures: renderer.initTexture ? textures.size : 0, repaired };
  }

  decompile(): void {
    if (!this.compiled) return;
    for (const restore of this.sceneHookRestores.reverse()) restore();
    this.sceneHookRestores = [];
    this._mainCamera = null;
    this.renderDepth = 0;
    for (const restore of this.occlusionRestores) restore();
    this.occlusionRestores = [];
    for (const { proxy, targets } of this.occluders) {
      proxy.removeFromParent();
      proxy.geometry.dispose();
      (proxy.material as Material).dispose();
      for (const t of targets) t.visible = true;
    }
    this.occluders = [];
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
    for (const b of this.baked) {
      b.mesh.removeFromParent();
      b.mesh.geometry.dispose();
      b.removed.dispose();
      if (b.ownsMaterial) (b.mesh.material as Material).dispose();
    }
    this.baked = [];
    for (const batch of this.spriteBatchList) {
      batch.mesh.removeFromParent();
      batch.dispose();
    }
    this.spriteBatchList = [];
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
    const sum: BakeSummary = { groups: this.baked.length, inputTriangles: 0, triangles: 0, contactFaces: 0, duplicateFaces: 0, buriedFaces: 0, weldedVertices: 0, excludedEntries: 0 };
    for (const { report } of this.baked) {
      sum.inputTriangles += report.inputTriangles;
      sum.triangles += report.triangles;
      sum.contactFaces += report.contactFaces;
      sum.duplicateFaces += report.duplicateFaces;
      sum.buriedFaces += report.buriedFaces;
      sum.weldedVertices += report.weldedVertices;
      sum.excludedEntries += report.excludedEntries;
    }
    return sum;
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
    if (this.materialsMode === 'keep') return;
    if (canonical !== mesh.material) {
      this.materialSwaps.push({ mesh, material: mesh.material });
      mesh.material = canonical;
    }
  }
}

export type { Classification };
