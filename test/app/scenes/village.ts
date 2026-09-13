import { Color } from 'three';
import { buildNaiveScene } from '../../scenes/naive.js';
import type { BenchBuilder } from './index.js';

/** 300 props from 40 prop shapes and 40 material recipes, a material instance per prop, 10 dynamics, 2 skinned. */
export const village: BenchBuilder = async ({ camera, params }) => {
  const count = Number(params.get('count') ?? '300');
  const n = buildNaiveScene(Number(params.get('seed') ?? '1'), { count, shapes: 40 });
  n.scene.background = new Color(0x202830);
  camera.position.set(0, 110, 150);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return {
    scene: n.scene,
    counts: { props: count, materials: n.counts.materials, shapes: 40 },
    setTime: (t) => {
      for (const d of n.dynamics) d.rotation.y = t * 0.6;
    },
  };
};
