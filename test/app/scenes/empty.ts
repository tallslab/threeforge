import { Color, Scene } from 'three';
import type { BenchBuilder } from './index.js';

/** Nothing but a background: specs build their own content in the page. */
export const emptyScene: BenchBuilder = async () => {
  const scene = new Scene();
  scene.background = new Color(0x202830);
  return { scene, counts: {} };
};
