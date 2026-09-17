import { Color } from 'three';
import { buildNaiveScene } from '../../scenes/naive.js';
import type { BenchBuilder } from './index.js';

/** The naive prop field (`test/scenes/naive.ts`); `shadows=1` turns its sun into a 1024² shadow caster. */
export const naiveScene: BenchBuilder = async ({ renderer, params }) => {
  const naive = buildNaiveScene(Number(params.get('seed') ?? '1'));
  naive.scene.background = new Color(0x202830);
  if (params.get('shadows') === '1') {
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
  return {
    scene: naive.scene,
    counts: naive.counts,
    naive,
    animate: () => {
      for (const d of naive.dynamics) d.rotation.y += 0.02;
    },
  };
};
