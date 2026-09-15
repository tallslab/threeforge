import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

/**
 * Finding 1 (Critical, Task 8 fix round 1): the confinement check compared paths lexically only, so a symlink
 * under an allowed root that resolves outside it was wrongly accepted. These use a real temp directory with a
 * real symlink (no `cwd`/`exists` fakes for the path itself — `resolveOptimizeOut`'s own `realpathSync` must do
 * the work), matching `src/cli/server.ts`'s existing defense against the same class of escape.
 */
describe('resolveOptimizeOut symlink confinement (real filesystem)', () => {
  let root: string;
  let projectDir: string;
  let inputDir: string;
  let outsideDir: string;
  let inputFile: string;

  function setUp(): void {
    root = mkdtempSync(join(tmpdir(), 'forge-mcp-symlink-'));
    projectDir = join(root, 'project'); // this is `cwd`
    inputDir = join(projectDir, 'assets'); // the input file's own directory, inside cwd
    outsideDir = join(root, 'outside'); // a sibling of projectDir: outside both allowed roots
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    inputFile = join(inputDir, 'Fox.glb');
    writeFileSync(inputFile, '');
  }

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('rejects an out that lexically sits inside the input directory but escapes through a symlink to outside both roots', () => {
    setUp();
    // inputDir/escape -> outsideDir: lexically "assets/escape/evil.glb" looks contained, really is not.
    symlinkSync(outsideDir, join(inputDir, 'escape'), 'dir');
    expect(() => resolveOptimizeOut(inputFile, join(inputDir, 'escape', 'evil.glb'), false, projectDir, () => false)).toThrow(UsageError);
    expect(() => resolveOptimizeOut(inputFile, join(inputDir, 'escape', 'evil.glb'), false, projectDir, () => false)).toThrow(/input's directory|working directory/);
  });

  it('rejects an out that lexically sits inside the working directory but escapes through a symlink to outside both roots', () => {
    setUp();
    // projectDir/escape -> outsideDir: lexically "escape/evil.glb" looks contained in cwd, really is not.
    symlinkSync(outsideDir, join(projectDir, 'escape'), 'dir');
    expect(() => resolveOptimizeOut(inputFile, join(projectDir, 'escape', 'evil.glb'), false, projectDir, () => false)).toThrow(/input's directory|working directory/);
  });

  it('still accepts an out reached through a symlink that stays inside an allowed root', () => {
    setUp();
    // projectDir/alias -> inputDir: a symlink, but its real target is still inside cwd.
    symlinkSync(inputDir, join(projectDir, 'alias'), 'dir');
    const out = resolveOptimizeOut(inputFile, join(projectDir, 'alias', 'aliased.glb'), false, projectDir, () => false);
    expect(out).toBe(join(projectDir, 'alias', 'aliased.glb'));
  });

  it('still accepts a plain out with no symlink involved (no false positives from the realpath check)', () => {
    setUp();
    const out = resolveOptimizeOut(inputFile, join(inputDir, 'plain.glb'), false, projectDir, () => false);
    expect(out).toBe(join(inputDir, 'plain.glb'));
  });
});

/**
 * Finding 2 (Important, Task 8 fix round 1): `isInside('/', target)` is true for any absolute target, so at
 * `cwd === '/'` the "or the working directory" clause was vacuous — the rule collapsed to "must end in
 * .glb/.gltf". The filesystem root is now never treated as an allowed working directory (a specific directory
 * like the user's home is not exempted the same way: it is still bounded, unlike "/", so it is not special-cased).
 */
describe('resolveOptimizeOut with cwd at the filesystem root', () => {
  const file = '/repo/assets/Fox/Fox.glb';
  const never = () => false;

  it('rejects an out outside the input directory even though it is lexically "inside" root', () => {
    expect(() => resolveOptimizeOut(file, '/anywhere/out.glb', false, '/', never)).toThrow(UsageError);
    expect(() => resolveOptimizeOut(file, '/anywhere/out.glb', false, '/', never)).toThrow(/input's directory/);
  });

  it("the rejection at root does not claim a working-directory scope exists", () => {
    expect(() => resolveOptimizeOut(file, '/anywhere/out.glb', false, '/', never)).not.toThrow(/working directory/);
  });

  it('still accepts an out inside the input\'s own directory when cwd is root', () => {
    expect(resolveOptimizeOut(file, '/repo/assets/Fox/other.gltf', false, '/', never)).toBe('/repo/assets/Fox/other.gltf');
  });
});
