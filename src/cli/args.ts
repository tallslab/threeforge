import { VERSION } from '../version.js';
import { UsageError } from './errors.js';
import { PRESETS, STEP_NAMES } from './pipeline.js';
import type {
  AnalyzeInput,
  Backend,
  BakeChoice,
  InspectInput,
  OptimizeInput,
  StepName,
  TextureFormat,
  TierChoice,
} from './types.js';

export { UsageError };

export type SchemaChoice = 'snapshot' | 'analyze' | 'inspect' | 'optimize' | 'all';

export type Command =
  | { name: 'help' }
  | { name: 'analyze'; input: AnalyzeInput; json: boolean }
  | { name: 'inspect'; input: InspectInput; json: boolean }
  | { name: 'optimize'; input: OptimizeInput; json: boolean }
  | { name: 'explain'; code: string | null; all: boolean; json: boolean }
  | { name: 'schema'; which: SchemaChoice; json: boolean }
  | { name: 'mcp' }
  | { name: 'decoders'; dir: string };

export const COMMANDS = ['analyze', 'inspect', 'optimize', 'explain', 'schema', 'mcp', 'decoders'] as const;
export type CommandName = (typeof COMMANDS)[number];
/** The commands that render and take a run input (`validateInput`). */
export type RunCommandName = 'analyze' | 'inspect' | 'optimize';

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
export interface NumberRange {
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

/** `--parity`'s sentence on what 0 means, shared word for word by every command that takes the flag. */
const PARITY_ZERO =
  'A threshold of 0 means zero: it is judged on the raw changed-pixel count of every view, not the rounded percent.';

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

export type FlagKind = 'boolean' | 'value' | 'optional-value';

/** One `--flag` of a command. */
export interface FlagSpec {
  /** Without the leading dashes. */
  readonly name: string;
  /** `boolean` never takes a value; `value` always does (`--f v` or `--f=v`); `optional-value` takes one only after `=` or when the next argument is a valid value. */
  readonly kind: FlagKind;
  /** Also accepted as `--no-<name>`, which sets it off. */
  readonly negatable?: boolean;
  /** On by default: the usage shows `--no-<name>`. */
  readonly defaultOn?: boolean;
  /** Value placeholder in the usage (`N`, `webgl2|webgpu`). */
  readonly value?: string;
  /** Allowed values of a value or optional-value flag. */
  readonly choices?: readonly string[];
  /** The value is a number (an optional-value flag then takes the next argument only when it is one). */
  readonly numeric?: boolean;
  /** Flags of one group print once in the usage line as this text (the optimize step toggles). */
  readonly group?: string;
  readonly description: string;
}

export interface PositionalSpec {
  readonly name: string;
  /** As printed in the usage: `<file.glb|.gltf>`. */
  readonly usage: string;
  readonly required: boolean;
}

export interface CommandSpec {
  readonly name: CommandName;
  readonly positionals: readonly PositionalSpec[];
  readonly flags: readonly FlagSpec[];
  /** One line for the usage text. */
  readonly summary: string;
  /** The message when a required positional is missing. */
  readonly missing?: string;
  /** Why this command refuses a flag other commands take. */
  readonly refuses?: Readonly<Record<string, string>>;
}

const JSON_FLAG: FlagSpec = {
  name: 'json',
  kind: 'boolean',
  description:
    'Print JSON on stdout. `analyze`, `inspect` and `optimize` print the document and move the human summary to stderr; `schema` prints JSON either way.',
};
const BACKEND: FlagSpec = {
  name: 'backend',
  kind: 'value',
  value: 'webgl2|webgpu',
  choices: BACKENDS,
  description: 'Renderer backend to measure on (default `webgl2`).',
};
const TIER: FlagSpec = {
  name: 'tier',
  kind: 'value',
  value: 'auto|desktop|phone-mid|phone-low',
  choices: TIERS,
  description: 'Device tier for budgets and hints (default `auto`: detected from the GPU and device).',
};
const BUDGET: FlagSpec = {
  name: 'budget',
  kind: 'value',
  value: 'N',
  numeric: true,
  description: 'Fail the verdict (exit 1) above N scene submissions after compiling (an integer ≥ 0).',
};
const FRAMES: FlagSpec = {
  name: 'frames',
  kind: 'value',
  value: 'N',
  numeric: true,
  description: 'Frames to measure; costs are medians (an integer ≥ 1, default 30).',
};
const COMPILE: FlagSpec = {
  name: 'compile',
  kind: 'boolean',
  negatable: true,
  defaultOn: true,
  description:
    'Compile (batch) the scene and measure again. On by default; `--no-compile` measures the scene as loaded.',
};
const TIMEOUT: FlagSpec = {
  name: 'timeout',
  kind: 'value',
  value: 'ms',
  numeric: true,
  description:
    'Bound in milliseconds on each page step: the load, every evaluate, the whole N-frame measurement, `compile()` (an integer from 1000 to 2147483647, default 60000). A step over it exits 4.',
};
const HEADED: FlagSpec = {
  name: 'headed',
  kind: 'boolean',
  description: 'Show the browser window instead of running headless (debugging).',
};

const RUN_FLAGS = [BACKEND, TIER, BUDGET, FRAMES, COMPILE, TIMEOUT, HEADED] as const;

const STEP_DESCRIPTIONS: Record<Exclude<StepName, 'simplify' | 'textures'>, string> = {
  dedup: 'identical accessors, meshes, materials and textures become one (in every preset)',
  instance: 'repeated meshes become `EXT_mesh_gpu_instancing` (never in a preset: changes the node graph)',
  palette: 'materials that differ only by factors become one material sampling a palette texture (in every preset)',
  flatten: 'flatten the node hierarchy',
  join: 'meshes sharing a material merge, implies flatten (never in a preset: changes the node graph)',
  weld: 'merge exact duplicate vertices (`balanced`, `aggressive`)',
  resample: 'drop redundant animation keyframes (`balanced`, `aggressive`; lossless when added to `safe`)',
  prune: 'remove unused properties (in every preset)',
  quantize: '`KHR_mesh_quantization` (`balanced`, `aggressive`)',
  meshopt:
    '`EXT_meshopt_compression`, replaces quantize; the app needs `loader.setMeshoptDecoder` (same as `--compress meshopt`)',
};
const STEP_GROUP = '--no-<step>|--<step>';
const STEP_FLAGS: FlagSpec[] = STEP_NAMES.filter(
  (name): name is keyof typeof STEP_DESCRIPTIONS => name !== 'simplify' && name !== 'textures',
).map((name) => ({
  name,
  kind: 'boolean',
  negatable: true,
  group: STEP_GROUP,
  description: `Add (\`--${name}\`) or remove (\`--no-${name}\`) the ${name} step: ${STEP_DESCRIPTIONS[name]}.`,
}));

/** Every command's positionals and flags. The parser, the usage text and the AGENTS.md command table come from here. */
export const COMMAND_SPECS: Readonly<Record<CommandName, CommandSpec>> = {
  analyze: {
    name: 'analyze',
    positionals: [{ name: 'file', usage: '<file.glb|.gltf>', required: true }],
    flags: [
      ...RUN_FLAGS,
      {
        name: 'bake',
        kind: 'boolean',
        description:
          'Bake each finished static group into one mesh (seams and duplicated faces removed, vertices welded); check with `--views`.',
      },
      {
        name: 'bake-buried',
        kind: 'boolean',
        description: 'Like `--bake`, and also remove faces with solid geometry within 0.1 units in front of them.',
      },
      {
        name: 'views',
        kind: 'value',
        value: 'N',
        numeric: true,
        description:
          'Extra orbit views for pixel parity on top of the default framing (an integer from 0 to 64, default 0).',
      },
      {
        name: 'parity',
        kind: 'value',
        value: 'pct',
        numeric: true,
        description: `Allowed percent of changed pixels between the render before and after compiling (and baking), from 0 to 100 (default ${DEFAULT_PARITY}). ${PARITY_ZERO}`,
      },
      JSON_FLAG,
    ],
    summary: 'render an asset headlessly, measure, compile, measure again, compare pixels, judge',
    missing: 'analyze needs a file: threeforge analyze scene.glb',
  },
  inspect: {
    name: 'inspect',
    positionals: [{ name: 'url', usage: '<url>', required: true }],
    flags: [BACKEND, BUDGET, FRAMES, COMPILE, TIMEOUT, HEADED, JSON_FLAG],
    summary: 'drive a running app that called exposeToAgents(); same document without asset facts and parity',
    missing: 'inspect needs a url: threeforge inspect http://localhost:5173',
    refuses: { tier: 'the app measures itself at the tier its own ledger detects' },
  },
  optimize: {
    name: 'optimize',
    positionals: [{ name: 'file', usage: '<file.glb|.gltf>', required: true }],
    flags: [
      {
        name: 'out',
        kind: 'value',
        value: 'out.glb',
        description:
          'Output path ending in `.glb` or `.gltf` (default `<name>.forge.glb` next to the input; never the input file, not even through a link).',
      },
      {
        name: 'preset',
        kind: 'value',
        value: 'safe|balanced|aggressive',
        choices: PRESETS,
        description:
          'Step preset (default `safe`: dedup, palette, prune; measured at 0 changed pixels, no channel moving by more than 24 of 255, on the Fox and the Buggy; `palette` stores merged material factors in 8-bit palette textures and adds a UV attribute to every primitive it merges, so it can add bytes: `--no-palette` drops it).',
      },
      ...STEP_FLAGS,
      {
        name: 'simplify',
        kind: 'optional-value',
        negatable: true,
        numeric: true,
        value: 'ratio',
        description:
          'Add the simplify step with this ratio of vertices to keep, in (0, 1] (bare: 0.5); `--no-simplify` removes it from a preset.',
      },
      {
        name: 'simplify-error',
        kind: 'value',
        value: 'e',
        numeric: true,
        description: 'Simplify error limit as a fraction of the mesh radius, from 0 to 1 (default 0.001).',
      },
      {
        name: 'compress',
        kind: 'value',
        value: 'none|meshopt',
        choices: COMPRESS,
        description:
          '`meshopt` adds `EXT_meshopt_compression` (the app needs `loader.setMeshoptDecoder`); default `none`.',
      },
      {
        name: 'textures',
        kind: 'optional-value',
        negatable: true,
        value: 'webp|avif|none',
        choices: TEXTURES,
        description:
          'Add the texture step with this format (needs `sharp`; bare: `webp`); `none` or `--no-textures` removes it from a preset.',
      },
      {
        name: 'texture-size',
        kind: 'value',
        value: 'N',
        numeric: true,
        description:
          "Longest texture side in pixels (an integer from 1 to 16384; default: the preset's size, no resize outside presets).",
      },
      {
        name: 'texture-quality',
        kind: 'value',
        value: 'Q',
        numeric: true,
        description: 'Texture encoder quality (an integer from 1 to 100, default 85).',
      },
      {
        name: 'verify',
        kind: 'boolean',
        negatable: true,
        defaultOn: true,
        description:
          'Render the original and the optimized file and compare pixels. On by default; `--no-verify` runs without a browser (and cannot take `--budget`).',
      },
      {
        name: 'parity',
        kind: 'value',
        value: 'pct',
        numeric: true,
        description: `Allowed percent of changed pixels between the original and the optimized file, each rendered before compiling, from 0 to 100 (default ${DEFAULT_PARITY}). ${PARITY_ZERO} It governs the original-versus-optimized comparison only; each file's own compile check runs at ${DEFAULT_PARITY} whatever this is, and is reported in \`verify.optimized.parity\` (which fails the verdict) and \`verify.original.parity\` (reported only). Read those, or run \`analyze --parity 0\`, when compile exactness is the question.`,
      },
      {
        name: 'views',
        kind: 'value',
        value: 'N',
        numeric: true,
        description: 'Extra orbit views for the comparison (an integer from 0 to 64, default 2).',
      },
      {
        ...BUDGET,
        description:
          'Fail the verdict (exit 1) when the optimized file compiles to more than N scene submissions (an integer ≥ 0); needs verification, so not with `--no-verify`.',
      },
      ...RUN_FLAGS.filter((flag) => flag !== BUDGET),
      JSON_FLAG,
    ],
    summary: 'rewrite a glTF with glTF-Transform, verify both files by pixels, report steps and requirements',
    missing: 'optimize needs a file: threeforge optimize scene.glb',
  },
  explain: {
    name: 'explain',
    positionals: [{ name: 'code', usage: '<hint-code>', required: false }],
    flags: [{ name: 'all', kind: 'boolean', description: 'Every remedy instead of one hint code.' }, JSON_FLAG],
    summary: 'what a hint code means and how to fix it (a code or --all)',
  },
  schema: {
    name: 'schema',
    positionals: [{ name: 'which', usage: 'snapshot|analyze|inspect|optimize|all', required: false }],
    flags: [JSON_FLAG],
    summary: 'JSON Schemas of what the commands print',
  },
  mcp: {
    name: 'mcp',
    positionals: [],
    flags: [],
    summary: 'stdio MCP server (analyze_asset, inspect_app, optimize_asset, explain_hint)',
  },
  decoders: {
    name: 'decoders',
    positionals: [{ name: 'dir', usage: '<dir>', required: true }],
    flags: [],
    summary: "copy three's Draco and Basis decoders into <dir> for createLoader()",
    missing: 'decoders needs a directory: threeforge decoders public/_decoders',
  },
};

/** The flag as the usage shows it: `--no-compile`, `--frames N`, `--simplify [ratio]`. */
export function flagUsage(flag: FlagSpec): string {
  const name = flag.negatable && flag.defaultOn ? `--no-${flag.name}` : `--${flag.name}`;
  if (flag.kind === 'boolean') return name;
  return flag.kind === 'value' ? `${name} ${flag.value}` : `${name} [${flag.value}]`;
}

/** Every form of a flag, as the AGENTS.md flag table lists it: `--compile`, `--no-compile`; `--frames N`. */
export function flagForms(flag: FlagSpec): string[] {
  const on =
    flag.kind === 'boolean'
      ? `--${flag.name}`
      : flag.kind === 'value'
        ? `--${flag.name} ${flag.value}`
        : `--${flag.name} [${flag.value}]`;
  return flag.negatable ? [on, `--no-${flag.name}`] : [on];
}

/** `threeforge analyze <file.glb|.gltf> [--backend webgl2|webgpu] … [--json]`. */
export function usageLine(spec: CommandSpec): string {
  const parts = [`threeforge ${spec.name}`, ...spec.positionals.map((p) => (p.required ? p.usage : `[${p.usage}]`))];
  const groups = new Set<string>();
  for (const flag of spec.flags) {
    if (!flag.group) parts.push(`[${flagUsage(flag)}]`);
    else if (!groups.has(flag.group)) {
      groups.add(flag.group);
      parts.push(`[${flag.group}]`);
    }
  }
  return parts.join(' ');
}

/** The usage text printed after a usage error (and by `help` when AGENTS.md is missing). */
export function formatUsage(): string {
  const commands = Object.values(COMMAND_SPECS).flatMap((spec) => [`  ${usageLine(spec)}`, `      ${spec.summary}`]);
  return [
    `threeforge ${VERSION} — frame-budget compiler and diagnostics for three.js games`,
    '',
    ...commands,
    '  threeforge help [<command>]',
    '      print AGENTS.md: every command, flag, the JSON document and the hint table (--help on any command does the same)',
    '',
    'Flags follow the command. A value is --flag value or --flag=value; boolean flags never take one. -- ends the flags.',
    'Unknown flags, extra arguments, repeated flags and out-of-range numbers are usage errors.',
    'Exit codes: 0 pass · 1 verdict failed · 2 usage · 3 environment (install: npm i -D playwright && npx playwright install chromium) · 4 page error',
    `Commands: ${COMMANDS.join(', ')}`,
  ].join('\n');
}

/** `/^[+-]?digits[.digits][e±digits]$/`: no hex, no whitespace, no `Infinity`, no empty string. */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

interface Scanned {
  /** `after` is the optional-value flag this argument directly followed without being taken as its value. */
  readonly positionals: ReadonlyArray<{ readonly value: string; readonly after: FlagSpec | null }>;
  /** By flag name: `true` / `false` (negated) or the raw value. */
  readonly values: ReadonlyMap<string, string | boolean>;
}

function levenshtein(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

function closest(word: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let distance = 3;
  for (const candidate of candidates) {
    const d = levenshtein(word, candidate);
    if (d < distance) {
      best = candidate;
      distance = d;
    }
  }
  return best;
}

const list = (words: readonly string[]): string =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;

function unknownFlag(spec: CommandSpec, display: string): UsageError {
  const forms = spec.flags.flatMap((flag) =>
    flag.negatable ? [`--${flag.name}`, `--no-${flag.name}`] : [`--${flag.name}`],
  );
  if (!display.startsWith('--') && forms.includes(`-${display}`))
    return new UsageError(`unknown flag ${display} for ${spec.name}; did you mean -${display}?`);
  const name = display.replace(/^--?/, '');
  const base = name.startsWith('no-') ? spec.flags.find((flag) => flag.name === name.slice(3)) : undefined;
  if (base) return new UsageError(`${display} is not a flag of ${spec.name}: --${base.name} has no --no- form`);
  const owners = Object.values(COMMAND_SPECS)
    .filter(
      (other) =>
        other !== spec &&
        other.flags.some((flag) => flag.name === name || (flag.negatable && `no-${flag.name}` === name)),
    )
    .map((other) => other.name);
  if (owners.length > 0) {
    const why = spec.refuses?.[name];
    return new UsageError(
      `${display} is not a flag of ${spec.name}${why ? `: ${why}` : ''} (${list(owners)} take${owners.length === 1 ? 's' : ''} it)`,
    );
  }
  const guess = closest(display, [...forms, '--help']);
  const known = forms.length > 0 ? `; flags of ${spec.name}: ${forms.join(', ')}` : `; ${spec.name} takes no flags`;
  return new UsageError(`unknown flag ${display} for ${spec.name}${guess ? `; did you mean ${guess}?` : known}`);
}

function scan(spec: CommandSpec, argv: readonly string[]): Scanned {
  const positionals: Array<{ value: string; after: FlagSpec | null }> = [];
  const values = new Map<string, string | boolean>();
  let flagsEnded = false;
  let bare: FlagSpec | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const after = bare;
    bare = null;
    if (flagsEnded) {
      positionals.push({ value: arg, after: null });
      continue;
    }
    if (arg === '--') {
      flagsEnded = true;
      continue;
    }
    if (!arg.startsWith('-') || arg === '-' || NUMBER.test(arg)) {
      positionals.push({ value: arg, after });
      continue;
    }
    const eq = arg.indexOf('=');
    const display = eq < 0 ? arg : arg.slice(0, eq);
    if (!arg.startsWith('--')) throw unknownFlag(spec, display);
    const name = display.slice(2);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    let flag = spec.flags.find((f) => f.name === name);
    let negated = false;
    if (!flag && name.startsWith('no-')) {
      const base = spec.flags.find((f) => f.name === name.slice(3));
      if (base?.negatable) {
        flag = base;
        negated = true;
      }
    }
    if (!flag) throw unknownFlag(spec, display);
    if (values.has(flag.name))
      throw new UsageError(`--${flag.name}${flag.negatable ? ` / --no-${flag.name}` : ''} is given more than once`);
    if (negated || flag.kind === 'boolean') {
      if (inline !== undefined) throw new UsageError(`${display} takes no value (got ${arg})`);
      values.set(flag.name, !negated);
      continue;
    }
    if (inline !== undefined) {
      values.set(flag.name, inline);
      continue;
    }
    const next = argv[i + 1];
    if (flag.kind === 'value') {
      if (next === undefined || next.startsWith('--'))
        throw new UsageError(`${display} needs a value: ${display} ${flag.value}`);
      values.set(flag.name, next);
      i++;
    } else if (next !== undefined && (flag.choices?.includes(next) || (flag.numeric && NUMBER.test(next)))) {
      values.set(flag.name, next);
      i++;
    } else {
      values.set(flag.name, true);
      bare = flag;
    }
  }
  return { positionals, values };
}

const show = (value: unknown): string => {
  const text =
    typeof value === 'string' ? JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value) : String(value);
  return text;
};

