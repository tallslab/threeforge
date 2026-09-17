import type { Light, Object3D } from 'three';
import { budgetsFor, type Tier } from '../ledger/budgets.js';

export interface ShadowBudgetOptions {
  tier: Tier;
  /** Shadow texels per frame allowed; default: the tier's `shadowTexels` budget. */
  texels?: number;
  /** Keep point-light shadows (six faces each); default only on desktop. */
  pointShadows?: boolean;
  /** Tiers on which every shadow is switched off. */
  off?: Tier[];
  /** Maps never shrink below this side length (default 256). */
  minMapSize?: number;
}

export interface ShadowLightReport {
  name: string;
  type: string;
  faces: number;
  from: [number, number];
  to: [number, number];
  castShadow: boolean;
}

export interface ShadowBudgetReport {
  tier: Tier;
  budget: number;
  before: number;
  after: number;
  lights: ShadowLightReport[];
}

type ShadowLight = Light & {
  isPointLight?: boolean;
  shadow?: {
    mapSize: { x: number; y: number; set(x: number, y: number): unknown };
    autoUpdate: boolean;
    needsUpdate: boolean;
  };
};
type Restore = () => void;

/**
 * Fits shadow maps to the device tier: switches every shadow off on the listed tiers, drops point-light shadows
 * (six faces each) off phones, then halves the largest map until the texel sum fits the tier's budget. three
 * resizes the render targets on the next shadow render. `release()` restores every size and flag.
 */
export class ShadowBudget {
  readonly tier: Tier;
  readonly budget: number;
  readonly pointShadows: boolean;
  readonly off: Set<Tier>;
  readonly minMapSize: number;
  private restores: Restore[] = [];

  constructor(options: ShadowBudgetOptions) {
    this.tier = options.tier;
    this.budget = options.texels ?? budgetsFor(options.tier).shadowTexels;
    this.pointShadows = options.pointShadows ?? options.tier === 'desktop';
    this.off = new Set(options.off ?? []);
    this.minMapSize = options.minMapSize ?? 256;
  }

  apply(root: Object3D): ShadowBudgetReport {
    this.release();
    const lights: ShadowLight[] = [];
    root.traverse((o) => {
      const light = o as ShadowLight;
      if (light.isLight && light.visible && light.castShadow && light.shadow) lights.push(light);
    });
    const faces = (l: ShadowLight): number => (l.isPointLight ? 6 : 1);
    // three renders each of a point light's six cube faces at the map's width and never reads its height (three r186,
    // nodes/lighting/PointShadowNode.js:227 and :254); every other map costs width x height.
    const texels = (l: ShadowLight): number =>
      l.castShadow
        ? l.isPointLight
          ? l.shadow!.mapSize.x * l.shadow!.mapSize.x * 6
          : l.shadow!.mapSize.x * l.shadow!.mapSize.y
        : 0;
    const entries = lights.map((light) => ({
      light,
      from: [light.shadow!.mapSize.x, light.shadow!.mapSize.y] as [number, number],
      castShadow: true,
    }));
    const before = lights.reduce((sum, l) => sum + texels(l), 0);
    const disable = (light: ShadowLight): void => {
      light.castShadow = false;
      this.restores.push(() => {
        light.castShadow = true;
      });
    };
    if (this.off.has(this.tier)) for (const l of lights) disable(l);
    else if (!this.pointShadows) for (const l of lights) if (l.isPointLight) disable(l);
    // Halve the largest map while over budget; a map at minMapSize cannot shrink further.
    let total = lights.reduce((sum, l) => sum + texels(l), 0);
    for (let guard = 0; total > this.budget && guard < 64; guard++) {
      let largest: ShadowLight | null = null;
      for (const l of lights)
        if (l.castShadow && l.shadow!.mapSize.x > this.minMapSize && (!largest || texels(l) > texels(largest)))
          largest = l;
      if (!largest) break;
      const { x, y } = largest.shadow!.mapSize;
      const nx = Math.max(this.minMapSize, x >> 1);
      const ny = Math.max(this.minMapSize, y >> 1);
      largest.shadow!.mapSize.set(nx, ny);
      const shadow = largest.shadow!;
      this.restores.push(() => {
        shadow.mapSize.set(x, y);
      });
      total = lights.reduce((sum, l) => sum + texels(l), 0);
    }
    return {
      tier: this.tier,
      budget: this.budget,
      before,
      after: total,
      lights: entries.map(({ light, from }) => ({
        name: light.name,
        type: light.type,
        faces: faces(light),
        from,
        to: [light.shadow!.mapSize.x, light.shadow!.mapSize.y],
        castShadow: light.castShadow,
      })),
    };
  }

  /** Restores every map size and castShadow flag this budget changed. */
  release(): void {
    for (const restore of this.restores.reverse()) restore();
    this.restores = [];
  }

  /** A static light's shadow map renders once now and then only when the returned `refresh()` is called. */
  static freeze(light: Light): () => void {
    const shadow = (light as ShadowLight).shadow;
    if (!shadow) return () => {};
    shadow.autoUpdate = false;
    shadow.needsUpdate = true;
    return () => {
      shadow.needsUpdate = true;
    };
  }
}
