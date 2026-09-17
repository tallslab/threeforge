import { Color } from 'three';
import { buildFieldScene } from '../../scenes/field.js';
import type { BenchBuilder } from './index.js';

/** The 20k-instance field (`test/scenes/field.ts`), seen from ground level. */
export const fieldScene: BenchBuilder = async ({ camera, params }) => {
  const field = buildFieldScene({ count: Number(params.get('count') ?? '20000') });
  field.scene.background = new Color(0x202830);
  camera.position.set(0, 2, 0);
  camera.lookAt(100, 1, 0);
  camera.updateMatrixWorld();
  return { scene: field.scene, counts: {}, field };
};
