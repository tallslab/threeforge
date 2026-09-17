import { UsageError } from './errors.js';
import { PRESETS, STEP_NAMES } from './pipeline.js';
import type {
  AnalyzeInput,
  Backend,
  BakeChoice,
  InspectInput,
  OptimizeInput,
  TextureFormat,
  TierChoice,
} from './types.js';

export type SchemaChoice = 'snapshot' | 'analyze' | 'inspect' | 'optimize' | 'all';

/** The commands that render and take a run input (`validateInput`). */
type RunCommandName = 'analyze' | 'inspect' | 'optimize';

const BACKENDS: readonly Backend[] = ['webgl2', 'webgpu'];
const TIERS: readonly TierChoice[] = ['auto', 'desktop', 'phone-mid', 'phone-low'];
const SCHEMAS: readonly SchemaChoice[] = ['snapshot', 'analyze', 'inspect', 'optimize', 'all'];
const BAKES: readonly BakeChoice[] = ['off', 'on', 'buried'];
const COMPRESS: readonly OptimizeInput['compress'][] = ['none', 'meshopt'];
const TEXTURES: readonly (TextureFormat | 'none')[] = ['webp', 'avif', 'none'];

/** Allowed values of every enumerated input field, shared by the CLI parser and the MCP server's schemas. */
export const CHOICES = {
  backend: BACKENDS,
  tier: TIERS,
  bake: BAKES,
  preset: PRESETS,
  compress: COMPRESS,
  textures: TEXTURES,
  schema: SCHEMAS,
} as const;

/** A numeric input bound. `min` is inclusive unless `minExclusive`; `max` is inclusive and absent when unbounded. */
interface NumberRange {
  readonly min: number;
  readonly minExclusive?: boolean;
  readonly max?: number;
  readonly integer: boolean;
}

export type RangeField =
  | 'budget'
  | 'frames'
  | 'timeout'
  | 'views'
  | 'parity'
  | 'simplify'
  | 'simplifyError'
  | 'textureSize'
  | 'textureQuality';

/**
 * The default `--parity` of `analyze` and `optimize` (and of the MCP `analyze_asset` and `optimize_asset`): the percent
 * of pixels allowed to change. Both commands judge it through `parityOf` (`src/cli/analyze.ts`): a threshold of 0 on
 * the raw changed-pixel count of every view, any other on the percentage.
 */
export const DEFAULT_PARITY = 0.5;

/**
 * Bounds of every numeric run input, keyed by input field. The CLI flag is the kebab-case name (`textureSize` →
 * `--texture-size`). `timeout` stops at 2^31 - 1 ms because a longer Node timer fires immediately; `views` stops at
 * 64 because each view renders and screenshots twice and nothing bounds their total time.
 */
export const RANGES: Readonly<Record<RangeField, NumberRange>> = {
  budget: { min: 0, integer: true },
  frames: { min: 1, integer: true },
  timeout: { min: 1000, max: 2_147_483_647, integer: true },
  views: { min: 0, max: 64, integer: true },
  parity: { min: 0, max: 100, integer: false },
  simplify: { min: 0, minExclusive: true, max: 1, integer: false },
  simplifyError: { min: 0, max: 1, integer: false },
  textureSize: { min: 1, max: 16_384, integer: true },
  textureQuality: { min: 1, max: 100, integer: true },
};

export const show = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value) : String(value);

const kebab = (field: string): string => field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** `an integer ≥ 1`, `a number from 0 to 100`, `a number in (0, 1]`. */
export function describeRange(range: NumberRange): string {
  const kind = range.integer ? 'an integer' : 'a number';
  if (range.max === undefined) return `${kind} ${range.minExclusive ? '>' : '≥'} ${range.min}`;
  return range.minExclusive ? `${kind} in (${range.min}, ${range.max}]` : `${kind} from ${range.min} to ${range.max}`;
}

interface ValidateOptions {
  /** Name fields in messages as input keys (`frames`, the default, for MCP and programmatic callers) or as CLI flags (`--frames`). */
  readonly names?: 'fields' | 'flags';
}

