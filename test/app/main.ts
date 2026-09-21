import * as THREE from 'three';
import {
  type BatchedMesh,
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  type OrthographicCamera,
  PerspectiveCamera,
  Raycaster,
  type Scene,
  Vector3,
} from 'three';
import * as THREE_WEBGPU from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import {
  type AnimatedInstances,
  type AssembledCharacter,
  bakeGeometries,
  type CompileReport,
  createLoader,
  DrawCallLedger,
  detectTier,
  exposeToAgents,
  type FrameSnapshot,
  gpuName,
  lodsOf,
  MaterialRegistry,
  ParticleBudget,
  type ParticleBudgetReport,
  prepareLods,
  RenderScheduler,
  ResolutionScaler,
  ResourceTracker,
  ShadowBudget,
  type ShadowBudgetReport,
  Streamer,
  type Tier,
  tag,
  tierInputFromNavigator,
  World,
} from 'threeforge';
import { createOverlay } from 'threeforge/overlay';
import type { CharacterParts } from '../scenes/character.js';
import type { FieldScene } from '../scenes/field.js';
import type { NaiveScene } from '../scenes/naive.js';
import type { Arena } from './arena.js';
import type { Biome } from './biome.js';
import { trackDeviceLoss } from './harness/deviceLoss.js';
import { type BackendName, createFrameProbes, type RenderOnceResult } from './harness/frames.js';
import { createMemoryHarness, type MemoryHarness } from './harness/memory.js';
import { type SpikeResult, spikeSceneOptimizer } from './harness/spike.js';
import type { GltfInfo } from './scenes/gltf.js';
import { BENCH_SCENES, SCENES } from './scenes/index.js';

export type { BackendName, RenderOnceResult } from './harness/frames.js';
export type { MemoryHarness } from './harness/memory.js';
export type { SpikeResult, SpikeRun } from './harness/spike.js';
export type { GltfInfo } from './scenes/gltf.js';

export interface ForgeHarness {
  /** The three namespace, for in-page probes from Playwright. */
  three: typeof THREE;
  /** The bake's direct API (no World), for in-page parity probes. */
  bakeGeometries: typeof bakeGeometries;
  /** LOD generation and lookup, for specs that build their own content under `?lod=1`. */
  prepareLods: typeof prepareLods;
  lodsOf: typeof lodsOf;
  /** The Streamer class, for specs that stream content they build in the page. */
  Streamer: typeof Streamer;
  /** The ResourceTracker class, for specs that release what they build in the page. */
  ResourceTracker: typeof ResourceTracker;
  /** The three/webgpu namespace (node materials, `TSL`), for in-page probes. */
  webgpu: typeof THREE_WEBGPU;
  ready: boolean;
  error?: string;
  backend: BackendName;
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGPURenderer;
  registry: MaterialRegistry;
  ledger: DrawCallLedger;
  world: World;
  naive?: NaiveScene;
  field?: FieldScene;
  character?: CharacterParts;
  assembled?: AssembledCharacter;
  /** Loaded glTF asset summary when `scene=gltf&asset=<name>`. */
  gltf?: GltfInfo;
  /** Benchmark scene facts and deterministic time when `scene=<bench id>`. */
  bench?: { counts: Record<string, number>; variant: 'naive' | 'optimized'; setTime?(t: number): void };
  biome?: Biome;
  arena?: Arena;
  /** `?particles=1`: the ParticleBudget report for the detected (or forced) tier. */
  particleReport?: ParticleBudgetReport;
  /** `?scale=<s>`: a ResolutionScaler set to that scale (its base is the harness pixel ratio 1). */
  scaler?: ResolutionScaler;
  /** `?scheduler=1`: frame() ticks this RenderScheduler instead of rendering unconditionally. */
  scheduler?: RenderScheduler;
  /** `?shadowBudget=1`: the ShadowBudget report for the detected (or forced) tier. */
  shadowReport?: ShadowBudgetReport;
  /** `?freeze-shadow=1` (naive scene with shadows): the naive sun's shadow is frozen; call this to re-render it once. */
  refreshShadow?(): void;
  /** `scene=vat`: the animated-instances twin of the loaded character (`vatClip`, `vatTime`, `vatPartOffset` params). */
  vat?: AnimatedInstances;
  /** The optimized zen variant's chunk streamer (attached to the ledger). */
  streamer?: Streamer;
  memory: MemoryHarness;
  /** Pose animations and effects at time t (arena, bench scenes). */
  setTime(t: number): void;
  compile(): CompileReport;
  decompile(): void;
  /** Two low-resolution count renders: fragments per pixel, opaque and transparent. */
  measureOverdraw(cam?: PerspectiveCamera | OrthographicCamera): Promise<{ opaque: number; transparent: number }>;
  /** Cast a ray straight down from above (x, z) and resolve the hit through the world. */
  raycastDown(x: number, z: number): { hitCount: number; hitIsBatch: boolean; resolvedName: string | null };
  renderOnce(): RenderOnceResult;
  /** Render once and return the ledger's frame snapshot (with items when asked). */
  frame(options?: { items?: boolean }): FrameSnapshot;
  /**
   * Like `frame()` but after yielding to an animation frame first: three advances its node frameId only on
   * animation-frame ticks, and shadow maps render at most once per frameId, so several `frame()` calls inside one
   * task only show shadow passes on the first.
   */
  frameAsync(options?: { items?: boolean }): Promise<FrameSnapshot>;
  /** Meshes whose bounding sphere intersects the camera frustum (the same test the renderer applies). */
  visibleMeshes(): number;
  /** Spike: run three's experimental SceneOptimizer on a fresh naive scene and measure it. */
  spikeSceneOptimizer(): Promise<SpikeResult>;
  /**
   * The message of the WebGPU device loss three reported (`renderer.onDeviceLost`), or null. Waits up to `waitMs` for a
   * loss already under way. The SwiftShader adapter drops the device between test steps; every later frame is empty.
   */
  deviceLost(waitMs?: number): Promise<string | null>;
  /**
   * When that loss was recorded and when threeforge's first `compile()` started, both as `performance.now()`.
   * `lostAtIsUpperBound`: three's `onDeviceLost` never fired, so the loss happened at or before `lostAt`. Lets a skip
   * on device loss tell a loss before threeforge compiled anything (the environment) from one after.
   */
  deviceLostTiming(): { lostAt: number | null; lostAtIsUpperBound: boolean; compileStartedAt: number | null };
}

