import type { FrameSnapshot } from 'threeforge';

/** The benchmark scenes, in the order the runner and the tables use. */
export const SCENE_IDS = ['village', 'forest', 'crowd', 'bossfight', 'lake', 'daynight', 'zen', 'rpg'] as const;
export type SceneId = (typeof SCENE_IDS)[number];
/** Warm-up frames before measuring, and measured frames (medians). */
export const WARM = 10;
export const MEASURED = 60;

/** One variant of one scene: the cost metrics `pnpm bench` gates plus the two timings it records. */
export interface BenchMetrics {
  sceneSubmissions: number;
  gpuDraws: number;
  triangles: number;
  programs: number;
  overdrawOpaque: number;
  overdrawTransparent: number;
  skinnedVertices: number;
  shadowCasters: number;
  /** Mean shadow-map texels rendered per measured frame, rounded (a map counts on the frames it renders on). */
  shadowTexels: number;
  textureBytes: number;
  geometryBytes: number;
  renderTargetBytes: number;
  /** Particles drawn per frame (points vertices, sprites, sprite-batch instances). */
  particles: number;
  /** (opaque + transparent fragments per pixel) × drawing-buffer pixels, in millions: the fill cost per frame. */
  fillMegapixels: number;
  /** Objects three walks every frame. */
  objects: number;
  /** Objects whose matrices three recomposes every frame (freezing lowers it). */
  autoUpdatedMatrices: number;
  /** Mean shadow passes per measured frame (a frozen or quantized shadow map renders on few of them). */
  shadowPassesPerFrame: number;
  renderMs: number;
  frameMs: number;
  unattributed: number;
}

/**
 * The metric keys in wire order: the single TypeScript-side source, used by `bench-app/submit.ts`.
 * `scripts/bench-schema.mjs` repeats the list for the node scripts, which cannot import TypeScript;
 * `test/unit/bench-metrics.test.ts` asserts the two agree and that together they cover `BenchMetrics` exactly.
 */
export const METRIC_KEYS: ReadonlyArray<keyof BenchMetrics> = [
  'sceneSubmissions',
  'gpuDraws',
  'triangles',
  'programs',
  'overdrawOpaque',
  'overdrawTransparent',
  'skinnedVertices',
  'shadowCasters',
  'shadowTexels',
  'textureBytes',
  'geometryBytes',
  'renderTargetBytes',
  'particles',
  'fillMegapixels',
  'objects',
  'autoUpdatedMatrices',
  'shadowPassesPerFrame',
  'renderMs',
  'frameMs',
  'unattributed',
];

/**
 * Shared by the CI runner (test/e2e/bench.spec.ts) and the device bench page so the two cannot drift. `shadowTexels`
 * is the rounded mean of `lighting.shadowTexels` over the same fixed frame window each run (a frozen or quantized map
 * renders on a fixed share of those frames). `programs` comes from the caller because `f` is captured after
 * `measureOverdraw()`, whose count materials' shader stages stay in `renderer.info.memory.programs` (three frees a
 * stage only once its `usedTimes` reaches 0); both callers pass the value read from the last measured frame.
 */
export function metricsOf(
  f: FrameSnapshot,
  renderMs: number,
  frameMs: number,
  shadowPassesPerFrame: number,
  shadowTexels: readonly number[],
  programs: number,
): BenchMetrics {
  let texels = 0;
  for (const t of shadowTexels) texels += t;
  return {
    sceneSubmissions: f.totals.sceneSubmissions,
    gpuDraws: f.totals.gpuDraws,
    triangles: f.totals.triangles,
    programs,
    overdrawOpaque: f.overdraw.opaque,
    overdrawTransparent: f.overdraw.transparent,
    skinnedVertices: f.skinning.vertices,
    shadowCasters: f.lighting.shadowCasters,
    shadowTexels: Math.round(texels / Math.max(1, shadowTexels.length)),
    textureBytes: f.memory.textures.bytes,
    geometryBytes: f.memory.geometries.bytes,
    renderTargetBytes: f.memory.renderTargets.bytes,
    particles: f.overdraw.particles,
    fillMegapixels: Number((((f.overdraw.opaque + f.overdraw.transparent) * f.overdraw.pixels) / 1e6).toFixed(3)),
    objects: f.js.objects,
    autoUpdatedMatrices: f.js.autoUpdatedMatrices,
    shadowPassesPerFrame: Number(shadowPassesPerFrame.toFixed(3)),
    renderMs,
    frameMs,
    unattributed: f.totals.unattributed,
  };
}