export function validateInput(command: 'analyze', input: AnalyzeInput, options?: ValidateOptions): AnalyzeInput;
export function validateInput(command: 'inspect', input: InspectInput, options?: ValidateOptions): InspectInput;
export function validateInput(command: 'optimize', input: OptimizeInput, options?: ValidateOptions): OptimizeInput;
export function validateInput(
  command: RunCommandName,
  input: AnalyzeInput | InspectInput | OptimizeInput,
  options?: ValidateOptions,
): AnalyzeInput | InspectInput | OptimizeInput;
/**
 * Checks a run input against `RANGES`, `CHOICES` and the cross-field rules (inspect takes no tier; optimize's budget
 * needs verification). Returns the input unchanged; throws `UsageError` (exit code 2) naming the first bad field.
 * The CLI parser and the MCP server both call it, so a bound is enforced once for both.
 */
export function validateInput(
  command: RunCommandName,
  input: AnalyzeInput | InspectInput | OptimizeInput,
  options: ValidateOptions = {},
): AnalyzeInput | InspectInput | OptimizeInput {
  const flags = options.names === 'flags';
  const label = (field: string): string => (flags ? `--${kebab(field)}` : field);
  const record = input as unknown as Record<string, unknown>;
  const fail = (field: string, expected: string): never => {
    throw new UsageError(`${label(field)} must be ${expected} (got ${show(record[field])})`);
  };
  const text = (field: string): void => {
    if (typeof record[field] !== 'string' || record[field] === '') fail(field, 'a non-empty string');
  };
  const bool = (field: string): void => {
    if (typeof record[field] !== 'boolean') fail(field, 'true or false');
  };
  const oneOf = (field: string, allowed: readonly unknown[]): void => {
    if (!allowed.includes(record[field])) fail(field, `one of ${allowed.join(', ')}`);
  };
  const inRange = (field: RangeField, nullable = false): void => {
    const value = record[field];
    if (nullable && value === null) return;
    const range = RANGES[field];
    const ok =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (!range.integer || Number.isInteger(value)) &&
      (range.minExclusive ? value > range.min : value >= range.min) &&
      (range.max === undefined || value <= range.max);
    if (!ok) fail(field, describeRange(range) + (nullable && !flags ? ' or null' : ''));
  };

  text(command === 'inspect' ? 'url' : 'file');
  oneOf('backend', BACKENDS);
  if (command === 'inspect') {
    if (record.tier !== 'auto')
      throw new UsageError(
        `${label('tier')} is not accepted by inspect: the app measures itself at the tier its own ledger detects (got ${show(record.tier)})`,
      );
  } else oneOf('tier', TIERS);
  inRange('budget', true);
  inRange('frames');
  bool('compile');
  inRange('timeout');
  bool('headed');
  if (command === 'analyze') {
    oneOf('bake', BAKES);
    inRange('views');
    // Optional on `AnalyzeInput` (a programmatic caller written before `--parity` gets the default); the CLI and MCP always set it.
    if (record.parity !== undefined) inRange('parity');
  }
  if (command === 'optimize') {
    if (record.out !== null && (typeof record.out !== 'string' || record.out === ''))
      fail('out', 'a non-empty path or null');
    oneOf('preset', PRESETS);
    const steps = record.steps;
    if (typeof steps !== 'object' || steps === null || Array.isArray(steps)) fail('steps', 'an object of step toggles');
    for (const [name, toggle] of Object.entries(steps as Record<string, unknown>)) {
      if (!(STEP_NAMES as readonly string[]).includes(name))
        throw new UsageError(`${flags ? `--${name}` : `steps.${name}`} is not a step; steps: ${STEP_NAMES.join(', ')}`);
      if (typeof toggle !== 'boolean')
        throw new UsageError(`${flags ? `--${name}` : `steps.${name}`} must be true or false (got ${show(toggle)})`);
    }
    inRange('simplify', true);
    inRange('simplifyError');
    oneOf('compress', COMPRESS);
    if (record.textures !== null) oneOf('textures', TEXTURES);
    inRange('textureSize', true);
    inRange('textureQuality');
    bool('verify');
    inRange('parity');
    inRange('views');
    if (record.budget !== null && record.verify === false)
      throw new UsageError(
        `${label('budget')} needs verification: it is judged on the optimized file's compiled render, which ${flags ? '--no-verify' : 'verify: false'} skips`,
      );
  }
  return input;
}
