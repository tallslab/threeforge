import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/cli/errors.js';
import { resolveOptimizeOut } from '../../src/cli/mcp.js';

/**
 * `optimize_asset.out` is MCP-only (the CLI's `--out` trusts a local user typing a path): it must end in
 * `.glb`/`.gltf`, sit inside the input's directory or the working directory, and needs `overwrite: true` to
 * replace an existing file. `resolveOptimizeOut` is pure given `cwd` and `exists`, so these are unit tests, not e2e.
 */
describe('resolveOptimizeOut (optimize_asset.out confinement and overwrite rules)', () => {
  const cwd = '/repo';
  const file = '/repo/assets/Fox/Fox.glb';
  const never = () => false;
  const always = () => true;

  it('defaults to <name>.forge.glb next to the input when out is omitted', () => {
    expect(resolveOptimizeOut(file, null, false, cwd, never)).toBe('/repo/assets/Fox/Fox.forge.glb');
  });

  it('accepts a relative out resolved inside the working directory', () => {
    expect(resolveOptimizeOut(file, 'build/out.glb', false, cwd, never)).toBe('/repo/build/out.glb');
  });

  it('accepts an absolute out nested inside the input file\'s own directory', () => {
    expect(resolveOptimizeOut(file, '/repo/assets/Fox/other.gltf', false, cwd, never)).toBe('/repo/assets/Fox/other.gltf');
  });

  it('rejects an out outside both the input directory and the working directory', () => {
    expect(() => resolveOptimizeOut(file, '/tmp/x.glb', false, cwd, never)).toThrow(UsageError);
    expect(() => resolveOptimizeOut(file, '/tmp/x.glb', false, cwd, never)).toThrow(/working directory|input's directory/);
  });

  it('rejects an out that does not end in .glb or .gltf, even inside scope', () => {
    expect(() => resolveOptimizeOut(file, '/repo/build/out.txt', false, cwd, never)).toThrow(UsageError);
    expect(() => resolveOptimizeOut(file, '/repo/build/out.txt', false, cwd, never)).toThrow(/\.glb or \.gltf/);
  });

  it('rejects a scoped, correctly-named out that already exists, without overwrite', () => {
    expect(() => resolveOptimizeOut(file, '/repo/build/out.glb', false, cwd, always)).toThrow(UsageError);
    expect(() => resolveOptimizeOut(file, '/repo/build/out.glb', false, cwd, always)).toThrow(/exists/);
  });

  it('accepts an existing target when overwrite is true', () => {
    expect(resolveOptimizeOut(file, '/repo/build/out.glb', true, cwd, always)).toBe('/repo/build/out.glb');
  });

  it('never checks existence before extension and scope are valid (out-of-scope wins even if it also "exists")', () => {
    expect(() => resolveOptimizeOut(file, '/tmp/x.txt', false, cwd, always)).toThrow(/\.glb or \.gltf/);
  });
});
