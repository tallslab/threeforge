import type { OptimizeInput, Preset, StepName, TextureFormat } from './types.js';

/** Pipeline order: glTF-Transform's own `optimize` order; meshopt quantizes itself so it replaces quantize. */
export const STEP_NAMES: readonly StepName[] = ['dedup', 'instance', 'palette', 'flatten', 'join', 'weld', 'simplify', 'resample', 'prune', 'textures', 'quantize', 'meshopt'];
export const PRESETS: readonly Preset[] = ['safe', 'balanced', 'aggressive'];

export type StepOptions =
  | { ratio: number; error: number }
  | { format: TextureFormat; size: number | null; quality: number }
  | { level: 'medium' | 'high' }
  | { min: number }
  | Record<string, never>;

export interface Step {
  name: StepName;
  options: StepOptions;
}

const PRESET_STEPS: Record<Preset, StepName[]> = {
  safe: ['dedup', 'palette', 'weld', 'resample', 'prune'],
  balanced: ['dedup', 'palette', 'weld', 'resample', 'prune', 'textures', 'quantize'],
  aggressive: ['dedup', 'palette', 'weld', 'simplify', 'resample', 'prune', 'textures', 'quantize'],
};
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
      default:
        return {};
    }
  };
  return STEP_NAMES.filter((name) => enabled.has(name)).map((name) => ({ name, options: optionsFor(name) }));
}
