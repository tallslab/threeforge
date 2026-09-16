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
 * `weld` is deliberately not in `safe` (Ruling R100). It merges only bitwise-identical vertices, so it changes no
 * drawn value — the drawn triangle stream stays order- and value-identical — yet welding the Fox reproducibly moves
 * up to 0.014 % of its pixels on WebGPU, where the same run reports 0 on WebGL2. Measured the same way, weld also
 * moves pixels on PotOfCoals (0.004 %) and VirtualCity (0.011 %), both fully indexed and carrying normals, so the
 * effect follows the asset rather than either structural property and the mechanism is not established. A step that
 * can move a pixel does not belong in the preset that promises none, so weld rides with the lossy steps in
 * `balanced` and `aggressive`; `--weld` adds it back to any preset.
 *
 * Measured cost of this move over 66 readable corpus assets: weld merges vertices on 11 and shrinks the file by
 * more than 0.5 % on 9, median 0.00 %.
 *
 * `resample` is not in `safe` either, for the opposite reason (Ruling R105). At `tolerance: 0` it is pixel-exact,
 * but it then keeps every keyframe that is not an exact duplicate, which can make a file *bigger*: swept over the
 * 79 readable corpus assets against a re-serialized baseline, the median asset is 0.000 % but Xbot grows 1.248 %
 * and the Fox 0.100 %. The rule applied was "keep it only if the median is <= 0 and nothing grows by more than
 * 0.5 %"; Xbot fails the second half. It stays in `balanced` and `aggressive` at the lossy default, where it earns
 * its place — Soldier -18.9 %, BrainStem -14.9 %, VirtualCity -9.5 % — and `--resample` adds it back to `safe`
 * losslessly. `safe` is therefore the steps that are pixel-exact *and* never cost bytes themselves. That is a claim
 * about the steps, not about the output size: glTF-Transform re-serializes the container either way, which on the
 * Fox is +0.86 % before any step runs (and on the Buggy, -27 %). A preset cannot promise a smaller file; it can
 * promise not to be the reason the file grew.
 */
const PRESET_STEPS: Record<Preset, StepName[]> = {
  safe: ['dedup', 'palette', 'prune'],
  balanced: ['dedup', 'palette', 'weld', 'resample', 'prune', 'textures', 'quantize'],
  aggressive: ['dedup', 'palette', 'weld', 'simplify', 'resample', 'prune', 'textures', 'quantize'],
};
/**
 * `resample` drops a keyframe when it sits within `tolerance` of the value interpolated from its neighbours.
 * glTF-Transform's default is **1e-4, not 0** (`RESAMPLE_DEFAULTS`, `@gltf-transform/functions`), so the default is
 * lossy however its docstring reads: on the Fox it shifted the posed silhouette by 1-5 pixels of 921,600 on *both*
 * backends (Ruling R104). Setting the tolerance to 0 fixed that but removed the step's reason to be in `safe` at
 * all, so R105 measured it and moved it out (see `PRESET_STEPS`). The map stays because `--resample` may still be
 * asked for explicitly: inside `safe` it then runs lossless, and in the lossy presets it keeps the default.
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
