import { PerspectiveCamera, REVISION, type Material, type Mesh, type Object3D, type Texture } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { DrawCallLedger, MaterialRegistry, World, detectTier, type Tier } from 'threeforge';
import { BENCH_SCENES } from '../test/app/scenes/index.js';
import { MEASURED, metricsOf, WARM, type BenchMetrics, type SceneId } from '../test/app/benchMetrics.js';
import { probeFillRate } from './probe.js';
import { resultId, type Backend, type DeviceEnv, type DeviceResult } from './submit.js';

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
      const b = renderer.backend as { isWebGPUBackend?: boolean; device?: { adapterInfo?: { description?: string; device?: string; vendor?: string; architecture?: string } }; gl?: WebGL2RenderingContext; hasFeature?: (n: string) => boolean };
      let gpu: string = backend;
      if (b.isWebGPUBackend) {
        const info = b.device?.adapterInfo;
        gpu = info?.description || info?.device || [info?.vendor, info?.architecture].filter(Boolean).join(' ') || 'webgpu';
      } else if (b.gl) {
        const ext = b.gl.getExtension('WEBGL_debug_renderer_info');
        gpu = ext ? String(b.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'webgl2';
      }
      const multiDraw = backend === 'webgl2' && typeof b.hasFeature === 'function' ? b.hasFeature.call(renderer.backend, 'WEBGL_multi_draw') : false;
      const tier = detectTier({ gpu, touch: navigator.maxTouchPoints > 0, deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory, cores: navigator.hardwareConcurrency, dpr: devicePixelRatio });
      return { renderer, canvas, backend, gpu, multiDraw, tier };
    } catch (error) {
      lastError = error;
      canvas.remove();
    }
  }
  throw new Error(`no usable backend: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Frees every geometry, material and texture reachable from a finished scene (phones have little GPU memory). */
function disposeScene(root: Object3D): void {
  const textures = new Set<Texture>();
  const materials = new Set<Material>();
  root.traverse((o) => {
    const m = o as Partial<Mesh>;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) materials.add(mat);
  });
  for (const mat of materials) {
    for (const value of Object.values(mat as unknown as Record<string, unknown>)) if ((value as Texture | null)?.isTexture) textures.add(value as Texture);
    mat.dispose();
  }
  for (const t of textures) t.dispose();
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
};

async function makeLoader(renderer: WebGPURenderer) {
  const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/loaders/DRACOLoader.js'), import('three/addons/loaders/KTX2Loader.js'), import('meshoptimizer/decoder')]);
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(url('_decoders/draco/'));
  loader.setDRACOLoader(draco);
  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath(url('_decoders/basis/'));
  ktx2.detectSupport(renderer);
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/** One scene, one variant: build, (optimized: prepare, compile, after, warmup), warm frames, measured frames, overdraw. */
async function runOne(host: Host, id: SceneId, variant: 'naive' | 'optimized', measured: number, onProgress: (t: string) => void): Promise<BenchMetrics> {
  const { renderer } = host;
  const registry = new MaterialRegistry();
  const ledger = new DrawCallLedger({ registry });
  ledger.attach(renderer);
  const camera = new PerspectiveCamera(60, 800 / 600, 0.1, 1000);
  camera.position.set(0, 110, 150);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const bench = await BENCH_SCENES[id]!({ renderer, camera, params: new URLSearchParams(), loader: () => makeLoader(renderer), url, tier: host.tier });
  const width = bench.portrait ? 450 : 800;
  const height = bench.portrait ? 800 : 600;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  ledger.setEnvironment({ tier: host.tier, gpu: host.gpu, dpr: 1, viewport: [width, height] });
  const scene = bench.scene;
  const world = new World(scene, { registry, ledger, policy: 'tagged', animations: bench.animations ?? [], ...(bench.worldOptions ?? {}) });
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
    for (let i = 0; i < WARM; i++) {
      bench.setTime?.(i / 60);
      await frameAsync();
    }
    const render: number[] = [];
    const frames: number[] = [];
    const shadowPasses: number[] = [];
    let last = performance.now();
    for (let i = 0; i < measured; i++) {
      bench.setTime?.((WARM + i) / 60);
      const f = await frameAsync();
      const now = performance.now();
      render.push(f.js.renderMs);
      frames.push(now - last);
      shadowPasses.push(f.lighting.shadowPasses);
      last = now;
      if (i % 10 === 0) onProgress(`${id} ${variant} · frame ${i + 1}/${measured}`);
    }
    const overdraw = await ledger.measureOverdraw(scene, camera);
    ledger.rescan();
    const frame = await frameAsync();
    return metricsOf({ ...frame, overdraw: { ...frame.overdraw, ...overdraw, measured: true } }, median(render), median(frames), shadowPasses.reduce((a, b) => a + b, 0) / Math.max(1, shadowPasses.length));
  } finally {
    world.decompile();
    disposeScene(scene);
    scene.environment?.dispose();
    ledger.detach();
    renderer.setSize(800, 600, false);
  }
}

/** Every requested scene in both variants, one at a time; the result is what the page submits. */
export async function runBench(host: Host, options: RunOptions): Promise<DeviceResult> {
  const fillRateGPix = options.probe ? await probeFillRate(host.renderer) : null;
  const scenes = {} as DeviceResult['scenes'];
  let n = 0;
  for (const id of options.sceneIds) {
    for (const variant of ['naive', 'optimized'] as const) {
      n++;
      options.onProgress(`scene ${n}/${options.sceneIds.length * 2} · ${id} ${variant} · loading`);
      const metrics = await runOne(host, id, variant, options.measured, options.onProgress);
      (scenes[id] ??= {} as DeviceResult['scenes'][SceneId])[variant] = metrics;
      options.onScene(id, variant, metrics);
    }
  }
  const env: DeviceEnv = {
    three: REVISION,
    backend: host.backend,
    multiDraw: host.multiDraw,
    tier: host.tier,
    gpu: host.gpu,
    dpr: devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    ua: navigator.userAgent,
    platform: (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || 'unknown',
    cores: navigator.hardwareConcurrency ?? null,
    deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
    fillRateGPix,
  };
  const now = new Date();
  return { schemaVersion: 1, kind: 'device', id: resultId(env, now), createdAt: now.toISOString(), env, scenes };
}

export { MEASURED };