function badValue(flag: FlagSpec, raw: string): UsageError {
  if (flag.choices)
    return new UsageError(`--${flag.name} must be one of ${flag.choices.join(', ')} (got ${show(raw)})`);
  const range = RANGES[camel(flag.name) as RangeField];
  return new UsageError(`--${flag.name} must be ${range ? describeRange(range) : 'a number'} (got ${show(raw)})`);
}

/** The positionals of a command, with arity checked: a stray value after an optional-value flag is reported as that flag's bad value. */
function positionalsOf(spec: CommandSpec, scanned: Scanned): string[] {
  const { positionals } = scanned;
  const max = spec.positionals.length;
  if (positionals.length > max) {
    const stray = positionals.find((p) => p.after !== null);
    if (stray) throw badValue(stray.after!, stray.value);
    const extra = positionals.slice(max).map((p) => show(p.value));
    const takes =
      max === 0
        ? 'takes no arguments'
        : `takes ${spec.positionals.map((p) => (p.required ? p.usage : `at most one ${p.usage}`)).join(' ')}`;
    throw new UsageError(
      `unexpected argument${extra.length > 1 ? 's' : ''} ${extra.join(', ')}: threeforge ${spec.name} ${takes}`,
    );
  }
  if (positionals.length < spec.positionals.filter((p) => p.required).length)
    throw new UsageError(spec.missing ?? `${spec.name} is missing an argument: ${usageLine(spec)}`);
  return positionals.map((p) => p.value);
}

