import { type Camera, DoubleSide, type Material, type Mesh, type Scene, type Texture, Vector4 } from 'three';
import type { PassTracker } from '../passTracker.js';
import type { OcclusionProxies } from './occlusion.js';
import type { WarmupOptions, WarmupRenderer, WarmupResult } from './types.js';

/**
 * Materials three r186 renders in two passes (`renderObject()` flips `side` for transparent DoubleSide,
 * `_renderTransparents()` for transmissive DoubleSide) or through a viewport texture (transmission, backdrop):
 * `compileAsync()` builds their render objects after that state is gone.
 */
export function compiledWrongByCompileAsync(material: Material): boolean {
  const m = material as Material & { transmission?: number; transmissionNode?: unknown; backdropNode?: unknown };
  const transmissive = (m.transmission ?? 0) > 0 || !!m.transmissionNode || !!m.backdropNode;
  const doublePass = m.transparent && m.side === DoubleSide && m.forceSinglePass === false;
  return transmissive || doublePass;
}

export interface WarmupTarget {
  scene: Scene;
  passes: PassTracker;
  occlusion: OcclusionProxies;
}

/** `World.warmup()` once the World has checked it is live. */
export async function warmup(
  target: WarmupTarget,
  renderer: WarmupRenderer,
  camera: Camera,
  options: WarmupOptions = {},
): Promise<WarmupResult> {
  const { scene, passes, occlusion } = target;
  // Awaiting init here, before any state is read or changed, leaves no yield between the suspension and scissor
  // below and the render: a queued re-enable (or any other microtask) cannot run in between. That is why warm-up
  // renders with `render()` rather than the deprecated `renderAsync` (docs/threeforge.md section 4, "How it hooks in").
  if (renderer.init) await renderer.init();
  // A proxy parked by a depth-0 render waits for its queued re-enable, which would re-enable it after the suspension
  // list below was built without it if anything yielded before the render. Resume now, so the list holds every proxy;
  // the queued call then finds nothing parked.
  occlusion.resumeParked();
  const textures = new Set<Texture>();
  const materials = new Set<Material>();
  scene.traverse((o) => {
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
    try {
      await renderer.compileAsync!(scene, camera);
    } finally {
      // three r186's compileAsync calls the scene's onBeforeRender but never its onAfterRender (Renderer.js ~967): the
      // tracker would count the next render as nested, also after a rejection. It renders no shadow maps, so only its
      // own render is open.
      passes.reset();
    }
    for (const material of materials) {
      if (!compiledWrongByCompileAsync(material)) continue;
      material.dispose(); // drops the renderer's cached render objects; the material stays usable
      repaired++;
    }
  }
  // One real frame, clipped to a single pixel: builds (or rebuilds) every pipeline the way `render()` does.
  const scissor = renderer.getScissor(new Vector4());
  const scissorTest = renderer.getScissorTest();
  // No occlusion query from this frame: the scissor discards every fragment, so each query would count no samples and,
  // once three publishes that answer a render or more later, hide every target whose proxy was drawn. A render whose
  // list counts no query publishes nothing (the `else` branch of both backends' beginRender), and render() has
  // returned by the `finally`, so no query is open when the flags come back.
  const suspended: Mesh[] = [];
  for (const proxy of occlusion.proxies) {
    if (!proxy.occlusionTest) continue;
    proxy.occlusionTest = false;
    suspended.push(proxy);
  }
  renderer.setScissor(0, 0, 1, 1);
  renderer.setScissorTest(true);
  try {
    renderer.render(scene, camera);
  } finally {
    for (const proxy of suspended) proxy.occlusionTest = true;
    renderer.setScissorTest(scissorTest);
    renderer.setScissor(scissor.x, scissor.y, scissor.z, scissor.w);
  }
  return { mode, textures: renderer.initTexture ? textures.size : 0, repaired };
}
