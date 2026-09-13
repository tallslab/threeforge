import { BatchedMesh, Color, Frustum, Matrix4, Mesh, PerspectiveCamera, Raycaster, Scene, SkinnedMesh, Vector3 } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { DrawCallLedger, MaterialRegistry, World, prepareLods, type CompileReport, type FrameSnapshot } from 'threeforge';
import { createOverlay } from 'threeforge/overlay';
import { buildNaiveScene, type NaiveScene } from '../scenes/naive.js';
import { buildFieldScene, type FieldScene } from '../scenes/field.js';

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

export interface ForgeHarness {
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
  compile(): CompileReport;
  decompile(): void;
  /** Cast a ray straight down from above (x, z) and resolve the hit through the world. */
  raycastDown(x: number, z: number): { hitCount: number; hitIsBatch: boolean; resolvedName: string | null };
  renderOnce(): RenderOnceResult;
  /** Render once and return the ledger's frame snapshot (with items when asked). */
  frame(options?: { items?: boolean }): FrameSnapshot;
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
  if (sceneName === 'field') {
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
  const world = new World(scene, {
    registry,
    ledger,
    dynamics: params.get('dynamics') === 'batch-sync' ? 'batch-sync' : 'separate',
    ...(useLod ? { lod: { distances: [Number(params.get('lod0') ?? '200'), Number(params.get('lod1') ?? '600')] } } : {}),
  });
  const compile = (): CompileReport => world.compile({ coordinateSystem: renderer.coordinateSystem });
  const decompile = (): void => world.decompile();
  if (params.get('compile') === '1') compile();
  if (params.get('overlay') === '1') {
    createOverlay(ledger, { budget: params.has('budget') ? Number(params.get('budget')) : undefined });
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

  function frame(options?: { items?: boolean }): FrameSnapshot {
    renderer.render(scene, camera);
    return ledger.frame(options);
  }

  if (params.get('animate') === '1') {
    renderer.setAnimationLoop(() => {
      if (naive) for (const d of naive.dynamics) d.rotation.y += 0.02;
      renderer.render(scene, camera);
    });
  }

  window.__forge = { ready: true, backend, scene, camera, renderer, registry, ledger, world, naive, field, compile, decompile, raycastDown, renderOnce, frame, visibleMeshes, spikeSceneOptimizer };
} catch (error) {
  window.__forge = { ready: false, error: error instanceof Error ? error.stack ?? error.message : String(error) } as ForgeHarness;
  throw error;
}
