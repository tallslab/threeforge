import { describe, expect, it } from 'vitest';
import { PRESETS, planSteps, STEP_NAMES } from '../../src/cli/pipeline.js';
import type { OptimizeInput } from '../../src/cli/types.js';

const base: OptimizeInput = {
  file: 'a.glb',
  out: null,
  preset: 'safe',
  steps: {},
  simplify: null,
  simplifyError: 0.001,
  compress: 'none',
  textures: null,
  textureSize: null,
  textureQuality: 85,
  verify: true,
  parity: 0.5,
  views: 2,
  backend: 'webgl2',
  tier: 'auto',
  budget: null,
  frames: 30,
  compile: true,
  timeout: 60000,
  headed: false,
};
const names = (input: Partial<OptimizeInput>) => planSteps({ ...base, ...input }).map((s) => s.name);

describe('planSteps', () => {
  it('lists the presets in pipeline order', () => {
    expect(PRESETS).toEqual(['safe', 'balanced', 'aggressive']);
    expect(names({})).toEqual(['dedup', 'palette', 'prune']);
    expect(names({ preset: 'balanced' })).toEqual([
      'dedup',
      'palette',
      'weld',
      'resample',
      'prune',
      'textures',
      'quantize',
    ]);
    expect(names({ preset: 'aggressive' })).toEqual([
      'dedup',
      'palette',
      'weld',
      'simplify',
      'resample',
      'prune',
      'textures',
      'quantize',
    ]);
  });

  it('carries the preset options and the explicit ones', () => {
    const aggressive = planSteps({ ...base, preset: 'aggressive' });
    expect(aggressive.find((s) => s.name === 'simplify')!.options).toEqual({ ratio: 0.5, error: 0.001 });
    expect(aggressive.find((s) => s.name === 'textures')!.options).toEqual({ format: 'webp', size: 1024, quality: 85 });
    expect(planSteps({ ...base, preset: 'balanced' }).find((s) => s.name === 'textures')!.options).toEqual({
      format: 'webp',
      size: 2048,
      quality: 85,
    });
    expect(
      planSteps({ ...base, simplify: 0.3, simplifyError: 0.01 }).find((s) => s.name === 'simplify')!.options,
    ).toEqual({ ratio: 0.3, error: 0.01 });
    expect(
      planSteps({ ...base, textures: 'avif', textureSize: 512, textureQuality: 70 }).find((s) => s.name === 'textures')!
        .options,
    ).toEqual({ format: 'avif', size: 512, quality: 70 });
    expect(planSteps({ ...base, steps: { textures: true } }).find((s) => s.name === 'textures')!.options).toEqual({
      format: 'webp',
      size: null,
      quality: 85,
    });
  });

  it('applies --no-<step> and --<step> overrides with their implied steps', () => {
    // join implies flatten; meshopt replaces quantize; textures: none.
    expect(names({ steps: { palette: false, resample: false } })).toEqual(['dedup', 'prune']);
    expect(names({ steps: { quantize: true, instance: true } })).toEqual([
      'dedup',
      'instance',
      'palette',
      'prune',
      'quantize',
    ]);
    expect(names({ steps: { join: true } })).toEqual(['dedup', 'palette', 'flatten', 'join', 'prune']);
    expect(names({ preset: 'balanced', compress: 'meshopt' })).toEqual([
      'dedup',
      'palette',
      'weld',
      'resample',
      'prune',
      'textures',
      'meshopt',
    ]);
    expect(names({ preset: 'balanced', textures: 'none' })).toEqual([
      'dedup',
      'palette',
      'weld',
      'resample',
      'prune',
      'quantize',
    ]);
    expect(names({ preset: 'aggressive', steps: { simplify: false } })).not.toContain('simplify');
    expect(planSteps({ ...base, compress: 'meshopt' }).find((s) => s.name === 'meshopt')!.options).toEqual({
      level: 'medium',
    });
    expect(STEP_NAMES).toHaveLength(12);
  });

  /**
   * `weld` is a lossy-preset step, not a `safe` one. It changes no drawn value, yet it moves pixels on
   * WebGPU — on the Fox, and also on PotOfCoals and VirtualCity, which are fully indexed and carry normals — so the
   * preset held to zero changed pixels at `--parity 0` on the Fox and the Buggy must not run it (see
   * `test/e2e/cli.spec.ts`). Moving weld alone did not bring `safe` to zero: `resample` then ran there at
   * glTF-Transform's default 1e-4 keyframe tolerance, which shifts a few silhouette pixels on both backends (its tolerance
   * is now 0 and it too left `safe`). Pinned here so a future preset edit cannot quietly put weld back: `safe` is
   * the one preset without it, and `--weld` is still the way to ask for it anywhere.
   */
  it('keeps weld out of safe and in the lossy presets, --weld adding it in order', () => {
    expect(names({})).not.toContain('weld');
    expect(names({ preset: 'balanced' })).toContain('weld');
    expect(names({ preset: 'aggressive' })).toContain('weld');
    expect(names({ steps: { weld: true } })).toEqual(['dedup', 'palette', 'weld', 'prune']);
    expect(names({ preset: 'balanced', steps: { weld: false } })).toEqual([
      'dedup',
      'palette',
      'resample',
      'prune',
      'textures',
      'quantize',
    ]);
  });

  /**
   * `resample` left `safe` too, for the opposite reason to weld's. At `tolerance: 0` it is pixel-exact,
   * but it keeps every keyframe that is not an exact duplicate, so it can grow a file — swept over the 79 readable
   * corpus assets the median is 0.000 % but Xbot grows 1.248 %, past the 0.5 % bar the rule set. It earns its place
   * in the lossy presets (Soldier -18.9 %, BrainStem -14.9 %). `safe` is now dedup, palette and prune; `palette` was
   * never swept for size on its own and adds a UV attribute to the primitives it merges (see `src/cli/pipeline.ts`).
   */
  it('keeps resample out of safe and in the lossy presets, with --resample able to add it back', () => {
    expect(names({})).not.toContain('resample');
    expect(names({ preset: 'balanced' })).toContain('resample');
    expect(names({ preset: 'aggressive' })).toContain('resample');
    expect(names({ steps: { resample: true } })).toEqual(['dedup', 'palette', 'resample', 'prune']);
  });

  /**
   * glTF-Transform's `resample` defaults to `tolerance: 1e-4`, which drops keyframes that merely sit
   * near the value interpolated from their neighbours — lossy, whatever its docstring says, and enough to move the
   * posed silhouette by a few pixels. `safe` therefore asks for tolerance 0 explicitly. Pinned per preset because
   * the value is the entire fix: passing no options at all would silently restore the lossy default.
   */
  it('resamples at tolerance 0 under safe and at 1e-4 under the lossy presets', () => {
    const resampleOptions = (preset: OptimizeInput['preset'], steps: OptimizeInput['steps'] = {}): unknown =>
      planSteps({ ...base, preset, steps }).find((s) => s.name === 'resample')!.options;
    // `safe` no longer runs it, but `--resample` under `safe` must still be the lossless one.
    expect(resampleOptions('safe', { resample: true })).toEqual({ tolerance: 0 });
    expect(resampleOptions('balanced')).toEqual({ tolerance: 1e-4 });
    expect(resampleOptions('aggressive')).toEqual({ tolerance: 1e-4 });
  });
});
