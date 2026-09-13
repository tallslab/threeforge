import type { Material, Object3D, Scene } from 'three';
import { isDoubleSidedTransparent } from './reasons.js';

export interface BackendInfo {
  backend: 'webgl2' | 'webgpu' | 'unknown';
  multiDraw: boolean;
}

/**
 * GPU draw commands one submission issues. Must be evaluated AFTER the renderer processed the object,
 * because BatchedMesh fills `_multiDrawCount` in its onBeforeRender.
 */
export function expectedGpuDraws(object: Object3D, material: Material, scene: Scene, info: BackendInfo): number {
  let draws = 1;
  const batched = object as Object3D & { isBatchedMesh?: boolean; _multiDrawCount?: number };
  if (batched.isBatchedMesh) {
    const n = batched._multiDrawCount ?? 0;
    // WebGPU issues one drawIndexed per visible instance; WebGL does too unless WEBGL_multi_draw is present.
    draws = n === 0 ? 0 : info.backend === 'webgpu' || !info.multiDraw ? n : 1;
  }
  const effective = scene.overrideMaterial ?? material;
  if (isDoubleSidedTransparent(effective)) draws *= 2;
  return draws;
}
