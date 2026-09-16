import { describe, expect, it } from 'vitest';
import { planSteps, PRESETS, STEP_NAMES } from '../../src/cli/pipeline.js';
import type { OptimizeInput } from '../../src/cli/types.js';

const base: OptimizeInput = { file: 'a.glb', out: null, preset: 'safe', steps: {}, simplify: null, simplifyError: 0.001, compress: 'none', textures: null, textureSize: null, textureQuality: 85, verify: true, parity: 0.5, views: 2, backend: 'webgl2', tier: 'auto', budget: null, frames: 30, compile: true, timeout: 60000, headed: false };
const names = (input: Partial<OptimizeInput>) => planSteps({ ...base, ...input }).map((s) => s.name);

describe('planSteps', () => {
  it('lists the presets in pipeline order', () => {
    expect(PRESETS).toEqual(['safe', 'balanced', 'aggressive']);
    expect(names({})).toEqual(['dedup', 'palette', 'resample', 'prune']);
    expect(names({ preset: 'balanced' })).toEqual(['dedup', 'palette', 'weld', 'resample', 'prune', 'textures', 'quantize']);
    expect(names({ preset: 'aggressive' })).toEqual(['dedup', 'palette', 'weld', 'simplify', 'resample', 'prune', 'textures', 'quantize']);
  });

  it('carries the preset options and the explicit ones', () => {
    const aggressive = planSteps({ ...base, preset: 'aggressive' });
    expect(aggressive.find((s) => s.name === 'simplify')!.options).toEqual({ ratio: 0.5, error: 0.001 });
    expect(aggressive.find((s) => s.name === 'textures')!.options).toEqual({ format: 'webp', size: 1024, quality: 85 });
    expect(planSteps({ ...base, preset: 'balanced' }).find((s) => s.name === 'textures')!.options).toEqual({ format: 'webp', size: 2048, quality: 85 });
    expect(planSteps({ ...base, simplify: 0.3, simplifyError: 0.01 }).find((s) => s.name === 'simplify')!.options).toEqual({ ratio: 0.3, error: 0.01 });
    expect(planSteps({ ...base, textures: 'avif', textureSize: 512, textureQuality: 70 }).find((s) => s.name === 'textures')!.options).toEqual({ format: 'avif', size: 512, quality: 70 });
    expect(planSteps({ ...base, steps: { textures: true } }).find((s) => s.name === 'textures')!.options).toEqual({ format: 'webp', size: null, quality: 85 });
  });

  it('applies overrides: --no-<step>, --<step>, join implies flatten, meshopt replaces quantize, textures none', () => {
    expect(names({ steps: { palette: false, resample: false } })).toEqual(['dedup', 'prune']);
    expect(names({ steps: { quantize: true, instance: true } })).toEqual(['dedup', 'instance', 'palette', 'resample', 'prune', 'quantize']);
    expect(names({ steps: { join: true } })).toEqual(['dedup', 'palette', 'flatten', 'join', 'resample', 'prune']);
    expect(names({ preset: 'balanced', compress: 'meshopt' })).toEqual(['dedup', 'palette', 'weld', 'resample', 'prune', 'textures', 'meshopt']);
    expect(names({ preset: 'balanced', textures: 'none' })).toEqual(['dedup', 'palette', 'weld', 'resample', 'prune', 'quantize']);
    expect(names({ preset: 'aggressive', steps: { simplify: false } })).not.toContain('simplify');
    expect(planSteps({ ...base, compress: 'meshopt' }).find((s) => s.name === 'meshopt')!.options).toEqual({ level: 'medium' });
    expect(STEP_NAMES).toHaveLength(12);
  });

  /**
   * Ruling R100: `weld` is a lossy-preset step, not a `safe` one. It changes no drawn value, but welding the Fox's
   * non-indexed primitive into an indexed one moves pixels on WebGPU (see `test/e2e/cli.spec.ts`), so `safe` keeps
   * only steps measured at 0 in every view on both backends. Pinned here so a future preset edit cannot quietly put
   * it back: `safe` is the one preset without it, and `--weld` is still the way to ask for it anywhere.
   */
  it('keeps weld out of safe and in the lossy presets, with --weld able to add it back in pipeline order', () => {
    expect(names({})).not.toContain('weld');
    expect(names({ preset: 'balanced' })).toContain('weld');
    expect(names({ preset: 'aggressive' })).toContain('weld');
    expect(names({ steps: { weld: true } })).toEqual(['dedup', 'palette', 'weld', 'resample', 'prune']);
    expect(names({ preset: 'balanced', steps: { weld: false } })).toEqual(['dedup', 'palette', 'resample', 'prune', 'textures', 'quantize']);
  });
});
