import { PRESETS, STEP_NAMES } from './pipeline.js';
import type { StepName } from './types.js';
import { CHOICES, DEFAULT_PARITY } from './validate.js';

export const COMMANDS = ['analyze', 'inspect', 'optimize', 'explain', 'schema', 'mcp', 'decoders'] as const;
export type CommandName = (typeof COMMANDS)[number];

/** `--parity`'s sentence on what 0 means, shared word for word by every command that takes the flag. */
const PARITY_ZERO =
  'A threshold of 0 means zero: it is judged on the raw changed-pixel count of every view, not the rounded percent.';

type FlagKind = 'boolean' | 'value' | 'optional-value';

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

interface PositionalSpec {
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
  choices: CHOICES.backend,
  description: 'Renderer backend to measure on (default `webgl2`).',
};
const TIER: FlagSpec = {
  name: 'tier',
  kind: 'value',
  value: 'auto|desktop|phone-mid|phone-low',
  choices: CHOICES.tier,
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
        choices: CHOICES.compress,
        description:
          '`meshopt` adds `EXT_meshopt_compression` (the app needs `loader.setMeshoptDecoder`); default `none`.',
      },
      {
        name: 'textures',
        kind: 'optional-value',
        negatable: true,
        value: 'webp|avif|none',
        choices: CHOICES.textures,
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
