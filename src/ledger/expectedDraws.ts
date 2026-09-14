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
  // RenderObject.getDrawParameters() returns null for an instanced object with no instances: nothing is drawn.
  const instanced = object as Object3D & { isInstancedMesh?: boolean; count?: number };
  if (instanced.isInstancedMesh && (instanced.count ?? 0) === 0) return 0;
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

/** Instances covered by a submission and how many of them the renderer will actually draw. */
export function instanceCounts(object: Object3D): { instances: number; instancesDrawn: number } {
  const o = object as Object3D & { isBatchedMesh?: boolean; isInstancedMesh?: boolean; instanceCount?: number; count?: number; _multiDrawCount?: number; geometry?: { isInstancedBufferGeometry?: boolean; instanceCount?: number } };
  if (o.isBatchedMesh) return { instances: o.instanceCount ?? 0, instancesDrawn: o._multiDrawCount ?? 0 };
  // A plain mesh over an InstancedBufferGeometry (sprite batches): one draw, geometry.instanceCount instances.
  if (o.geometry?.isInstancedBufferGeometry) {
    const n = o.geometry.instanceCount ?? 0;
    return { instances: n, instancesDrawn: n };
  }
  if (o.isInstancedMesh) {
    const total = (object.userData as { forge?: { instances?: number } }).forge?.instances;
    return { instances: total ?? o.count ?? 0, instancesDrawn: o.count ?? 0 };
  }
  return { instances: 1, instancesDrawn: 1 };
}
