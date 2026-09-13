import { Color, PerspectiveCamera, Scene } from 'three';
import { WebGPURenderer } from 'three/webgpu';

export type BackendName = 'webgl2' | 'webgpu';

export interface RenderOnceResult {
  backend: BackendName;
  multiDraw: boolean;
  drawCalls: number;
}

export interface ForgeHarness {
  ready: boolean;
  backend: BackendName;
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGPURenderer;
  renderOnce(): RenderOnceResult;
}

declare global {
  interface Window {
    __forge: ForgeHarness;
  }
}

const params = new URLSearchParams(location.search);
const requestedBackend: BackendName = params.get('backend') === 'webgpu' ? 'webgpu' : 'webgl2';
const sceneName = params.get('scene') ?? 'empty';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL: requestedBackend === 'webgl2' });
await renderer.init();
renderer.setPixelRatio(1);
renderer.setSize(800, 600, false);

const backend: BackendName = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
const hasFeature = (renderer.backend as { hasFeature?: (name: string) => boolean }).hasFeature;
const multiDraw = backend === 'webgl2' && typeof hasFeature === 'function' ? hasFeature.call(renderer.backend, 'WEBGL_multi_draw') : false;

const scene = new Scene();
scene.background = new Color(0x202830);
const camera = new PerspectiveCamera(60, 800 / 600, 0.1, 1000);
camera.position.set(0, 40, 90);
camera.lookAt(0, 0, 0);

if (sceneName !== 'empty') {
  throw new Error(`unknown scene "${sceneName}"`);
}

function renderOnce(): RenderOnceResult {
  // Delta inside one synchronous render() call: immune to info.autoReset running on three's own rAF.
  const before = renderer.info.render.drawCalls;
  renderer.render(scene, camera);
  return { backend, multiDraw, drawCalls: renderer.info.render.drawCalls - before };
}

window.__forge = { ready: true, backend, scene, camera, renderer, renderOnce };
