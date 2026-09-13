import { AmbientLight, AnimationMixer, BatchedMesh, Box3, BoxGeometry, Color, DirectionalLight, Frustum, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster, Scene, SkinnedMesh, Sphere, Vector3, type AnimationClip, type Object3D, type OrthographicCamera } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import * as THREE from 'three';
import { DrawCallLedger, MaterialRegistry, World, assembleCharacter, detectTier, prepareLods, tag, type AssembledCharacter, type CompileReport, type FrameSnapshot, type Tier } from 'threeforge';
import { createOverlay } from 'threeforge/overlay';
import { BENCH_SCENES, type BenchScene } from './scenes/index.js';
import { buildNaiveScene, type NaiveScene } from '../scenes/naive.js';
import { buildFieldScene, type FieldScene } from '../scenes/field.js';
import { buildCharacter, type CharacterParts } from '../scenes/character.js';
import { buildBiome, type Biome } from './biome.js';
import { buildArena, type Arena } from './arena.js';

export type BackendName = 'webgl2' | 'webgpu';

export interface RenderOnceResult {
  backend: BackendName;
  multiDraw: boolean;
  drawCalls: number;
}

export interface SpikeRun {
  drawsAfter: number;
  batchedMeshes: number;
  plainMeshes: number;
  skinnedSurvived: number;
  visibleAfter: number;
}

export interface SpikeResult {
  drawsBefore: number;
  visibleBefore: number;
  /** Error thrown by SceneOptimizer on the scene as authored, or null if it ran. */
  asIsError: string | null;
  asIs: SpikeRun | null;
  /** Same run after giving the non-indexed polyhedra a trivial index (the pre-pass SceneOptimizer lacks). */
  indexed: SpikeRun;
}

export interface GltfInfo {
  name: string;
  meshes: number;
  materials: number;
  vertices: number;
  triangles: number;
  animations: number;
  skinned: number;
  morph: number;
  instanced: number;
  linesPoints: number;
  radius: number;
  loadMs: number;
  clips: string[];
  bones: number;
}

export interface ForgeHarness {
  /** The three namespace, for in-page probes from Playwright. */
  three: typeof THREE;
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
  /** Pose animations and effects at time t (arena). */
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
   * Like `frame()` but after yielding to an animation frame first. three advances its node frameId only on
   * animation-frame ticks, and shadow maps (and other once-per-frame passes) render at most once per frameId,
   * so several `frame()` calls inside one task only show shadow passes on the first.
   */
  frameAsync(options?: { items?: boolean }): Promise<FrameSnapshot>;
  /** Meshes whose bounding sphere intersects the camera frustum (the same test the renderer applies). */
  visibleMeshes(): number;
  /** Task 2 spike: run three's experimental SceneOptimizer on a fresh naive scene and measure it. */
  spikeSceneOptimizer(): Promise<SpikeResult>;
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
  renderer.setPixelRatio(1);
  renderer.setSize(800, 600, false);

  const registry = new MaterialRegistry();
  const ledger = new DrawCallLedger({ registry });
  ledger.attach(renderer);

  const backend: BackendName = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  // Describe the device for the snapshot's env: adapter info on WebGPU, the unmasked renderer string on WebGL.
  const gpuName = (): string => {
    type AdapterInfo = { description?: string; device?: string; vendor?: string; architecture?: string };
    const b = renderer.backend as { isWebGPUBackend?: boolean; device?: { adapterInfo?: AdapterInfo }; gl?: WebGL2RenderingContext };
    if (b.isWebGPUBackend) {
      // three keeps only the device; Chrome exposes the adapter's info on it.
      const info = b.device?.adapterInfo;
      return info?.description || info?.device || [info?.vendor, info?.architecture].filter(Boolean).join(' ') || 'webgpu';
    }
    const gl = b.gl;
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'webgl2';
  };
  const gpu = gpuName();
  const tier = (params.get('tier') as Tier | null) ?? detectTier({ gpu, touch: navigator.maxTouchPoints > 0, deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory, cores: navigator.hardwareConcurrency, dpr: devicePixelRatio });
  ledger.setEnvironment({ tier, gpu, dpr: renderer.getPixelRatio(), viewport: [800, 600] });
  const hasFeature = (renderer.backend as { hasFeature?: (name: string) => boolean }).hasFeature;
  const multiDraw = backend === 'webgl2' && typeof hasFeature === 'function' ? hasFeature.call(renderer.backend, 'WEBGL_multi_draw') : false;

