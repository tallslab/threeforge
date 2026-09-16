import type { Object3D } from 'three';
import type { LightingSnapshot, SkinningSnapshot, SubmissionRecord } from './snapshot.js';

/** What the lighting section needs to know about one light of the frame. */
export interface LightInfo {
  type: string;
  name: string;
  castShadow: boolean;
  mapSize: [number, number];
  /** Shadow-map faces rendered per frame: 6 for point lights (cube target), else 1. */
  faces: number;
}

/** What the ledger saw of the frame's shadow maps, beyond its submission records. */
export interface ShadowWork {
  /**
   * Σ `mapSize.x · mapSize.y` over the lights whose shadow map rendered this frame, each light once, and
   * `mapSize.x² · 6` for a point light (three renders each of its six cube faces at the map's width): a frozen map
   * that did not refresh, or a disabled shadow map, adds nothing.
   */
  texels: number;
  /** Distinct objects drawn into any shadow map this frame: a BatchedMesh or an InstancedMesh is one, whatever it draws. */
  casters: number;
}

const NO_SHADOW_WORK: ShadowWork = Object.freeze({ texels: 0, casters: 0 });

/** Skinned work of the main pass: vertices, unique skeletons and their bones. */
export function skinningOf(items: SubmissionRecord[]): SkinningSnapshot {
  const skeletons = new Map<number, number>();
  let submissions = 0;
  let vertices = 0;
  let maxBones = 0;
  let morphTargets = 0;
  let vatInstances = 0;
  let vatVertices = 0;
  for (const item of items) {
    if (item.pass !== 'main') continue;
    if (item.reason === 'vat-instanced') {
      vatInstances += item.instancesDrawn;
      vatVertices += item.vertices * item.instancesDrawn;
      continue;
    }
    if (item.kind !== 'skinned') continue;
    submissions++;
    vertices += item.vertices;
    morphTargets += item.morphTargets;
    maxBones = Math.max(maxBones, item.bones);
    if (item.skeleton !== null) skeletons.set(item.skeleton, item.bones);
  }
  let bones = 0;
  for (const b of skeletons.values()) bones += b;
  return { submissions, vertices, bones, skeletons: skeletons.size, maxBones, morphTargets, vatInstances, vatVertices };
}

/** The world-visible lights under `scene`: three's render lists skip a hidden object's whole subtree, lights included. */
export function scanLights(scene: Object3D): LightInfo[] {
  const out: LightInfo[] = [];
  scene.traverseVisible((o) => {
    if ((o as { isLight?: boolean }).isLight) out.push(lightInfoOf(o));
  });
  return out;
}

/** The lighting section's view of one light (the ledger reads the lights three projected, else walks like `scanLights`). */
export function lightInfoOf(o: Object3D): LightInfo {
  const light = o as Object3D & { isPointLight?: boolean; castShadow: boolean; shadow?: { mapSize: { x: number; y: number } } };
  const shadow = light.castShadow && light.shadow ? light.shadow : null;
  return { type: o.type, name: o.name, castShadow: shadow !== null, mapSize: shadow ? [shadow.mapSize.x, shadow.mapSize.y] : [0, 0], faces: light.isPointLight ? 6 : 1 };
}

const TYPE_KEYS: Record<string, keyof LightingSnapshot['lights']> = {
  DirectionalLight: 'directional',
  PointLight: 'point',
  SpotLight: 'spot',
  HemisphereLight: 'hemisphere',
  AmbientLight: 'ambient',
};

/**
 * The lighting section. `lights` are the frame's lights by type, `shadowLights` those configured to cast. Shadow passes
 * and shadow submissions count the scene submissions of `shadow:*` passes: renderer-internal items (the VSM blur quads of
 * `shadow:<id>:vsm`) are neither. Texels and casters are what the ledger saw render (`shadows`; none without it).
 */
export function lightingOf(lights: LightInfo[], items: SubmissionRecord[], shadows: ShadowWork = NO_SHADOW_WORK): LightingSnapshot {
  const counts = { directional: 0, point: 0, spot: 0, hemisphere: 0, ambient: 0, other: 0 };
  let shadowLights = 0;
  for (const l of lights) {
    counts[TYPE_KEYS[l.type] ?? 'other']++;
    if (l.castShadow) shadowLights++;
  }
  const passes = new Set<string>();
  let shadowSubmissions = 0;
  for (const item of items) {
    if (item.reason === 'renderer-internal' || !item.pass.startsWith('shadow:')) continue;
    passes.add(item.pass);
    shadowSubmissions++;
  }
  return { lights: counts, shadowLights, shadowPasses: passes.size, shadowCasters: shadows.casters, shadowTexels: shadows.texels, shadowSubmissions };
}
