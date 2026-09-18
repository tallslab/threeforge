import { type Object3D, PerspectiveCamera, REVISION } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import {
  collectResources,
  createLoader,
  DrawCallLedger,
  detectTier,
  gpuName,
  isSharedSpriteGeometry,
  MaterialRegistry,
  type Tier,
  tierInputFromNavigator,
  World,
} from 'threeforge';
import { type BenchMetrics, metricsOf, type SceneId, WARM } from '../test/app/benchMetrics.js';
import { BENCH_SCENES } from '../test/app/scenes/index.js';
import { probeFillRate } from './probe.js';
import { type Backend, type DeviceEnv, type DeviceResult, normalizeEnvString, resultId } from './submit.js';

export interface RunOptions {
  sceneIds: SceneId[];
  /** Measured frames per variant (60 for a submission; the e2e uses fewer). */
  measured: number;
  probe: boolean;
  onProgress(text: string): void;
  onScene(id: SceneId, variant: 'naive' | 'optimized', metrics: BenchMetrics): void;
}

export interface Host {
  renderer: WebGPURenderer;
  canvas: HTMLCanvasElement;
  backend: Backend;
  gpu: string;
  multiDraw: boolean;
  tier: Tier;
}

/** Paths under the page's own directory (GitHub Pages serves the site under /<repo>/). */
const url = (p: string): string => new URL(p.replace(/^\//, ''), document.baseURI).href;

/** WebGPU when available (or asked for), else WebGL2; each attempt gets its own canvas (one context type per canvas). */
export async function createHost(want: Backend | 'auto', mount: HTMLElement): Promise<Host> {
  const attempts: Backend[] = want === 'webgl2' ? ['webgl2'] : want === 'webgpu' ? ['webgpu'] : ['webgpu', 'webgl2'];
  let lastError: unknown = null;
  for (const backend of attempts) {
    if (backend === 'webgpu' && !('gpu' in navigator)) {
      lastError = new Error('navigator.gpu is not available');
      continue;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    try {
      const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL: backend === 'webgl2' });
      await renderer.init();
      const actual: Backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
      if (actual !== backend) throw new Error(`asked for ${backend}, got ${actual}`);
      renderer.setPixelRatio(1);
      renderer.setSize(800, 600, false);
      mount.replaceChildren(canvas);
      const gpu = gpuName(renderer);
      const { hasFeature } = renderer.backend as { hasFeature?: (n: string) => boolean };
      const multiDraw =
        backend === 'webgl2' && typeof hasFeature === 'function'
          ? hasFeature.call(renderer.backend, 'WEBGL_multi_draw')
          : false;
      const tier = detectTier(tierInputFromNavigator(gpu, navigator));
      return { renderer, canvas, backend, gpu, multiDraw, tier };
    } catch (error) {
      lastError = error;
      canvas.remove();
    }
  }
  throw new Error(`no usable backend: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Frees every geometry, material and texture reachable from a finished scene, its environment included (phones have little GPU memory). */
function disposeScene(root: Object3D): void {
  const { geometries, materials, textures } = collectResources(root);
  for (const g of geometries) if (!isSharedSpriteGeometry(g)) g.dispose();
  for (const m of materials) m.dispose();
  for (const t of textures) t.dispose();
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
};

/** One scene, one variant: build, (optimized: prepare, compile, after, warmup), warm frames, measured frames, overdraw. */
async function runOne(
  host: Host,
  id: SceneId,
  variant: 'naive' | 'optimized',
  measured: number,
  onProgress: (t: string) => void,
): Promise<BenchMetrics> {
  const { renderer } = host;
  const registry = new MaterialRegistry();
  const ledger = new DrawCallLedger({ registry });
  ledger.attach(renderer);
  const camera = new PerspectiveCamera(60, 800 / 600, 0.1, 1000);
  camera.position.set(0, 110, 150);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const bench = await BENCH_SCENES[id]!({
    renderer,
    camera,
    params: new URLSearchParams(),
    loader: () => createLoader(renderer, { decoders: url('_decoders/') }),
    url,
    tier: host.tier,
  });
  const width = bench.portrait ? 450 : 800;
  const height = bench.portrait ? 800 : 600;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  ledger.setEnvironment({ tier: host.tier, gpu: host.gpu, dpr: 1, viewport: [width, height] });
  const scene = bench.scene;
  const world = new World(scene, {
    registry,
    ledger,
    policy: 'tagged',
    animations: bench.animations ?? [],
    ...(bench.worldOptions ?? {}),
  });
  try {
    if (variant === 'optimized') {
      await bench.prepare?.(scene);
      world.compile({ coordinateSystem: renderer.coordinateSystem });
      await bench.after?.(world);
      await world.warmup(renderer, camera);
    }
    const frameAsync = async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      renderer.render(scene, camera);
      return ledger.frame();
    };
    // Tracked as the frames run so it can be read before measureOverdraw() below: the count materials' shader stages
    // stay counted in renderer.info.memory.programs, so the final frame would report the diagnostic's shaders too.
    let programs = 0;
    for (let i = 0; i < WARM; i++) {
      bench.setTime?.(i / 60);
      programs = (await frameAsync()).totals.programs;
    }
    const render: number[] = [];
    const frames: number[] = [];
    const shadowPasses: number[] = [];
    const shadowTexels: number[] = [];
    let last = performance.now();
    for (let i = 0; i < measured; i++) {
      bench.setTime?.((WARM + i) / 60);
      const f = await frameAsync();
      const now = performance.now();
      programs = f.totals.programs;
      render.push(f.js.renderMs);
      frames.push(now - last);
      shadowPasses.push(f.lighting.shadowPasses);
      shadowTexels.push(f.lighting.shadowTexels);
      last = now;
      if (i % 10 === 0) onProgress(`${id} ${variant} · frame ${i + 1}/${measured}`);
    }
    const overdraw = await ledger.measureOverdraw(scene, camera);
    ledger.rescan();
    const frame = await frameAsync();
    return metricsOf(
      { ...frame, overdraw: { ...frame.overdraw, ...overdraw, measured: true } },
      median(render),
      median(frames),
      shadowPasses.reduce((a, b) => a + b, 0) / Math.max(1, shadowPasses.length),
      shadowTexels,
      programs,
    );
  } finally {
    world.decompile();
    disposeScene(scene);
    ledger.detach();
    renderer.setSize(800, 600, false);
  }
}

/** three's uncaptured-error report (`Renderer.onError`, r186); the typings still declare a string. */
type GpuErrorHandler = (info: { type: string; message: string }) => void;

/**
 * Every requested scene in both variants, one at a time; the result is what the page submits. An uncaptured GPU
 * error (a validation error, out of memory) fails the run: the device dropped work, so the frames it timed and the
 * counts it reports are not a measurement.
 */
export async function runBench(host: Host, options: RunOptions): Promise<DeviceResult> {
  const renderer = host.renderer as unknown as { onError: GpuErrorHandler };
  const report = renderer.onError;
  const gpuErrors: string[] = [];
  renderer.onError = (info) => {
    gpuErrors.push(`${info.type}: ${info.message}`);
    report.call(renderer, info);
  };
  const scenes = {} as DeviceResult['scenes'];
  let fillRateGPix: number | null = null;
  try {
    fillRateGPix = options.probe ? await probeFillRate(host.renderer) : null;
    let n = 0;
    for (const id of options.sceneIds) {
      for (const variant of ['naive', 'optimized'] as const) {
        n++;
        options.onProgress(`scene ${n}/${options.sceneIds.length * 2} · ${id} ${variant} · loading`);
        const metrics = await runOne(host, id, variant, options.measured, options.onProgress);
        if (gpuErrors.length)
          throw new Error(`${gpuErrors.length} GPU errors by the end of ${id} ${variant}, first: ${gpuErrors[0]}`);
        (scenes[id] ??= {} as DeviceResult['scenes'][SceneId])[variant] = metrics;
        options.onScene(id, variant, metrics);
      }
    }
  } finally {
    renderer.onError = report;
  }
  // Normalized before anything reads it: the id (below) is hashed from these same fields, and the schema's
  // printable-ASCII charset would otherwise reject a real driver string outright (e.g. `NVIDIA® GeForce RTX™
  // 4080`, which WebGPU adapter info and UNMASKED_RENDERER_WEBGL both report with `®`/`™`).
  const env: DeviceEnv = {
    three: normalizeEnvString(REVISION),
    backend: host.backend,
    multiDraw: host.multiDraw,
    tier: host.tier,
    gpu: normalizeEnvString(host.gpu),
    dpr: devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    ua: normalizeEnvString(navigator.userAgent),
    platform: normalizeEnvString(
      (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
        navigator.platform ||
        'unknown',
    ),
    cores: navigator.hardwareConcurrency ?? null,
    deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
    fillRateGPix,
  };
  const now = new Date();
  return { schemaVersion: 1, kind: 'device', id: resultId(env, now), createdAt: now.toISOString(), env, scenes };
}
