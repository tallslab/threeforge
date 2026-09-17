import type { Material, Object3D, Points } from 'three';
import { budgetsFor, type Tier } from '../ledger/budgets.js';

export interface ParticleBudgetOptions {
  tier: Tier;
  /** Particles drawn per frame across every system; default: the tier's `particles` budget. */
  particles?: number;
  /** Multiplier for `PointsMaterial.size`; default 0.75 on `phone-low`, 1 elsewhere. */
  pointSizeScale?: number;
}

export interface ParticleSystemReport {
  name: string;
  /** `sprite` is a single Sprite object: counted (it costs a quad) but never capped. */
  kind: 'points' | 'sprites' | 'sprite';
  /** Particles the system would draw on its own (an existing drawRange counts as its size). */
  count: number;
  /** Particles it draws under the budget. */
  drawn: number;
}

export interface ParticleBudgetReport {
  tier: Tier;
  budget: number;
  before: number;
  after: number;
  /** `after / before`, 1 when nothing was capped. */
  ratio: number;
  systems: ParticleSystemReport[];
}

interface PointsLike extends Points {
  isPoints: true;
}
interface SpriteBatchLike extends Object3D {
  geometry?: { isInstancedBufferGeometry?: boolean; instanceCount?: number };
  userData: { forge?: { kind?: string; cap?: number } };
}
type Restore = () => void;

/**
 * Caps live particles per device tier. Every `Points` object, every sprite batch and every single Sprite under the
 * root is a system; when their counts add up to more than the budget, the cappable ones (points by `drawRange`,
 * sprite batches by `cap`, honoured by their render hook) shrink by one common ratio so the total fits under the
 * budget alongside the single sprites, which cost a quad each but cannot be capped. Point sizes shrink by
 * `pointSizeScale`. `release()` restores all. The total matches the ledger's `overdraw.particles`.
 */
export class ParticleBudget {
  readonly tier: Tier;
  readonly budget: number;
  readonly pointSizeScale: number;
  private restores: Restore[] = [];
  private scaledMaterials = new Set<Material>();

  constructor(options: ParticleBudgetOptions) {
    this.tier = options.tier;
    this.budget = options.particles ?? budgetsFor(options.tier).particles;
    this.pointSizeScale = options.pointSizeScale ?? (options.tier === 'phone-low' ? 0.75 : 1);
  }

  /** Applies the budget under `root` (idempotent: a second call re-derives from the original counts). */
  apply(root: Object3D): ParticleBudgetReport {
    this.release();
    const systems: Array<{
      object: PointsLike | SpriteBatchLike;
      kind: 'points' | 'sprites' | 'sprite';
      count: number;
    }> = [];
    root.traverse((o) => {
      const p = o as PointsLike;
      if (p.isPoints) {
        const position = p.geometry.getAttribute('position');
        const total = position ? position.count : 0;
        const range = p.geometry.drawRange;
        const count = Number.isFinite(range.count) ? Math.max(0, Math.min(total - range.start, range.count)) : total;
        systems.push({ object: p, kind: 'points', count });
        return;
      }
      if ((o as { isSprite?: boolean }).isSprite) {
        systems.push({ object: o as SpriteBatchLike, kind: 'sprite', count: 1 });
        return;
      }
      const s = o as SpriteBatchLike;
      if (s.userData.forge?.kind === 'sprites' && s.geometry?.isInstancedBufferGeometry)
        systems.push({ object: s, kind: 'sprites', count: s.geometry.instanceCount ?? 0 });
    });
    const before = systems.reduce((sum, s) => sum + s.count, 0);
    const fixed = systems.reduce((sum, s) => (s.kind === 'sprite' ? sum + s.count : sum), 0);
    const cappable = before - fixed;
    const ratio = before > this.budget && cappable > 0 ? Math.max(0, this.budget - fixed) / cappable : 1;
    const report: ParticleSystemReport[] = [];
    for (const system of systems) {
      const drawn = ratio === 1 || system.kind === 'sprite' ? system.count : Math.floor(system.count * ratio);
      if (system.kind === 'points') {
        const points = system.object as PointsLike;
        if (ratio !== 1) {
          const { start, count } = points.geometry.drawRange;
          points.geometry.setDrawRange(start, drawn);
          this.restores.push(() => points.geometry.setDrawRange(start, count));
        }
        const material = points.material as Material & { size?: number };
        if (this.pointSizeScale !== 1 && typeof material.size === 'number' && !this.scaledMaterials.has(material)) {
          const size = material.size;
          material.size = size * this.pointSizeScale;
          this.scaledMaterials.add(material);
          this.restores.push(() => {
            material.size = size;
          });
        }
      } else if (system.kind === 'sprites' && ratio !== 1) {
        const batch = system.object as SpriteBatchLike;
        const forge = batch.userData.forge!;
        const cap = forge.cap ?? Infinity;
        forge.cap = drawn;
        this.restores.push(() => {
          forge.cap = cap;
        });
      }
      report.push({ name: system.object.name, kind: system.kind, count: system.count, drawn });
    }
    const after = report.reduce((sum, s) => sum + s.drawn, 0);
    return { tier: this.tier, budget: this.budget, before, after, ratio, systems: report };
  }

  /** Restores every drawRange, cap and point size this budget changed. */
  release(): void {
    for (const restore of this.restores.reverse()) restore();
    this.restores = [];
    this.scaledMaterials.clear();
  }
}
