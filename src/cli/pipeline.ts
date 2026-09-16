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

/**
 * `weld` is deliberately not in `safe` (Ruling R100). It merges only bitwise-identical vertices, so it changes no
 * drawn value — the drawn triangle stream stays order- and value-identical — yet welding the Fox reproducibly moves
 * up to 0.014 % of its pixels on WebGPU, where the same run reports 0 on WebGL2. Measured the same way, weld also
 * moves pixels on PotOfCoals (0.004 %) and VirtualCity (0.011 %), both fully indexed and carrying normals, so the
 * effect follows the asset rather than either structural property and the mechanism is not established. A step that
 * can move a pixel does not belong in the preset that promises none, so weld rides with the lossy steps in
 * `balanced` and `aggressive`; `--weld` adds it back to any preset.
 *
 * `safe` is not bit-exact yet either, and this move does not make it so: `resample` takes glTF-Transform's default
 * `tolerance: 1e-4` (see `applySteps` in transform.ts), which drops keyframes within that distance and shifts the
 * Fox's posed silhouette by 1-5 pixels of 921,600 on *both* backends — under the reported figure's three-decimal
 * rounding on WebGL2, 0.001 % on one WebGPU view. `resample({ tolerance: 0 })` or a second preset move would close
 * it; see `test/e2e/cli.spec.ts` and the task-42 report.
 *
 * Measured cost of this move over 66 readable corpus assets: weld merges vertices on 11 and shrinks the file by
 * more than 0.5 % on 9, median 0.00 %.
 */
const PRESET_STEPS: Record<Preset, StepName[]> = {
  safe: ['dedup', 'palette', 'resample', 'prune'],
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
