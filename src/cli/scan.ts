import { COMMAND_SPECS, type CommandSpec, type FlagSpec } from './commandSpecs.js';
import { UsageError } from './errors.js';

/** `/^[+-]?digits[.digits][e±digits]$/`: no hex, no whitespace, no `Infinity`, no empty string. */
export const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export interface Scanned {
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

export function closest(word: string, candidates: readonly string[]): string | null {
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

export function scan(spec: CommandSpec, argv: readonly string[]): Scanned {
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
