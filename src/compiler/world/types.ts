import type { Camera, CoordinateSystem, Object3D, Texture, Vector4 } from 'three';
import type { DrawCallLedger } from '../../ledger/DrawCallLedger.js';
import type { MaterialRegistry, RegistryStats } from '../../registry/MaterialRegistry.js';
import type { BakeOptions } from '../bake.js';
import type { GroupReport } from '../batchStatics.js';
import type { AnimationSource } from '../classify.js';
import type { NestedPassPolicy } from '../culling.js';

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
   * Occlusion culling per batch and instanced group through three's occlusion queries: an invisible proxy box per
   * target carries `occlusionTest`, and a target whose proxy was reported fully occluded (two or more renders late) is
   * skipped. Only the outermost render decides; a proxy the camera is inside of, or that the near plane reaches into,
   * issues no query, and neither does `warmup()`'s scissored frame. Targets holding batch-synced movers get no proxy
   * (`report.occlusion.skippedSynced`). One outermost camera per frame is assumed. Costs one cheap submission per
   * target; needs a renderer with `isOccluded()` (WebGPURenderer, either backend).
   *
   * A skipped target is skipped in every pass of that frame, so it also leaves shadow maps and reflections: leave
   * `occlusion` off where a light or a mirror sees what the camera cannot (`docs/threeforge.md`, "Occlusion").
   */
  occlusion?: boolean;
  /** Clips that will drive this scene (e.g. `gltf.animations`), or `{ root, clips }` per animated character. */
  animations?: AnimationSource[];
  /**
   * Culling of batches in passes nested in another render of the scene (shadow maps, reflections, portals). A batch an
   * enclosing pass has culled keeps that pass's rows as a stable prefix under either policy (see `attachBvhCulling`);
   * the policy decides a batch no enclosing pass has culled yet: `per-pass` culls it for the nested camera, `reuse-main`
   * keeps its last outermost cull and appends. Compacted instanced meshes behave the same under both (see
   * `createCulledInstancedMesh`). `auto` (default) is `per-pass` on both backends.
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
