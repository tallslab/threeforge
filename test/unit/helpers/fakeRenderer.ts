/**
 * A minimal stand-in for three's common Renderer, exposing exactly the surface the ledger patches and reads:
 * render(), renderObject(), info, backend, getRenderTarget(). It walks the scene in traversal order (the real
 * renderer sorts, but attribution does not depend on order except for programSwitches, which tests control by
 * insertion order), calls object.onBeforeRender like the real renderObject does, and counts GPU draws the way each
 * backend does: one per submission, N per BatchedMesh on WebGPU or on WebGL without WEBGL_multi_draw, x2 for
 * double-sided transparent materials that are not forceSinglePass.
 */
import { BatchedMesh, BufferGeometry, DoubleSide, Group, Light, Material, Mesh, MeshDepthMaterial, Object3D, PerspectiveCamera, PlaneGeometry, Scene, type Camera } from 'three';

export interface FakeRendererOptions {
  webgpu?: boolean;
  multiDraw?: boolean;
  /** When set, render() first performs a nested shadow pass with this light's shadow camera, like ShadowNode does. */
  shadowLight?: Light;
}

export class FakeRenderer {
  readonly info = { render: { drawCalls: 0, triangles: 0, calls: 0, frameCalls: 0 }, memory: { programs: 0 } };
  readonly backend: { isWebGPUBackend?: boolean; hasFeature(name: string): boolean };
  readonly coordinateSystem = 2000;
  readonly outputQuad: Mesh;
  renderTarget: object | null = null;
  shadowLight: Light | undefined;
  private readonly depthMaterial = new MeshDepthMaterial();

  constructor(options: FakeRendererOptions = {}) {
    const multiDraw = options.multiDraw ?? true;
    this.backend = options.webgpu
      ? { isWebGPUBackend: true, hasFeature: () => false }
      : { hasFeature: (name: string) => name === 'WEBGL_multi_draw' && multiDraw };
    this.shadowLight = options.shadowLight;
    // Like three's "Output Color Transform" quad: rendered every frame, never part of the user scene.
    this.outputQuad = new Mesh(new PlaneGeometry(2, 2), new Material());
    this.outputQuad.name = 'Output Color Transform';
  }

  getRenderTarget(): object | null {
    return this.renderTarget;
  }

  render(scene: Scene, camera: Camera): void {
    this.info.render.calls++;
    const isShadowPass = scene.overrideMaterial !== null;
    const shadow = (this.shadowLight as (Light & { shadow?: { camera: Camera } }) | undefined)?.shadow;
    if (!isShadowPass && shadow) {
      // Like ShadowNode.updateShadow(): override material, shadow map target, nested render with the shadow camera.
      scene.overrideMaterial = this.depthMaterial;
      this.renderTarget = { name: 'shadow' };
      this.render(scene, shadow.camera);
      this.renderTarget = null;
      scene.overrideMaterial = null;
    }
    scene.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh || !object.visible) return;
      if (!object.layers.test(camera.layers)) return;
      if (isShadowPass && !object.castShadow) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const groups = mesh.geometry.groups.length > 0 && Array.isArray(mesh.material) ? mesh.geometry.groups : [null];
      for (const group of groups) {
        const material = group ? materials[group.materialIndex ?? 0] : materials[0];
        if (!material) continue;
        this.renderObject(object, scene, camera, mesh.geometry, material, group, null, null, null);
      }
    });
    if (!isShadowPass) {
      this.renderObject(this.outputQuad, scene, camera, this.outputQuad.geometry, this.outputQuad.material as Material, null, null, null, null);
    }
  }

  renderObject(
    object: Object3D,
    scene: Scene,
    camera: Camera,
    geometry: BufferGeometry,
    material: Material,
    group: { start: number; count: number; materialIndex?: number } | null,
    _lightsNode: unknown,
    _clippingContext: unknown,
    _passId: string | null,
  ): void {
    object.onBeforeRender(this as unknown as never, scene, camera, geometry, material, group as never);
    const effective = scene.overrideMaterial ?? material;
    let draws = 1;
    const batched = object as BatchedMesh & { _multiDrawCount?: number };
    if (batched.isBatchedMesh) {
      const n = batched._multiDrawCount ?? 0;
      const webgl = !this.backend.isWebGPUBackend;
      draws = n === 0 ? 0 : !webgl || !this.backend.hasFeature('WEBGL_multi_draw') ? n : 1;
    }
    if (effective.transparent && effective.side === DoubleSide && !effective.forceSinglePass) draws *= 2;
    this.info.render.drawCalls += draws;
  }
}

/** A scene with a camera looking at the origin; helpers return meshes already added to the scene. */
export function sceneWithCamera(): { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { scene, camera };
}

export function batchedOf(count: number, material: Material, geometry: BufferGeometry): BatchedMesh {
  const batch = new BatchedMesh(count, geometry.attributes.position!.count * count, (geometry.index?.count ?? 0) * count, material);
  const id = batch.addGeometry(geometry);
  for (let i = 0; i < count; i++) batch.addInstance(id);
  batch.name = `batch-${count}`;
  return batch;
}

export { Group, Scene, Mesh, Material };