const camel = (flag: string): string => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const kebab = (field: string): string => field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function flagSpec(spec: CommandSpec, name: string): FlagSpec {
  return spec.flags.find((flag) => flag.name === name)!;
}

function numberFlag(spec: CommandSpec, values: Scanned['values'], name: string, fallback: number): number {
  const raw = values.get(name);
  if (typeof raw !== 'string') return fallback;
  const n = NUMBER.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) throw badValue(flagSpec(spec, name), raw);
  return n;
}

function choiceFlag<T extends string>(spec: CommandSpec, values: Scanned['values'], name: string, fallback: T): T {
  const raw = values.get(name);
  if (typeof raw !== 'string') return fallback;
  const flag = flagSpec(spec, name);
  if (!flag.choices!.includes(raw)) throw badValue(flag, raw);
  return raw as T;
}

function runInput(spec: CommandSpec, values: Scanned['values']): Omit<InspectInput, 'url'> {
  return {
    backend: choiceFlag(spec, values, 'backend', 'webgl2' as Backend),
    tier: spec.flags.some((flag) => flag.name === 'tier')
      ? choiceFlag(spec, values, 'tier', 'auto' as TierChoice)
      : 'auto',
    budget: values.has('budget') ? numberFlag(spec, values, 'budget', 0) : null,
    frames: numberFlag(spec, values, 'frames', 30),
    compile: values.get('compile') !== false,
    timeout: numberFlag(spec, values, 'timeout', 60_000),
    headed: values.get('headed') === true,
  };
}

