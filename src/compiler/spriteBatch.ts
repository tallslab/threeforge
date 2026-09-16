import { BackSide, DynamicDrawUsage, FrontSide, Frustum, InstancedBufferAttribute, InstancedBufferGeometry, Matrix4, Mesh, NormalBlending, PlaneGeometry, type Camera, type CoordinateSystem, type Object3D } from 'three';
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
  /**
   * Restores the hook and frees the geometry, and the material unless `material: false` — then the caller owns it,
   * which is how `World.decompile()` keeps a batch material another registered material still merges into.
   */
  dispose(options?: SpriteBatchDisposeOptions): void;
}

export interface SpriteBatchDisposeOptions {
  /** `false` leaves the batch material alone; the caller disposes it, or deliberately keeps it alive. */
  material?: boolean;
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
 * blends; FrontSide and BackSide swapped while the space mirrors). A ParticleBudget
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
  // three r186's NodeMaterial.copy takes every enumerable field the batch material also has (Material's, SpriteMaterial's
  // such as alphaMap, and a node material's node slots), cloning clipping planes. It skips `_alphaTest` and reads setters
  // only from SpriteNodeMaterial's own prototype, so Material's `alphaTest` accessor is copied by hand. It also ends with
  // `JSON.parse(JSON.stringify(source.userData))`, which throws on a circular or BigInt value and walks whatever objects
  // userData holds: the source's userData is swapped out for the copy and put back, and the batch's stays empty. The
  // instances are then placed by the batch's own position and scale nodes; `World` never batches a node material with a
  // slot set (`spriteRule`: `sprite-node-material`), and the vertex node, which replaces the whole vertex stage, is
  // cleared for direct callers. `fitSide()` below re-fits the side the copy took from the source.
  const material = new SpriteNodeMaterial();
  const userData = source.userData;
  source.userData = {};
  try {
    material.copy(source as unknown as SpriteNodeMaterial);
  } finally {
    source.userData = userData;
  }
  material.alphaTest = source.alphaTest;
  material.positionNode = instancedDynamicBufferAttribute(centers, 'vec3');
  material.scaleNode = instancedDynamicBufferAttribute(scales, 'vec2');
  material.vertexNode = null;

  const mesh = new Mesh(geometry, material);
  mesh.name = `forge:sprites:${group.programHash}:${index}`;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.userData.forge = { kind: 'sprites', cap: Infinity };
  const sorted = source.transparent && source.blending === NormalBlending;
  const space = options.space ?? new SceneSpace(options.root);
  // three r186 flips a Mesh's front face when its own world matrix mirrors (`object.isMesh &&
  // matrixWorld.determinantAffine() < 0`: WebGPUPipelineUtils._getPrimitiveState, WebGLBackend -> WebGLState.setMaterial),
  // never a Sprite's, and the quad is counter-clockwise in view space. So while the space mirrors, the batch swaps
  // FrontSide and BackSide to cull exactly what the sprites cull (DoubleSide stays). A swap bumps the material version:
  // RenderObjects.get compares the cache key, which holds `side`, only after a version change.
  const side = source.side;
  const mirroredSide = side === FrontSide ? BackSide : side === BackSide ? FrontSide : side;
  const fitSide = (): void => {
    space.update();
    const wanted = space.mirrored ? mirroredSide : side;
    if (material.side === wanted) return;
    material.side = wanted;
    material.needsUpdate = true;
  };
  fitSide();
  const frustum = new Frustum();
  const projScreen = new Matrix4();
  const restoreHook = prependRenderHook(mesh, (renderer, _scene, camera) => {
    fitSide();
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
    dispose(options: SpriteBatchDisposeOptions = {}) {
      restoreHook();
      geometry.dispose();
      if (options.material !== false) material.dispose();
    },
  };
}