declare global {
  interface Window {
    __forge: ForgeHarness;
  }
}

const params = new URLSearchParams(location.search);
const requestedBackend: BackendName = params.get('backend') === 'webgpu' ? 'webgpu' : 'webgl2';
const sceneName = params.get('scene') ?? 'empty';
const seed = Number(params.get('seed') ?? '1');

try {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL: requestedBackend === 'webgl2' });
  await renderer.init();
  const deviceLoss = trackDeviceLoss(renderer);
  renderer.setPixelRatio(1);
  renderer.setSize(800, 600, false);

  const registry = new MaterialRegistry();
  const ledger = new DrawCallLedger({ registry });
  ledger.attach(renderer);

  const backend: BackendName = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? 'webgpu'
    : 'webgl2';
  const gpu = gpuName(renderer);
  const tier = (params.get('tier') as Tier | null) ?? detectTier(tierInputFromNavigator(gpu, navigator));
  ledger.setEnvironment({ tier, gpu, dpr: renderer.getPixelRatio(), viewport: [800, 600] });
  const hasFeature = (renderer.backend as { hasFeature?: (name: string) => boolean }).hasFeature;
  const multiDraw =
    backend === 'webgl2' && typeof hasFeature === 'function'
      ? hasFeature.call(renderer.backend, 'WEBGL_multi_draw')
      : false;

  const camera = new PerspectiveCamera(60, 800 / 600, 0.1, 1000);
  // Far enough back that the whole 120-unit prop field is inside the frustum: the naive number is then one draw per mesh.
  camera.position.set(0, 110, 150);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  if (params.get('freeze') === '1') {
    // Freeze the clock so time-driven TSL materials (water) render identically across frames.
    const frozen = performance.now();
    performance.now = () => frozen;
  }

  const build = SCENES[sceneName];
  if (!build) throw new Error(`unknown scene "${sceneName}"`);
  const built = await build({
    renderer,
    camera,
    params,
    loader: () => createLoader(renderer, { decoders: '/_decoders/' }),
    url: (p) => `/${p.replace(/^\//, '')}`,
    tier,
  });
  const { scene, naive } = built;
  const bench = BENCH_SCENES[sceneName] ? built : undefined;
  if (built.portrait) {
    renderer.setSize(450, 800, false);
    camera.aspect = 450 / 800;
    camera.updateProjectionMatrix();
    ledger.setEnvironment({ viewport: [450, 800] });
  }

  if (params.get('sceneOffset') === '1') {
    // The whole scene translated, turned and scaled; the camera follows (position and a point ahead of it go through
    // the same matrix, and a perspective view does not change under a uniform scale), so the same view stays framed.
    const ahead = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).add(camera.position);
    scene.position.set(40, -12, -30);
    scene.rotation.y = 0.5;
    scene.scale.setScalar(0.8);
    scene.updateMatrixWorld(true);
    camera.position.applyMatrix4(scene.matrix);
    camera.lookAt(ahead.applyMatrix4(scene.matrix));
    camera.updateMatrixWorld();
  }

  const memory = createMemoryHarness({ renderer, scene, ledger, registry });
  const probes = createFrameProbes({ renderer, scene, camera, ledger, backend, multiDraw });

  const useLod = params.get('lod') === '1';
  if (useLod) await prepareLods(scene, { ratios: [0.5, 0.2] });
  if (params.get('wall') === '1') {
    // A tall opaque wall between the camera and the left half of the naive field: an occluder for chunk proxies.
    const wall = new Mesh(
      new BoxGeometry(220, 220, 2),
      new MeshStandardMaterial({ color: 0x555a60, roughness: 1, metalness: 0 }),
    );
    wall.name = 'wall';
    wall.position.set(-110, 110, 80);
    tag.static(wall);
    scene.add(wall);
  }
  const nested = params.get('nested');
  const world = new World(scene, {
    registry,
    ledger,
    policy: (params.get('policy') ?? built.policy ?? 'tagged') as 'auto' | 'tagged',
    animations: built.animations ?? [],
    dynamics: params.get('dynamics') === 'batch-sync' ? 'batch-sync' : 'separate',
    ...(useLod
      ? { lod: { distances: [Number(params.get('lod0') ?? '200'), Number(params.get('lod1') ?? '600')] } }
      : {}),
    ...(params.has('chunk') ? { chunkSize: Number(params.get('chunk')) } : {}),
    ...(params.get('culling') === 'linear' ? { culling: 'linear' as const } : {}),
    ...(params.has('threshold') ? { instanceThreshold: Number(params.get('threshold')) } : {}),
    occlusion: params.get('occlusion') === '1',
    ...(params.get('materials') === 'keep' ? { materials: 'keep' as const } : {}),
    ...(nested === 'per-pass' || nested === 'reuse-main' ? { nestedPasses: nested } : {}),
    ...(params.has('bake') ? { bake: params.get('bake') === 'buried' ? { removeBuried: true } : true } : {}),
    ...(params.get('sprites') === 'keep' ? { sprites: 'keep' as const } : {}),
    ...(params.get('transparent') === 'keep' ? { transparent: 'keep' as const } : {}),
    ...(params.get('freeze') === '0' ? { freeze: false } : {}),
    ...(params.get('originals') === 'detach' ? { originals: 'detach' as const } : {}),
    ...(built.worldOptions ?? {}),
  });
  const compile = (): CompileReport => {
    deviceLoss.markCompileStart();
    const report = world.compile({ coordinateSystem: renderer.coordinateSystem });
    if (params.get('nocull') === '1') {
      // Diagnostic: identical instance lists in every pass (no per-instance culling or sorting).
      for (const b of world.batchedMeshes) {
        b.perObjectFrustumCulled = false;
        b.sortObjects = false;
      }
    }
    return report;
  };
  // The standard agent hook (`npx threeforge inspect <url>` drives it); the harness keeps its own __forge too.
  exposeToAgents({ ledger, world, renderer, scene, camera });
  if (params.get('compile') === '1') compile();
  const variant: 'naive' | 'optimized' = params.get('variant') === 'optimized' ? 'optimized' : 'naive';
  if (bench && variant === 'optimized') {
    await bench.prepare?.(scene);
    compile();
    await bench.after?.(world);
    if (bench.streamer) ledger.attachStreamer(bench.streamer);
    await world.warmup(renderer, camera);
  }
  if (params.get('overlay') === '1') {
    createOverlay(ledger, { budget: params.has('budget') ? Number(params.get('budget')) : undefined });
  }
  let particleReport: ParticleBudgetReport | undefined;
  if (params.get('particles') === '1') particleReport = new ParticleBudget({ tier }).apply(scene);
  let shadowReport: ShadowBudgetReport | undefined;
  if (params.get('shadowBudget') === '1') shadowReport = new ShadowBudget({ tier }).apply(scene);
  let refreshShadow: (() => void) | undefined;
  if (params.get('freeze-shadow') === '1' && naive) refreshShadow = ShadowBudget.freeze(naive.lights.directional);
  let scaler: ResolutionScaler | undefined;
  if (params.has('scale')) {
    scaler = new ResolutionScaler(renderer, { tier, ledger });
    scaler.set(Number(params.get('scale')));
  }

  function raycastDown(x: number, z: number): { hitCount: number; hitIsBatch: boolean; resolvedName: string | null } {
    const raycaster = new Raycaster(new Vector3(x, 60, z), new Vector3(0, -1, 0));
    const hits = raycaster.intersectObjects(scene.children, true);
    const hit = hits[0];
    return {
      hitCount: hits.length,
      hitIsBatch: Boolean(hit && (hit.object as BatchedMesh).isBatchedMesh),
      resolvedName: hit ? world.resolve(hit).name : null,
    };
  }

  function setTime(t: number): void {
    built.setTime?.(t);
    // Torch billboards (arena, bossfight) face the camera.
    scene.traverse((o) => {
      if (o.name.startsWith('torch-')) o.lookAt(camera.position);
    });
  }

  // Optional bloom post-processing: the scene becomes a nested pass under a fullscreen quad.
  let postProcessing: { render(): void } | null = null;
  if (params.get('bloom') === '1') {
    const [{ PostProcessing }, { pass }, { bloom }] = await Promise.all([
      import('three/webgpu'),
      import('three/tsl'),
      import('three/addons/tsl/display/BloomNode.js'),
    ]);
    const scenePass = pass(scene, camera);
    const post = new PostProcessing(renderer);
    post.outputNode = scenePass.add(bloom(scenePass, 0.6, 0.4, 0.85));
    postProcessing = post;
  }

  const scheduler =
    params.get('scheduler') === '1' ? new RenderScheduler({ renderer, scene, camera, ledger, world }) : undefined;
  function frame(options?: { items?: boolean }): FrameSnapshot {
    if (scheduler) scheduler.tick(performance.now());
    else if (postProcessing) postProcessing.render();
    else renderer.render(scene, camera);
    return ledger.frame(options);
  }
  async function frameAsync(options?: { items?: boolean }): Promise<FrameSnapshot> {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    return frame(options);
  }

  if (params.get('animate') === '1') {
    renderer.setAnimationLoop(() => {
      built.animate?.();
      renderer.render(scene, camera);
    });
  }

  window.__forge = {
    three: THREE,
    bakeGeometries,
    prepareLods,
    lodsOf,
    Streamer,
    ResourceTracker,
    webgpu: THREE_WEBGPU,
    ready: true,
    backend,
    scene,
    camera,
    renderer,
    registry,
    ledger,
    world,
    naive,
    field: built.field,
    character: built.character,
    assembled: built.assembled,
    gltf: built.gltf,
    biome: built.biome,
    arena: built.arena,
    bench: bench ? { counts: bench.counts, variant, setTime: bench.setTime } : undefined,
    particleReport,
    scaler,
    scheduler,
    shadowReport,
    refreshShadow,
    vat: built.vat,
    streamer: bench?.streamer,
    memory,
    setTime,
    compile,
    decompile: () => world.decompile(),
    measureOverdraw: (cam) => ledger.measureOverdraw(scene, cam ?? camera),
    raycastDown,
    renderOnce: probes.renderOnce,
    frame,
    frameAsync,
    visibleMeshes: probes.visibleMeshes,
    spikeSceneOptimizer: () => spikeSceneOptimizer({ renderer, camera, seed, countVisible: probes.countVisible }),
    deviceLost: deviceLoss.deviceLost,
    deviceLostTiming: deviceLoss.deviceLostTiming,
  };
} catch (error) {
  window.__forge = {
    ready: false,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  } as ForgeHarness;
  throw error;
}