  const camera = new PerspectiveCamera(60, 800 / 600, 0.1, 1000);
  // Far enough back that the whole 120-unit prop field is inside the frustum: the naive number is then one draw per mesh.
  camera.position.set(0, 110, 150);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  let scene: Scene;
  let naive: NaiveScene | undefined;
  let field: FieldScene | undefined;
  let character: CharacterParts | undefined;
  let assembled: AssembledCharacter | undefined;
  let gltfInfo: GltfInfo | undefined;
  let biome: Biome | undefined;
  let arena: Arena | undefined;
  let bench: BenchScene | undefined;
  const benchBuilder = BENCH_SCENES[sceneName];
  let clips: AnimationClip[] = [];
  let animationSources: Array<AnimationClip | { root: Object3D; clips: AnimationClip[] }> = [];
  if (params.get('freeze') === '1') {
    // Freeze the clock so time-driven TSL materials (water) render identically across frames.
    const frozen = performance.now();
    performance.now = () => frozen;
  }
  const makeLoader = async () => {
    const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/loaders/DRACOLoader.js'),
      import('three/addons/loaders/KTX2Loader.js'),
      import('meshoptimizer/decoder'),
    ]);
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/_decoders/draco/');
    loader.setDRACOLoader(draco);
    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath('/_decoders/basis/');
    await ktx2.detectSupportAsync(renderer);
    loader.setKTX2Loader(ktx2);
    loader.setMeshoptDecoder(MeshoptDecoder);
    return loader;
  };
  if (benchBuilder) {
    bench = await benchBuilder({ renderer, camera, params, loader: makeLoader });
    scene = bench.scene;
    animationSources = bench.animations ?? [];
    if (bench.portrait) {
      renderer.setSize(450, 800, false);
      camera.aspect = 450 / 800;
      camera.updateProjectionMatrix();
      ledger.setEnvironment({ viewport: [450, 800] });
    }
  } else if (sceneName === 'arena') {
    const [{ RoomEnvironment }, { PMREMGenerator }] = await Promise.all([import('three/addons/environments/RoomEnvironment.js'), import('three/webgpu')]);
    const loader = await makeLoader();
    if (params.get('shadows') !== '0') renderer.shadowMap.enabled = true;
    arena = await buildArena({
      loader,
      fighters: Number(params.get('fighters') ?? '12'),
      blocky: Number(params.get('blocky') ?? '16'),
      vfx: params.get('vfx') !== '0',
      shadows: params.get('shadows') !== '0',
      assemble: params.get('assemble') === '1',
    });
    scene = arena.scene;
    animationSources = arena.animations;
    if (params.get('env') !== '0') {
      const pmrem = new PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.15;
    }
    camera.near = 0.5;
    camera.far = 400;
    camera.position.set(-38, 34, 58);
    camera.lookAt(0, 3, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    arena.setTime(Number(params.get('t') ?? '1'));
  } else if (sceneName === 'biome') {
    const [{ RoomEnvironment }, { PMREMGenerator }] = await Promise.all([import('three/addons/environments/RoomEnvironment.js'), import('three/webgpu')]);
    const loader = await makeLoader();
    biome = await buildBiome({ loader, density: Number(params.get('density') ?? '1'), water: params.get('water') !== '0', hiPoly: params.get('hipoly') !== '0' });
    scene = biome.scene;
    const pmrem = new PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    camera.near = 2;
    camera.far = 2500;
    camera.position.set(-140, 150, 420);
    camera.lookAt(60, 10, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  } else if (sceneName === 'gltf') {
    const assetName = params.get('asset') ?? params.get('url') ?? '';
    const lists = await Promise.all(
      ['/index.json', '/kits-index.json'].map((u) => fetch(u).then((r) => (r.ok ? r.json() : [])).catch(() => [])),
    );
    // Either a named asset from the index, or any served file via ?url=<path under test/assets/files>.
    const entry = params.has('url')
      ? { name: assetName, entry: params.get('url')!.replace(/^\//, '') }
      : (lists.flat() as Array<{ name: string; entry?: string; error?: string }>).find((a) => a.name === assetName);
    if (!entry?.entry) throw new Error(`asset "${assetName}" not found in test/assets/files (run pnpm assets)`);
    const [{ RoomEnvironment }, { PMREMGenerator }] = await Promise.all([import('three/addons/environments/RoomEnvironment.js'), import('three/webgpu')]);
    const loader = await makeLoader();
    const t0 = performance.now();
    const gltf = await loader.loadAsync('/' + entry.entry);
    const loadMs = performance.now() - t0;
    scene = new Scene();
    scene.background = new Color(0x202830);
    scene.add(gltf.scene);
    const pmrem = new PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const key = new DirectionalLight(0xffffff, 1.5);
    key.position.set(1, 2, 1.5);
    scene.add(new AmbientLight(0xffffff, 0.2), key);
    clips = gltf.animations;
    if (clips.length > 0) {
      const mixer = new AnimationMixer(gltf.scene);
      for (const clip of clips) mixer.clipAction(clip).play();
      mixer.setTime(0.7); // a deterministic mid-animation pose
    }
    scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(gltf.scene);
    const sphere = box.getBoundingSphere(new Sphere());
    const radius = Math.max(sphere.radius, 1e-3);
    camera.near = radius / 100;
    camera.far = radius * 50;
    camera.position.copy(sphere.center).add(new Vector3(0.7, 0.45, 1).normalize().multiplyScalar((radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05));
    camera.lookAt(sphere.center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    let meshes = 0;
    let vertices = 0;
    let triangles = 0;
    let skinned = 0;
    let morph = 0;
    let instanced = 0;
    let linesPoints = 0;
    const materials = new Set<unknown>();
    gltf.scene.traverse((o) => {
      const m = o as Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean; isLine?: boolean; isPoints?: boolean };
      if (m.isLine || m.isPoints) linesPoints++;
      if (!m.isMesh) return;
      meshes++;
      if (m.isSkinnedMesh) skinned++;
      if (m.morphTargetInfluences?.length) morph++;
      if (m.isInstancedMesh) instanced++;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) materials.add(mat);
      const g = m.geometry;
      vertices += g.attributes.position?.count ?? 0;
      triangles += (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
    });
    let bones = 0;
    gltf.scene.traverse((o) => {
      if ((o as { isBone?: boolean }).isBone) bones++;
    });
    gltfInfo = { name: assetName, meshes, materials: materials.size, vertices, triangles: Math.round(triangles), animations: clips.length, skinned, morph, instanced, linesPoints, radius, loadMs: Math.round(loadMs), clips: clips.map((c) => c.name), bones };
  } else if (sceneName === 'character') {
    scene = new Scene();
    scene.background = new Color(0x202830);
    character = buildCharacter();
    if (params.get('assemble') === '1') {
      assembled = assembleCharacter({ skeleton: character.skeleton, wardrobe: [character.body, ...character.gear], equipped: [character.body, ...character.gear], atlas: { size: 256 } });
      scene.add(assembled.mesh);
    } else {
      scene.add(character.body, ...character.gear);
    }
    const { AmbientLight, DirectionalLight } = await import('three');
    const key = new DirectionalLight(0xffffff, 2.5);
    key.position.set(3, 5, 4);
    scene.add(new AmbientLight(0xffffff, 0.6), key);
    camera.position.set(0, 1.6, 4.5);
    camera.lookAt(0, 1.1, 0);
    camera.updateMatrixWorld();
  } else if (sceneName === 'field') {
    field = buildFieldScene({ count: Number(params.get('count') ?? '20000') });
    scene = field.scene;
    scene.background = new Color(0x202830);
    camera.position.set(0, 2, 0);
    camera.lookAt(100, 1, 0);
    camera.updateMatrixWorld();
  } else if (sceneName === 'empty') {
    scene = new Scene();
    scene.background = new Color(0x202830);
  } else if (sceneName === 'naive') {
    naive = buildNaiveScene(seed);
    scene = naive.scene;
    scene.background = new Color(0x202830);
  } else {
    throw new Error(`unknown scene "${sceneName}"`);
  }

  function renderOnce(): RenderOnceResult {
    // Delta inside one synchronous render() call: immune to info.autoReset running on three's own rAF.
    const before = renderer.info.render.drawCalls;
    renderer.render(scene, camera);
    return { backend, multiDraw, drawCalls: renderer.info.render.drawCalls - before };
  }

  const frustum = new Frustum();
  const projScreen = new Matrix4();
  function countVisible(target: Scene, cam: PerspectiveCamera): number {
    target.updateMatrixWorld(true);
    cam.updateMatrixWorld(true);
    projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen, renderer.coordinateSystem);
    let n = 0;
    target.traverse((o) => {
      if ((o as Mesh).isMesh && o.visible && (!o.frustumCulled || frustum.intersectsObject(o))) n++;
    });
    return n;
  }
  function visibleMeshes(): number {
    return countVisible(scene, camera);
  }

  async function spikeSceneOptimizer(): Promise<SpikeResult> {
    const { SceneOptimizer } = await import('three/addons/utils/SceneOptimizer.js');

    const measure = (target: Scene): number => {
      const before = renderer.info.render.drawCalls;
      renderer.render(target, camera);
      return renderer.info.render.drawCalls - before;
    };
    const summarise = (target: Scene): SpikeRun => {
      let batchedMeshes = 0;
      let plainMeshes = 0;
      let skinnedSurvived = 0;
      target.traverse((o) => {
        if ((o as BatchedMesh).isBatchedMesh) batchedMeshes++;
        else if ((o as SkinnedMesh).isSkinnedMesh) skinnedSurvived++;
        else if ((o as Mesh).isMesh) plainMeshes++;
      });
      return { drawsAfter: measure(target), batchedMeshes, plainMeshes, skinnedSurvived, visibleAfter: countVisible(target, camera) };
    };

    const asIsScene = buildNaiveScene(seed);
    asIsScene.scene.background = new Color(0x202830);
    const visibleBefore = countVisible(asIsScene.scene, camera);
    const drawsBefore = measure(asIsScene.scene);
    let asIsError: string | null = null;
    let asIs: SpikeRun | null = null;
    try {
      new SceneOptimizer(asIsScene.scene, { debug: true }).toBatchedMesh();
      asIs = summarise(asIsScene.scene);
    } catch (error) {
      asIsError = error instanceof Error ? error.message : String(error);
    }

    const indexedScene = buildNaiveScene(seed);
    indexedScene.scene.background = new Color(0x202830);
    for (const geometry of indexedScene.geometries) {
      if (geometry.index === null) geometry.setIndex([...Array(geometry.attributes.position!.count).keys()]);
    }
    new SceneOptimizer(indexedScene.scene, { debug: true }).toBatchedMesh();
    const indexed = summarise(indexedScene.scene);

    // Leave the harness scene on screen for the screenshot.
    renderer.render(indexedScene.scene, camera);
    return { drawsBefore, visibleBefore, asIsError, asIs, indexed };
  }

  if (params.get('shadows') === '1' && naive) {
    renderer.shadowMap.enabled = true;
    const sun = naive.lights.directional;
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const shadowCamera = sun.shadow.camera;
    shadowCamera.left = shadowCamera.bottom = -140;
    shadowCamera.right = shadowCamera.top = 140;
    shadowCamera.near = 1;
    shadowCamera.far = 400;
    shadowCamera.updateProjectionMatrix();
  }

  const useLod = params.get('lod') === '1';
  if (useLod) await prepareLods(scene, { ratios: [0.5, 0.2] });
  if (params.get('wall') === '1') {
    // A tall opaque wall between the camera and the left half of the naive field: an occluder for chunk proxies.
    const wall = new Mesh(new BoxGeometry(220, 220, 2), new MeshStandardMaterial({ color: 0x555a60, roughness: 1, metalness: 0 }));
    wall.name = 'wall';
    wall.position.set(-110, 110, 80);
    tag.static(wall);
    scene.add(wall);
  }
  const world = new World(scene, {
    registry,
    ledger,
    policy: (params.get('policy') ?? (sceneName === 'gltf' ? 'auto' : 'tagged')) as 'auto' | 'tagged',
    animations: animationSources.length > 0 ? animationSources : clips,
    dynamics: params.get('dynamics') === 'batch-sync' ? 'batch-sync' : 'separate',
    ...(useLod ? { lod: { distances: [Number(params.get('lod0') ?? '200'), Number(params.get('lod1') ?? '600')] } } : {}),
    ...(params.has('chunk') ? { chunkSize: Number(params.get('chunk')) } : {}),
    ...(params.get('culling') === 'linear' ? { culling: 'linear' as const } : {}),
    ...(params.has('threshold') ? { instanceThreshold: Number(params.get('threshold')) } : {}),
    occlusion: params.get('occlusion') === '1',
    ...(params.get('materials') === 'keep' ? { materials: 'keep' as const } : {}),
    ...(params.get('nested') === 'per-pass' ? { nestedPasses: 'per-pass' as const } : {}),
    ...(bench?.worldOptions ?? {}),
  });
  const compile = (): CompileReport => {
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
  const decompile = (): void => world.decompile();
  if (params.get('compile') === '1') compile();
  const variant: 'naive' | 'optimized' = params.get('variant') === 'optimized' ? 'optimized' : 'naive';
  if (bench && variant === 'optimized') {
    await bench.prepare?.(scene);
    compile();
    await bench.after?.(world);
    await world.warmup(renderer, camera);
  }
  if (params.get('overlay') === '1') {
    createOverlay(ledger, { budget: params.has('budget') ? Number(params.get('budget')) : undefined });
  }

  const measureOverdraw = (cam?: PerspectiveCamera | OrthographicCamera) => ledger.measureOverdraw(scene, cam ?? camera);

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
    arena?.setTime(t);
    bench?.setTime?.(t);
    // Torch billboards face the camera.
    scene.traverse((o) => {
      if (o.name.startsWith('torch-')) o.lookAt(camera.position);
    });
  }

  // Optional bloom post-processing: the scene becomes a nested pass under a fullscreen quad.
  let postProcessing: { render(): void } | null = null;
  if (params.get('bloom') === '1') {
    const [{ PostProcessing }, { pass }, { bloom }] = await Promise.all([import('three/webgpu'), import('three/tsl'), import('three/addons/tsl/display/BloomNode.js')]);
    const scenePass = pass(scene, camera);
    const post = new PostProcessing(renderer);
    post.outputNode = scenePass.add(bloom(scenePass, 0.6, 0.4, 0.85));
    postProcessing = post;
  }

  function frame(options?: { items?: boolean }): FrameSnapshot {
    if (postProcessing) postProcessing.render();
    else renderer.render(scene, camera);
    return ledger.frame(options);
  }
  async function frameAsync(options?: { items?: boolean }): Promise<FrameSnapshot> {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    return frame(options);
  }

  if (params.get('animate') === '1') {
    renderer.setAnimationLoop(() => {
      if (naive) for (const d of naive.dynamics) d.rotation.y += 0.02;
      if (biome) for (const car of biome.cars) car.position.x += Math.sin(car.rotation.y) * 0.3;
      renderer.render(scene, camera);
    });
  }

  window.__forge = { three: THREE, ready: true, backend, scene, camera, renderer, registry, ledger, world, naive, field, character, assembled, gltf: gltfInfo, biome, arena, bench: bench ? { counts: bench.counts, variant, setTime: bench.setTime } : undefined, setTime, compile, decompile, measureOverdraw, raycastDown, renderOnce, frame, frameAsync, visibleMeshes, spikeSceneOptimizer };
} catch (error) {
  window.__forge = { ready: false, error: error instanceof Error ? error.stack ?? error.message : String(error) } as ForgeHarness;
  throw error;
}
