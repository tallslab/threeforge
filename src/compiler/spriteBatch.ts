import { DynamicDrawUsage, Frustum, InstancedBufferAttribute, InstancedBufferGeometry, Matrix4, Mesh, NormalBlending, PlaneGeometry, type Camera, type CoordinateSystem, type Object3D } from 'three';
import { SpriteNodeMaterial } from 'three/webgpu';
import { instancedDynamicBufferAttribute } from 'three/tsl';
import { prependRenderHook } from './culling.js';
import { fillSpriteInstances, type SpriteGroup } from './sprites.js';
import { SceneSpace } from './space.js';

/** One instanced billboard draw standing in for a group of sprites; the originals keep driving it. */
export interface SpriteBatch {
  mesh: Mesh;
  group: SpriteGroup;
  material: SpriteNodeMaterial;
  centers: InstancedBufferAttribute;
  scales: InstancedBufferAttribute;
  /** Restores the hook and frees the geometry and the material. */
  dispose(): void;
}

export interface SpriteBatchOptions {
  /** Whether this render call should refresh the instances (false for nested passes under `reuse-main`). */
  sync(camera: Camera): boolean;
  /** Visibility of the originals is resolved up to this root. */
  root: Object3D;
  /**
   * The space of the object the batch mesh is added to: instances are written in it. Default: `root`'s (add the mesh
   * to `root`, as `World` does with the scene, passing its own `SceneSpace`).
   */
  space?: SceneSpace;
}

/**
 * Builds the batch: a unit quad as InstancedBufferGeometry, a SpriteNodeMaterial copied from the group's
 * SpriteMaterial with per-instance centre and scale nodes, and a FORGE_HOOK render hook that fills the attributes
 * from the originals' world matrices every frame, written in `options.space` (sorted back to front when the material
 * blends). A ParticleBudget
 * caps the instance count through `mesh.userData.forge.cap`.
 */
export function buildSpriteBatch(group: SpriteGroup, index: number, options: SpriteBatchOptions): SpriteBatch {
  const n = group.sprites.length;
  const geometry = new InstancedBufferGeometry();
  const plane = new PlaneGeometry(1, 1);
  geometry.setIndex(plane.getIndex());
  geometry.setAttribute('position', plane.getAttribute('position'));
  geometry.setAttribute('uv', plane.getAttribute('uv'));
  plane.dispose();
  geometry.instanceCount = n;
  const centers = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
  centers.setUsage(DynamicDrawUsage);
  const scales = new InstancedBufferAttribute(new Float32Array(n * 2), 2);
  scales.setUsage(DynamicDrawUsage);

  const source = group.material;
  const material = new SpriteNodeMaterial();
  material.map = source.map;
  material.color.copy(source.color);
  material.opacity = source.opacity;
  material.transparent = source.transparent;
  material.blending = source.blending;
  material.blendSrc = source.blendSrc;
  material.blendDst = source.blendDst;
  material.blendEquation = source.blendEquation;
  material.premultipliedAlpha = source.premultipliedAlpha;
  material.depthWrite = source.depthWrite;
  material.depthTest = source.depthTest;
  material.alphaTest = source.alphaTest;
  material.fog = source.fog;
  material.rotation = source.rotation;
  material.sizeAttenuation = source.sizeAttenuation;
  material.toneMapped = source.toneMapped;
  material.side = source.side;
  material.positionNode = instancedDynamicBufferAttribute(centers, 'vec3');
  material.scaleNode = instancedDynamicBufferAttribute(scales, 'vec2');

  const mesh = new Mesh(geometry, material);
  mesh.name = `forge:sprites:${group.programHash}:${index}`;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.userData.forge = { kind: 'sprites', cap: Infinity };
  const sorted = source.transparent && source.blending === NormalBlending;
  const space = options.space ?? new SceneSpace(options.root);
  const frustum = new Frustum();
  const projScreen = new Matrix4();
  const restoreHook = prependRenderHook(mesh, (renderer, _scene, camera) => {
    if (!options.sync(camera)) return;
    const cap = (mesh.userData.forge as { cap?: number }).cap ?? Infinity;
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen, (renderer as { coordinateSystem?: CoordinateSystem }).coordinateSystem);
    const count = fillSpriteInstances(group.sprites, centers.array as Float32Array, scales.array as Float32Array, { camera, sorted, cap, root: options.root, frustum, space });
    geometry.instanceCount = count;
    centers.needsUpdate = true;
    scales.needsUpdate = true;
  });
  return {
    mesh,
    group,
    material,
    centers,
    scales,
    dispose() {
      restoreHook();
      geometry.dispose();
      material.dispose();
    },
  };
}
