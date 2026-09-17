import { Color } from 'three';
import { prepareLods } from 'threeforge';
import { buildForestScene } from '../../scenes/forest.js';
import type { BenchBuilder } from './index.js';

/** Terrain, 5 000 trees of three species and 2 000 grass patches seen from above the canopy edge. */
export const forest: BenchBuilder = async ({ camera, params }) => {
  const f = buildForestScene({
    trees: Number(params.get('trees') ?? '5000'),
    grass: Number(params.get('grass') ?? '2000'),
  });
  f.scene.background = new Color(0x9fb8d8);
  camera.near = 0.5;
  camera.far = 2000;
  camera.position.set(0, 120, 560);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return {
    scene: f.scene,
    counts: f.counts,
    worldOptions: { lod: { distances: [160, 420] }, instanceThreshold: 64 },
    prepare: async (scene) => {
      await prepareLods(scene, { ratios: [0.5, 0.2] });
    },
  };
};
