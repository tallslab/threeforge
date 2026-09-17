import { type BatchedMesh, Color, type Mesh, type PerspectiveCamera, type Scene, type SkinnedMesh } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { buildNaiveScene } from '../../scenes/naive.js';

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

/** Spike: run three's experimental SceneOptimizer on a fresh naive scene and measure it with the backend's own count. */
export async function spikeSceneOptimizer(h: {
  renderer: WebGPURenderer;
  camera: PerspectiveCamera;
  seed: number;
  countVisible(target: Scene, cam: PerspectiveCamera): number;
}): Promise<SpikeResult> {
  const { renderer, camera, seed } = h;
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
    return {
      drawsAfter: measure(target),
      batchedMeshes,
      plainMeshes,
      skinnedSurvived,
      visibleAfter: h.countVisible(target, camera),
    };
  };

  const asIsScene = buildNaiveScene(seed);
  asIsScene.scene.background = new Color(0x202830);
  const visibleBefore = h.countVisible(asIsScene.scene, camera);
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
