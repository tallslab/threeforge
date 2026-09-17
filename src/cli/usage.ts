import { VERSION } from '../version.js';
import { COMMAND_SPECS, COMMANDS, type CommandSpec, type FlagSpec } from './commandSpecs.js';

/** The flag as the usage shows it: `--no-compile`, `--frames N`, `--simplify [ratio]`. */
function flagUsage(flag: FlagSpec): string {
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
