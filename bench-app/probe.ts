import { Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, Scene, Vector2 } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

/**
 * Fill-rate probe: transparent fullscreen layers, doubled until a frame no longer fits in a vsync interval, then
 * layers × pixels drawn per second over about `seconds`. GPix/s; informational, never gated.
 */
export async function probeFillRate(renderer: WebGPURenderer, seconds = 2): Promise<number> {
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 10);
  const geometry = new PlaneGeometry(2, 2);
  const material = new MeshBasicMaterial({
    color: 0x406080,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    depthTest: false,
  });
  const layers: Mesh[] = [];
  const setLayers = (n: number): void => {
    while (layers.length < n) {
      const m = new Mesh(geometry, material);
      m.position.z = -1 - layers.length * 0.001;
      layers.push(m);
      scene.add(m);
    }
  };
  const tick = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())));
  const size = renderer.getDrawingBufferSize(new Vector2());
  const pixels = size.x * size.y;
  let n = 8;
  setLayers(n);
  // Find a layer count that no longer fits in one vsync interval.
  for (let i = 0; i < 6; i++) {
    const t0 = await tick();
    for (let f = 0; f < 5; f++) {
      renderer.render(scene, camera);
      await tick();
    }
    const perFrame = (performance.now() - t0) / 5;
    if (perFrame > 20 || n >= 512) break;
    n *= 2;
    setLayers(n);
  }
  const start = performance.now();
  let frames = 0;
  while (performance.now() - start < seconds * 1000) {
    renderer.render(scene, camera);
    await tick();
    frames++;
  }
  const elapsed = (performance.now() - start) / 1000;
  geometry.dispose();
  material.dispose();
  return (frames * n * pixels) / elapsed / 1e9;
}
