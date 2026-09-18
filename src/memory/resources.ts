import {
  type BufferGeometry,
  type InterleavedBufferAttribute,
  type Material,
  type Object3D,
  Sprite,
  type Texture,
} from 'three';

export interface ResourceSets {
  geometries: Set<BufferGeometry>;
  materials: Set<Material>;
  textures: Set<Texture>;
}

export function emptyResourceSets(): ResourceSets {
  return { geometries: new Set(), materials: new Set(), textures: new Set() };
}

let spriteGeometry: BufferGeometry | undefined;

/**
 * Whether `geometry` is the one three shares between every `Sprite` (module-level in Sprite.js): it belongs to no
 * scene, so freeing a scene's resources must leave it. On WebGPU in r186 disposing it breaks every sprite drawn
 * afterwards: `WebGPUAttributeUtils.destroyAttribute` destroys an interleaved buffer but deletes its record under
 * the attribute, not the `InterleavedBuffer` it is kept under, so the next upload reuses the destroyed buffer.
 */
export function isSharedSpriteGeometry(geometry: BufferGeometry): boolean {
  spriteGeometry ??= new Sprite().geometry;
  return geometry === spriteGeometry;
}

/**
 * Whether an attribute of `geometry` reads from an `InterleavedBuffer`; GLTFLoader builds one for every bufferView
 * with a byteStride. On WebGPU in r186 such a geometry cannot be disposed and then drawn again, for the defect
 * `isSharedSpriteGeometry` describes. glTF primitives that reuse an accessor share its buffer, so disposing one
 * geometry also breaks the others on it.
 */
export function isInterleavedGeometry(geometry: BufferGeometry): boolean {
  for (const attribute of Object.values(geometry.attributes))
    if ((attribute as InterleavedBufferAttribute).isInterleavedBufferAttribute) return true;
  return false;
}

/** Adds `value` when it is a texture: material properties, a scene's background and a mesh's internal maps all arrive untyped. */
function addTexture(value: unknown, into: Set<Texture>): void {
  if ((value as Texture | null)?.isTexture) into.add(value as Texture);
}

function texturesOf(material: Material, into: Set<Texture>): void {
  for (const value of Object.values(material)) addTexture(value, into);
  // Node materials sample textures through TSL nodes the properties do not show; modules list them here (AnimatedInstances does).
  const extra = material.userData.forgeTextures as unknown;
  if (Array.isArray(extra)) for (const t of extra) addTexture(t, into);
}

/**
 * Every geometry, material and texture reachable from `root`: material properties, node textures listed in
 * `material.userData.forgeTextures`, a BatchedMesh's matrix/indirect/colour textures, a skeleton's bone texture, and
 * for a Scene its background and environment.
 */
export function collectResources(root: Object3D, into: ResourceSets = emptyResourceSets()): ResourceSets {
  // A material shared by thousands of meshes has its properties read once per call. Only materials seen in this call
  // are skipped: one already in `into` is read again (`ResourceTracker.track(material)` files it without its textures).
  const seen = new Set<Material>();
  const addMaterial = (material: Material): void => {
    if (seen.has(material)) return;
    seen.add(material);
    into.materials.add(material);
    texturesOf(material, into.textures);
  };
  root.traverse((o) => {
    const mesh = o as Object3D & {
      geometry?: BufferGeometry;
      material?: Material | Material[];
      isBatchedMesh?: boolean;
      _matricesTexture?: Texture | null;
      _indirectTexture?: Texture | null;
      _colorsTexture?: Texture | null;
      isSkinnedMesh?: boolean;
      skeleton?: { boneTexture?: Texture | null };
    };
    if (mesh.geometry) into.geometries.add(mesh.geometry);
    if (mesh.isBatchedMesh)
      for (const t of [mesh._matricesTexture, mesh._indirectTexture, mesh._colorsTexture]) addTexture(t, into.textures);
    if (mesh.isSkinnedMesh) addTexture(mesh.skeleton?.boneTexture, into.textures);
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const m of material) addMaterial(m);
    } else if (material) {
      addMaterial(material);
    }
  });
  const scene = root as Object3D & { isScene?: boolean; background?: unknown; environment?: unknown };
  if (scene.isScene) for (const value of [scene.background, scene.environment]) addTexture(value, into.textures);
  return into;
}

/**
 * Resources the renderer still holds (`renderer.info.memory` counts) that the scene no longer references: what was
 * removed without `dispose()`. `allowance` is what the renderer allocates for itself (render-target textures).
 */
export function unreferencedResources(
  info: { geometries: number; textures: number },
  scene: Object3D,
  allowance: { geometries?: number; textures?: number } = {},
): { geometries: number; textures: number } {
  const reachable = collectResources(scene);
  return {
    geometries: Math.max(0, info.geometries - reachable.geometries.size - (allowance.geometries ?? 0)),
    textures: Math.max(0, info.textures - reachable.textures.size - (allowance.textures ?? 0)),
  };
}
