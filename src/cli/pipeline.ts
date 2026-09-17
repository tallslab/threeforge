import type { OptimizeInput, Preset, StepName, TextureFormat } from './types.js';

/** Pipeline order: glTF-Transform's own `optimize` order; meshopt quantizes itself so it replaces quantize. */
export const STEP_NAMES: readonly StepName[] = ['dedup', 'instance', 'palette', 'flatten', 'join', 'weld', 'simplify', 'resample', 'prune', 'textures', 'quantize', 'meshopt'];
export const PRESETS: readonly Preset[] = ['safe', 'balanced', 'aggressive'];

export type StepOptions =
  | { ratio: number; error: number }
  | { format: TextureFormat; size: number | null; quality: number }
  | { level: 'medium' | 'high' }
  | { min: number }
  | { tolerance: number }
  | Record<string, never>;

export interface Step {
  name: StepName;
  options: StepOptions;
}

/**
 * `weld` is not in `safe`: it merges only bitwise-identical vertices, yet it reproducibly moves up to 0.014 % of the
 * Fox's pixels on WebGPU (0 on WebGL2), and the mechanism is not established. `resample` is not in `safe` either: at
 * `tolerance: 0` it is pixel-exact but keeps every keyframe that is not an exact duplicate, so Xbot grows 1.248 %.
 * Both ride with the lossy steps in `balanced` and `aggressive`; `--weld` and `--resample` add either back to any
 * preset. `safe` is held to 0 changed pixels in every view on both backends for the Fox and the Buggy
 * (`test/e2e/cli.spec.ts`, `--parity 0`). `palette` is in `safe` unswept: once 5 or more untextured materials differ
 * it writes their factors into palette textures and adds a float UV attribute to every primitive it merges.
 */
const PRESET_STEPS: Record<Preset, StepName[]> = {
  safe: ['dedup', 'palette', 'prune'],
  balanced: ['dedup', 'palette', 'weld', 'resample', 'prune', 'textures', 'quantize'],
  aggressive: ['dedup', 'palette', 'weld', 'simplify', 'resample', 'prune', 'textures', 'quantize'],
};
/**
 * glTF-Transform's `resample` default tolerance is 1e-4, not 0, and it moved the Fox's posed silhouette by 1-5 pixels
 * of 921,600 on both backends. An explicit `--resample` runs lossless at 0 inside `safe`; the lossy presets keep the default.
 */
const PRESET_RESAMPLE_TOLERANCE: Record<Preset, number> = { safe: 0, balanced: 1e-4, aggressive: 1e-4 };
const PRESET_SIMPLIFY: Record<Preset, number | null> = { safe: null, balanced: null, aggressive: 0.5 };
const PRESET_TEXTURE_SIZE: Record<Preset, number | null> = { safe: null, balanced: 2048, aggressive: 1024 };

/** Presets and flags → the ordered steps to run. Pure. */
export function planSteps(input: OptimizeInput): Step[] {
  const enabled = new Set<StepName>(PRESET_STEPS[input.preset]);
  if (input.simplify !== null) enabled.add('simplify');
  if (input.textures === 'none') enabled.delete('textures');
  else if (input.textures !== null) enabled.add('textures');
  if (input.compress === 'meshopt') enabled.add('meshopt');
  for (const name of STEP_NAMES) {
    const override = input.steps[name];
    if (override === true) enabled.add(name);
    else if (override === false) enabled.delete(name);
  }
  if (enabled.has('join')) enabled.add('flatten');
  if (enabled.has('meshopt')) enabled.delete('quantize');
  const ratio = input.simplify ?? PRESET_SIMPLIFY[input.preset] ?? 0.5;
  const size = input.textureSize ?? PRESET_TEXTURE_SIZE[input.preset];
  const format: TextureFormat = input.textures === null || input.textures === 'none' ? 'webp' : input.textures;
  const optionsFor = (name: StepName): StepOptions => {
    switch (name) {
      case 'simplify':
        return { ratio, error: input.simplifyError };
      case 'textures':
        return { format, size, quality: input.textureQuality };
      case 'meshopt':
        return { level: 'medium' };
      case 'instance':
        return { min: 2 };
      case 'palette':
        return { min: 5 };
      case 'resample':
        return { tolerance: PRESET_RESAMPLE_TOLERANCE[input.preset] };
      default:
        return {};
    }
  };
  return STEP_NAMES.filter((name) => enabled.has(name)).map((name) => ({ name, options: optionsFor(name) }));
}
