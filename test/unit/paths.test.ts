import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageError } from '../../src/cli/errors.js';
import { assertGltfOutPath, checkPathText, entryExists, isInside, realPathOf, SCHEME } from '../../src/cli/paths.js';

/**
 * The one set of path-confinement helpers `gltf-uris.ts`, `mcp.ts` and `server.ts` share. Before `paths.ts` each
 * carried its own copy and `mcp.ts`'s `isInside` tested `rel.startsWith('..')`, which also refused a sibling whose
 * name merely begins with two dots (`..cache/`).
 */
describe('isInside', () => {
  const base = join(sep, 'repo');

  it('accepts the base itself and anything nested in it', () => {
    expect(isInside(base, base)).toBe(true);
    expect(isInside(base, join(base, 'a'))).toBe(true);
    expect(isInside(base, join(base, 'a', 'b.glb'))).toBe(true);
  });

  it('accepts a child whose name begins with two dots (..cache is not a parent reference)', () => {
    expect(isInside(base, join(base, '..cache'))).toBe(true);
    expect(isInside(base, join(base, '..cache', 'out.glb'))).toBe(true);
    expect(isInside(base, join(base, '...'))).toBe(true);
  });

  it('refuses the parent, an ancestor, a sibling and a sibling that shares the base name as a prefix', () => {
    expect(isInside(base, join(base, '..'))).toBe(false);
    expect(isInside(base, sep)).toBe(false);
    expect(isInside(base, join(sep, 'other'))).toBe(false);
    expect(isInside(base, `${base}cache`)).toBe(false);
    expect(isInside(base, join(base, '..', 'repo2', 'x'))).toBe(false);
  });
});

describe('realPathOf', () => {
  let root: string;

  beforeEach(() => {
    // On macOS `tmpdir()` sits behind a symlink (`/var` → `/private/var`), so `root` is canonicalised up front.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-paths-')));
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'file.bin'), 'x');
    symlinkSync(join(root, 'real'), join(root, 'alias'), 'dir');
    symlinkSync(join(root, 'nowhere'), join(root, 'dangling'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves an existing path through its symlinks', () => {
    expect(realPathOf(join(root, 'alias', 'file.bin'))).toBe(join(root, 'real', 'file.bin'));
  });

  it('resolves a missing path through its nearest existing ancestor with the missing segments appended', () => {
    expect(realPathOf(join(root, 'alias', 'new', 'deep.bin'))).toBe(join(root, 'real', 'new', 'deep.bin'));
    expect(realPathOf(join(root, 'real', 'new.bin'))).toBe(join(root, 'real', 'new.bin'));
  });

  it('is null for a dangling symlink, whether at the path or at one of its ancestors', () => {
    expect(realPathOf(join(root, 'dangling'))).toBeNull();
    expect(realPathOf(join(root, 'dangling', 'child.bin'))).toBeNull();
  });
});

describe('entryExists', () => {
  it('is true for a dangling symlink (lstat, never following the final link) and false for nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-paths-exists-'));
    try {
      symlinkSync(join(root, 'nowhere'), join(root, 'dangling'));
      expect(entryExists(join(root, 'dangling'))).toBe(true);
      expect(entryExists(join(root, 'nowhere'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkPathText and SCHEME', () => {
  const problems = (text: string): string | null => {
    try {
      checkPathText(text, (problem) => {
        throw new Error(problem);
      });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };

  it('passes a relative path', () => {
    expect(problems('tex/a b.png')).toBeNull();
    expect(problems('..cache/a.bin')).toBeNull();
  });

  it('names the first problem: NUL, backslash, scheme, absolute path', () => {
    expect(problems('a\0b')).toMatch(/NUL/);
    expect(problems('a\\b')).toMatch(/backslash/);
    expect(problems('http://evil.example/x')).toMatch(/scheme/);
    expect(problems('C:/x')).toMatch(/scheme/);
    expect(problems('/etc/passwd')).toMatch(/absolute/);
    expect(problems('//host/share')).toMatch(/absolute/);
  });

  it('SCHEME matches file:, http: and a drive letter but not a plain relative path', () => {
    expect(SCHEME.test('file:///x')).toBe(true);
    expect(SCHEME.test('http://x')).toBe(true);
    expect(SCHEME.test('C:')).toBe(true);
    expect(SCHEME.test('tex/a.png')).toBe(false);
    expect(SCHEME.test('a:b/c')).toBe(true);
  });
});

describe('assertGltfOutPath', () => {
  it('accepts .glb and .gltf in any case, refuses anything else', () => {
    for (const path of ['scene.glb', 'Scene.GLB', 'scene.gltf'])
      expect(() => assertGltfOutPath(path, 'out')).not.toThrow();
    for (const path of ['scene.txt', 'scene.glb.bak', 'glb'])
      expect(() => assertGltfOutPath(path, 'out')).toThrow(UsageError);
  });

  it('throws a UsageError naming the field and the text the caller gave', () => {
    expect(() => assertGltfOutPath('/repo/out.txt', '--out', 'out.txt')).toThrow(UsageError);
    expect(() => assertGltfOutPath('/repo/out.txt', '--out', 'out.txt')).toThrow(
      '--out must end in .glb or .gltf (got out.txt)',
    );
    expect(() => assertGltfOutPath('/repo/out.txt', 'out')).toThrow(
      'out must end in .glb or .gltf (got /repo/out.txt)',
    );
    expect(() => assertGltfOutPath('/repo/out.gltf', 'out')).not.toThrow();
  });
});
