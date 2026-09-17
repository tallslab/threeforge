import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMAND_SPECS } from '../../src/cli/commandSpecs.js';
import { REMEDIES } from '../../src/cli/explain.js';
import { VERSION } from '../../src/version.js';

/** AGENTS.md is generated from the remedy table and the command specs; this keeps it from drifting. */
describe('AGENTS.md', () => {
  const text = readFileSync('AGENTS.md', 'utf8');
  it('mentions every hint code and the current version', () => {
    for (const code of Object.keys(REMEDIES)) expect(text, code).toContain(`\`${code}\``);
    expect(text).toContain(`threeforge ${VERSION}`);
  });
  it('documents the commands and exit codes', () => {
    for (const command of Object.keys(COMMAND_SPECS)) expect(text).toContain(`npx threeforge ${command}`);
    expect(text).toContain('exposeToAgents');
    expect(text).toContain('if (import.meta.env.DEV) exposeToAgents(');
    expect(text).toMatch(/`3` environment/);
  });
  it('documents every flag of every command, in each accepted form', () => {
    const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const spec of Object.values(COMMAND_SPECS)) {
      for (const flag of spec.flags) {
        const forms = [`--${flag.name}`, ...(flag.negatable ? [`--no-${flag.name}`] : [])];
        for (const form of forms)
          expect(text, `${spec.name} ${form}`).toMatch(new RegExp(`${escapeRegExp(form)}(?![\\w-])`));
      }
    }
    const inspectRow = text.split('\n').find((line) => line.startsWith('| `npx threeforge inspect'))!;
    expect(inspectRow).toContain('--no-compile');
    expect(inspectRow).not.toContain('--tier');
  });
  it('matches package.json', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).version).toBe(VERSION);
  });
});
