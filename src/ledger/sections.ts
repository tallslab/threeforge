import type { Object3D } from 'three';
import type { LightingSnapshot, SkinningSnapshot, SubmissionRecord } from './snapshot.js';

/** What the lighting section needs to know about one visible light. */
export interface LightInfo {
  type: string;
  name: string;
  castShadow: boolean;
  mapSize: [number, number];
  /** Shadow-map faces rendered per frame: 6 for point lights (cube target), else 1. */
  faces: number;
}

/** Skinned work of the main pass: vertices, unique skeletons and their bones. */
export function skinningOf(items: SubmissionRecord[]): SkinningSnapshot {
  const skeletons = new Map<number, number>();
  let submissions = 0;
  let vertices = 0;
  let maxBones = 0;
  let morphTargets = 0;
  for (const item of items) {
    if (item.kind !== 'skinned' || item.pass !== 'main') continue;
    submissions++;
    vertices += item.vertices;
    morphTargets += item.morphTargets;
    maxBones = Math.max(maxBones, item.bones);
    if (item.skeleton !== null) skeletons.set(item.skeleton, item.bones);
  }
  let bones = 0;
  for (const b of skeletons.values()) bones += b;
  return { submissions, vertices, bones, skeletons: skeletons.size, maxBones, morphTargets };
}

export function scanLights(scene: Object3D): LightInfo[] {
  const out: LightInfo[] = [];
  scene.traverse((o) => {
    const light = o as Object3D & { isLight?: boolean; isPointLight?: boolean; castShadow: boolean; shadow?: { mapSize: { x: number; y: number } } };
    if (!light.isLight || !light.visible) return;
    const shadow = light.castShadow && light.shadow ? light.shadow : null;
    out.push({ type: o.type, name: o.name, castShadow: shadow !== null, mapSize: shadow ? [shadow.mapSize.x, shadow.mapSize.y] : [0, 0], faces: light.isPointLight ? 6 : 1 });
  });
  return out;
}

const TYPE_KEYS: Record<string, keyof LightingSnapshot['lights']> = {
  DirectionalLight: 'directional',
  PointLight: 'point',
  SpotLight: 'spot',
  HemisphereLight: 'hemisphere',
  AmbientLight: 'ambient',
};

export function lightingOf(lights: LightInfo[], items: SubmissionRecord[]): LightingSnapshot {
  const counts = { directional: 0, point: 0, spot: 0, hemisphere: 0, ambient: 0, other: 0 };
  let shadowLights = 0;
  let shadowTexels = 0;
  for (const l of lights) {
    counts[TYPE_KEYS[l.type] ?? 'other']++;
    if (l.castShadow) {
      shadowLights++;
      shadowTexels += l.mapSize[0] * l.mapSize[1] * l.faces;
    }
  }
  const passes = new Set<string>();
  const casters = new Set<string>();
  let shadowSubmissions = 0;
  for (const item of items) {
    if (!item.pass.startsWith('shadow:')) continue;
    passes.add(item.pass);
    casters.add(item.name);
    shadowSubmissions++;
  }
  return { lights: counts, shadowLights, shadowPasses: passes.size, shadowCasters: casters.size, shadowTexels, shadowSubmissions };
}
