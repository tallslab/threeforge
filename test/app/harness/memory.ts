import type { Mesh, Object3D, Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import {
  collectResources,
  createLoader,
  type DrawCallLedger,
  disposeLoader,
  type MaterialRegistry,
  ResourceTracker,
  tag,
} from 'threeforge';
import { findAsset } from '../assets.js';

/** `__forge.memory`: load a named asset through createLoader, remove it with or without release, read the renderer's counts. */
export interface MemoryHarness {
  load(name: string): Promise<{ geometries: number; textures: number }>;
  remove(): void;
  release(): { geometries: number; textures: number };
  info(): {
    geometries: number;
    textures: number;
    reachable: { geometries: number; textures: number };
    renderTargets: number;
    unreferenced: { geometries: number; textures: number };
  };
}

export function createMemoryHarness(h: {
  renderer: WebGPURenderer;
  scene: Scene;
  ledger: DrawCallLedger;
  registry: MaterialRegistry;
}): MemoryHarness {
  const { renderer, scene, ledger } = h;
  const tracker = new ResourceTracker({ registry: h.registry });
  let loadedRoot: Object3D | null = null;
  return {
    async load(name) {
      const entry = await findAsset(name);
      const loader = await createLoader(renderer, { decoders: '/_decoders/' });
      const gltf = await loader.loadAsync(`/${entry}`);
      disposeLoader(loader);
      loadedRoot = gltf.scene;
      gltf.scene.traverse((o) => {
        if ((o as Mesh).isMesh) tag.static(o);
      });
      scene.add(gltf.scene);
      tracker.track(gltf.scene);
      const r = collectResources(gltf.scene);
      return { geometries: r.geometries.size, textures: r.textures.size };
    },
    remove() {
      loadedRoot?.removeFromParent();
    },
    release() {
      const r = loadedRoot ? tracker.release(loadedRoot) : { geometries: 0, textures: 0, materials: 0 };
      loadedRoot = null;
      return { geometries: r.geometries, textures: r.textures };
    },
    info() {
      const m = renderer.info.memory;
      const estimate = ledger.measureMemory();
      const reachable = collectResources(scene);
      return {
        geometries: m.geometries,
        textures: m.textures,
        reachable: { geometries: reachable.geometries.size, textures: reachable.textures.size },
        renderTargets: estimate.renderTargets.count,
        unreferenced: estimate.unreferenced,
      };
    },
  };
}
