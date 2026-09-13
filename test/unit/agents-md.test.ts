import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REMEDIES } from '../../src/cli/explain.js';
import { VERSION } from '../../src/version.js';

/** AGENTS.md is generated from the remedy table; this keeps it from drifting. */
describe('AGENTS.md', () => {
  const text = readFileSync('AGENTS.md', 'utf8');
  it('mentions every hint code and the current version', () => {
    for (const code of Object.keys(REMEDIES)) expect(text, code).toContain(`\`${code}\``);
    expect(text).toContain(`threeforge ${VERSION}`);
  });
  it('documents the commands and exit codes', () => {
    for (const command of ['analyze', 'inspect', 'explain', 'schema', 'mcp']) expect(text).toContain(`npx threeforge ${command}`);
    expect(text).toContain('exposeToAgents');
    expect(text).toMatch(/`3` environment/);
  });
  it('matches package.json', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).version).toBe(VERSION);
  });
});