const FLAG_NAMES = { names: 'flags' } as const;

/** Parses `process.argv.slice(2)`. Throws `UsageError` (exit code 2) on bad input. */
export function parseArgs(argv: string[]): Command {
  const end = argv.indexOf('--');
  if (argv.length === 0 || (end < 0 ? argv : argv.slice(0, end)).includes('--help')) return { name: 'help' };
  const [command, ...rest] = argv as [string, ...string[]];
  if (command === 'help') {
    const topic = rest[0];
    if (rest.length > 1 || (topic !== undefined && !(COMMANDS as readonly string[]).includes(topic)))
      throw new UsageError(
        `help takes at most one command name (got ${rest.map(show).join(' ')}); commands: ${COMMANDS.join(', ')}`,
      );
    return { name: 'help' };
  }
  if (command.startsWith('-'))
    throw new UsageError(
      `put the command first: threeforge <command> [flags] (got ${show(command)} first); commands: ${COMMANDS.join(', ')}`,
    );
  if (!(COMMANDS as readonly string[]).includes(command)) {
    const guess = closest(command, COMMANDS);
    throw new UsageError(
      `unknown command "${command}"; ${guess ? `did you mean ${guess}? ` : ''}commands: ${COMMANDS.join(', ')}`,
    );
  }
  const spec = COMMAND_SPECS[command as CommandName];
  const scanned = scan(spec, rest);
  const { values } = scanned;
  const json = values.get('json') === true;
  switch (spec.name) {
    case 'analyze': {
      const [file] = positionalsOf(spec, scanned) as [string];
      const bake: BakeChoice =
        values.get('bake-buried') === true ? 'buried' : values.get('bake') === true ? 'on' : 'off';
      const input: AnalyzeInput = {
        file,
        ...runInput(spec, values),
        bake,
        views: numberFlag(spec, values, 'views', 0),
        parity: numberFlag(spec, values, 'parity', DEFAULT_PARITY),
      };
      return { name: 'analyze', json, input: validateInput('analyze', input, FLAG_NAMES) };
    }
    case 'inspect': {
      const [url] = positionalsOf(spec, scanned) as [string];
      return { name: 'inspect', json, input: validateInput('inspect', { url, ...runInput(spec, values) }, FLAG_NAMES) };
    }
    case 'optimize': {
      const [file] = positionalsOf(spec, scanned) as [string];
      const steps: Partial<Record<StepName, boolean>> = {};
      for (const name of STEP_NAMES) {
        const toggle = values.get(name);
        if (toggle === false) steps[name] = false;
        else if (toggle === true && name !== 'simplify' && name !== 'textures') steps[name] = true;
      }
      const simplifyRaw = values.get('simplify');
      const texturesRaw = values.get('textures');
      const outRaw = values.get('out');
      const input: OptimizeInput = {
        file,
        out: typeof outRaw === 'string' ? outRaw : null,
        preset: choiceFlag(spec, values, 'preset', 'safe'),
        steps,
        simplify:
          typeof simplifyRaw === 'string'
            ? numberFlag(spec, values, 'simplify', 0.5)
            : simplifyRaw === true
              ? 0.5
              : null,
        simplifyError: numberFlag(spec, values, 'simplify-error', 0.001),
        compress: choiceFlag(spec, values, 'compress', 'none'),
        textures:
          typeof texturesRaw === 'string'
            ? choiceFlag(spec, values, 'textures', 'webp')
            : texturesRaw === true
              ? 'webp'
              : null,
        textureSize: values.has('texture-size') ? numberFlag(spec, values, 'texture-size', 0) : null,
        textureQuality: numberFlag(spec, values, 'texture-quality', 85),
        verify: values.get('verify') !== false,
        parity: numberFlag(spec, values, 'parity', DEFAULT_PARITY),
        views: numberFlag(spec, values, 'views', 2),
        ...runInput(spec, values),
      };
      return { name: 'optimize', json, input: validateInput('optimize', input, FLAG_NAMES) };
    }
    case 'explain': {
      const [code] = positionalsOf(spec, scanned);
      const all = values.get('all') === true;
      if (all && code !== undefined)
        throw new UsageError(`explain takes a hint code or --all, not both (got ${show(code)} and --all)`);
      if (!all && code === undefined) throw new UsageError('explain needs a hint code or --all');
      return { name: 'explain', code: code ?? null, all, json };
    }
    case 'schema': {
      const [raw] = positionalsOf(spec, scanned);
      const which = (raw ?? 'all') as SchemaChoice;
      if (!SCHEMAS.includes(which))
        throw new UsageError(`schema must be one of ${SCHEMAS.join(', ')} (got ${show(raw)})`);
      return { name: 'schema', which, json };
    }
    case 'mcp':
      positionalsOf(spec, scanned);
      return { name: 'mcp' };
    case 'decoders': {
      const [dir] = positionalsOf(spec, scanned) as [string];
      return { name: 'decoders', dir };
    }
  }
}

/** `an integer ≥ 1`, `a number from 0 to 100`, `a number in (0, 1]`. */
export function describeRange(range: NumberRange): string {
  const kind = range.integer ? 'an integer' : 'a number';
  if (range.max === undefined) return `${kind} ${range.minExclusive ? '>' : '≥'} ${range.min}`;
  return range.minExclusive ? `${kind} in (${range.min}, ${range.max}]` : `${kind} from ${range.min} to ${range.max}`;
}

export interface ValidateOptions {
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
