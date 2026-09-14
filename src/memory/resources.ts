import type { BufferGeometry, Material, Object3D, Texture } from 'three';

export interface ResourceSets {
  geometries: Set<BufferGeometry>;
  materials: Set<Material>;
  textures: Set<Texture>;
}

export function emptyResourceSets(): ResourceSets {
  return { geometries: new Set(), materials: new Set(), textures: new Set() };
}

function texturesOf(material: Material, into: Set<Texture>): void {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if ((value as Texture | null)?.isTexture) into.add(value as Texture);
  }
}

/** Every geometry, material and texture reachable from `root` (a Scene adds its background and environment). */
export function collectResources(root: Object3D, into: ResourceSets = emptyResourceSets()): ResourceSets {
  root.traverse((o) => {
    const mesh = o as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
    if (mesh.geometry) into.geometries.add(mesh.geometry);
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      into.materials.add(material);
      texturesOf(material, into.textures);
    }
  });
  const scene = root as Object3D & { isScene?: boolean; background?: unknown; environment?: unknown };
  if (scene.isScene) {
    for (const value of [scene.background, scene.environment]) if ((value as Texture | null)?.isTexture) into.textures.add(value as Texture);
  }
  return into;
}

/**
 * Resources the renderer still holds (`renderer.info.memory` counts) that the scene no longer references: what was
 * removed without `dispose()`. `allowance` is what the renderer allocates for itself (render-target textures).
 */
export function unreferencedResources(info: { geometries: number; textures: number }, scene: Object3D, allowance: { geometries?: number; textures?: number } = {}): { geometries: number; textures: number } {
  const reachable = collectResources(scene);
  return {
    geometries: Math.max(0, info.geometries - reachable.geometries.size - (allowance.geometries ?? 0)),
    textures: Math.max(0, info.textures - reachable.textures.size - (allowance.textures ?? 0)),
  };
}
