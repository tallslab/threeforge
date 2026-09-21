import { COMMAND_SPECS, COMMANDS, type CommandName, type CommandSpec, type FlagSpec } from './commandSpecs.js';
import { UsageError } from './errors.js';
import { STEP_NAMES } from './pipeline.js';
import { closest, NUMBER, type Scanned, scan } from './scan.js';
import type {
  AnalyzeInput,
  Backend,
  BakeChoice,
  InspectInput,
  Ktx2Codec,
  OptimizeInput,
  StepName,
  TierChoice,
} from './types.js';
import { usageLine } from './usage.js';
import {
  CHOICES,
  DEFAULT_PARITY,
  describeRange,
  RANGES,
  type RangeField,
  type SchemaChoice,
  show,
  validateInput,
} from './validate.js';

export type Command =
  | { name: 'help' }
  | { name: 'analyze'; input: AnalyzeInput; json: boolean }
  | { name: 'inspect'; input: InspectInput; json: boolean }
  | { name: 'optimize'; input: OptimizeInput; json: boolean }
  | { name: 'explain'; code: string | null; all: boolean; json: boolean }
  | { name: 'schema'; which: SchemaChoice; json: boolean }
  | { name: 'mcp' }
  | { name: 'decoders'; dir: string };

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

/** The KTX2 settings that were given, and only those: an unset one stays out of the input and of the document. */
function ktx2Input(
  spec: CommandSpec,
  values: Scanned['values'],
): Pick<OptimizeInput, 'ktx2Codec' | 'ktx2Qlevel' | 'ktx2UastcQuality' | 'ktx2Zstd'> {
  const input: ReturnType<typeof ktx2Input> = {};
  if (values.has('ktx2-codec')) input.ktx2Codec = choiceFlag<Ktx2Codec>(spec, values, 'ktx2-codec', 'auto');
  if (values.has('ktx2-qlevel')) input.ktx2Qlevel = numberFlag(spec, values, 'ktx2-qlevel', 0);
  if (values.has('ktx2-uastc-quality')) input.ktx2UastcQuality = numberFlag(spec, values, 'ktx2-uastc-quality', 0);
  if (values.has('ktx2-zstd')) input.ktx2Zstd = numberFlag(spec, values, 'ktx2-zstd', 0);
  return input;
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
        ...ktx2Input(spec, values),
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
      if (!CHOICES.schema.includes(which))
        throw new UsageError(`schema must be one of ${CHOICES.schema.join(', ')} (got ${show(raw)})`);
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
