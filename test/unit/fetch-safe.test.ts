import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { safeLocalPath } from '../../scripts/fetch-safe.mjs';

const made: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-fetch-safe-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('safeLocalPath', () => {
  it('throws for traversal, absolute paths, schemes, NUL and undecodable percent-encoding', () => {
    const root = tmpRoot();
    const bad = [
      '../../x',
      '%2e%2e%2fx',
      'a/../../x',
      '/etc/x',
      'C:\\x',
      'http://evil.example/x',
      'file:///etc/passwd',
      'a\0b',
      '%zz',
    ];
    for (const uri of bad) {
      expect(() => safeLocalPath(root, uri), uri).toThrow();
    }
  });

  it('returns the joined, decoded path for a plain or percent-encoded name inside root', () => {
    const root = tmpRoot();
    const expected = join(root, 'textures/a b.png');
    for (const uri of ['textures/a b.png', 'textures/a%20b.png']) {
      const local = safeLocalPath(root, uri);
      expect(local).toBe(expected);
      const rel = relative(root, local);
      expect(rel.startsWith('..')).toBe(false);
    }
  });

  it('rejects a target whose existing parent directory real-path escapes root through a symlink', () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    mkdirSync(join(root, 'textures'));
    rmSync(join(root, 'textures'), { recursive: true, force: true });
    symlinkSync(outside, join(root, 'textures'), 'dir');
    expect(() => safeLocalPath(root, 'textures/a.png')).toThrow();
  });
});
