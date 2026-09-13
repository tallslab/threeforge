import type { AnalyzeInput, Backend, InspectInput, TierChoice } from './types.js';

export class UsageError extends Error {}

export type SchemaChoice = 'snapshot' | 'analyze' | 'inspect' | 'all';

export type Command =
  | { name: 'help' }
  | { name: 'analyze'; input: AnalyzeInput; json: boolean }
  | { name: 'inspect'; input: InspectInput; json: boolean }
  | { name: 'explain'; code: string | null; all: boolean; json: boolean }
  | { name: 'schema'; which: SchemaChoice; json: boolean }
  | { name: 'mcp' };

const BACKENDS: Backend[] = ['webgl2', 'webgpu'];
const TIERS: TierChoice[] = ['auto', 'desktop', 'phone-mid', 'phone-low'];
const SCHEMAS: SchemaChoice[] = ['snapshot', 'analyze', 'inspect', 'all'];
export const COMMANDS = ['analyze', 'inspect', 'explain', 'schema', 'mcp'] as const;

interface Flags {
  positional: string[];
  values: Map<string, string | true>;
}

function split(argv: string[]): Flags {
  const positional: string[] = [];
  const values = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (key.startsWith('no-') || next === undefined || next.startsWith('--')) values.set(key, true);
    else {
      values.set(key, next);
      i++;
    }
  }
  return { positional, values };
}

function number(values: Flags['values'], key: string, fallback: number): number {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw === true || !Number.isFinite(n) || n < 0) throw new UsageError(`--${key} expects a non-negative number`);
  return n;
}

function choice<T extends string>(values: Flags['values'], key: string, allowed: readonly T[], fallback: T): T {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  if (raw === true || !allowed.includes(raw as T)) throw new UsageError(`--${key} must be one of ${allowed.join(', ')}`);
  return raw as T;
}

function runInput(values: Flags['values']): Omit<AnalyzeInput, 'file'> {
  return {
    backend: choice(values, 'backend', BACKENDS, 'webgl2'),
    tier: choice(values, 'tier', TIERS, 'auto'),
    budget: values.has('budget') ? number(values, 'budget', 0) : null,
    frames: Math.max(1, Math.round(number(values, 'frames', 30))),
    compile: !values.has('no-compile'),
    timeout: number(values, 'timeout', 60_000),
    headed: values.has('headed'),
  };
}

/** Parses `process.argv.slice(2)`. Throws `UsageError` (exit code 2) on bad input. */
export function parseArgs(argv: string[]): Command {
  const { positional, values } = split(argv);
  const [command, ...rest] = positional;
  const json = values.has('json');
  if (!command || command === 'help' || values.has('help')) return { name: 'help' };
  switch (command) {
    case 'analyze': {
      const file = rest[0];
      if (!file) throw new UsageError('analyze needs a file: threeforge analyze scene.glb');
      return { name: 'analyze', json, input: { file, ...runInput(values) } };
    }
    case 'inspect': {
      const url = rest[0];
      if (!url) throw new UsageError('inspect needs a url: threeforge inspect http://localhost:5173');
      return { name: 'inspect', json, input: { url, ...runInput(values) } };
    }
    case 'explain': {
      const all = values.has('all');
      const code = rest[0] ?? null;
      if (!all && !code) throw new UsageError('explain needs a hint code or --all');
      return { name: 'explain', code, all, json };
    }
    case 'schema': {
      const which = (rest[0] ?? 'all') as SchemaChoice;
      if (!SCHEMAS.includes(which)) throw new UsageError(`schema must be one of ${SCHEMAS.join(', ')}`);
      return { name: 'schema', which, json };
    }
    case 'mcp':
      return { name: 'mcp' };
    default:
      throw new UsageError(`unknown command "${command}"; commands: ${COMMANDS.join(', ')}`);
  }
}
