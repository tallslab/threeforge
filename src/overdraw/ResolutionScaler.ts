import { budgetsFor, type Tier } from '../ledger/budgets.js';

/** The slice of three's renderer the scaler drives. */
export interface ScalerRenderer {
  getPixelRatio(): number;
  setPixelRatio(value: number): void;
}

export interface ResolutionScalerOptions {
  /** Frame time to hold, in ms; default: the tier's `frameMs` budget (16.6 desktop and phone-mid, 33 phone-low). */
  target?: number;
  tier?: Tier;
  /** Scale bounds relative to the renderer's pixel ratio at construction. */
  min?: number;
  max?: number;
  step?: number;
  /** Frames per decision: the window's median frame time is compared with the target. */
  window?: number;
  /** When given, `env.dpr` follows the effective pixel ratio so snapshots stay truthful. */
  ledger?: { setEnvironment(env: { dpr: number }): void };
}

/**
 * Dynamic resolution: every `window` frames the median frame time decides whether the drawing buffer shrinks one
 * step (median above target × 1.05) or grows one step (median below target × 0.7). Overdraw per pixel does not
 * change; pixels do, and with them fill cost. `set()` forces a scale; `dispose()` restores the base pixel ratio.
 */
export class ResolutionScaler {
  readonly base: number;
  readonly target: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly window: number;
  private readonly renderer: ScalerRenderer;
  private readonly ledger: ResolutionScalerOptions['ledger'];
  private current = 1;
  private samples: number[] = [];

  constructor(renderer: ScalerRenderer, options: ResolutionScalerOptions = {}) {
    this.renderer = renderer;
    this.base = renderer.getPixelRatio();
    this.target = options.target ?? budgetsFor(options.tier ?? 'desktop').frameMs;
    this.min = options.min ?? 0.5;
    this.max = options.max ?? 1;
    this.step = options.step ?? 0.05;
    this.window = Math.max(1, Math.round(options.window ?? 20));
    this.ledger = options.ledger;
  }

  get scale(): number {
    return this.current;
  }

  update(frameMs: number): number {
    this.samples.push(frameMs);
    if (this.samples.length < this.window) return this.current;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    this.samples = [];
    if (median > this.target * 1.05) this.set(this.current - this.step);
    else if (median < this.target * 0.7) this.set(this.current + this.step);
    return this.current;
  }

  set(scale: number): void {
    const next = Number(Math.min(this.max, Math.max(this.min, scale)).toFixed(4));
    if (next === this.current) return;
    this.current = next;
    this.renderer.setPixelRatio(this.base * next);
    this.ledger?.setEnvironment({ dpr: this.base * next });
  }

  dispose(): void {
    this.current = 1;
    this.samples = [];
    this.renderer.setPixelRatio(this.base);
    this.ledger?.setEnvironment({ dpr: this.base });
  }
}
