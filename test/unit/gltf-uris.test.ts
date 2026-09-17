import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageError } from '../../src/cli/errors.js';
import { assertConfinedUri, assertConfinedUris, readGltfJson } from '../../src/cli/gltf-uris.js';
import { CHUNK_BIN, glbBytes } from './helpers/gltf-files.js';

/**
 * `threeforge optimize` hands files to glTF-Transform, which resolves `images[].uri` and `buffers[].uri` against the
 * input's directory with no confinement: a crafted input got `../../.ssh/id_ed25519` embedded into `<name>.forge.glb`. These
 * pin the rules `assertConfinedUri` applies before any read or write. `root/a/b` is the base directory; `root` holds
 * the "secret" a hostile URI reaches for. On macOS `tmpdir()` itself sits behind a symlink (`/var` → `/private/var`).
 */
let root: string;
let base: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-uris-'));
  base = join(root, 'a', 'b');
  mkdirSync(join(base, 'tex'), { recursive: true });
  mkdirSync(join(root, 'outside'), { recursive: true });
  writeFileSync(join(root, 'secret.png'), 'TOP SECRET');
  writeFileSync(join(root, 'outside', 'secret.png'), 'TOP SECRET');
  writeFileSync(join(base, 'tex', 'a b.png'), 'png');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('assertConfinedUri', () => {
  it.each([
    ['a data: URI', 'data:image/png;base64,iVBORw0KGgo='],
    ['a plain file name', 'a.png'],
    ['a subfolder texture with an escaped space', 'tex/a%20b.png'],
    ['a path that climbs back inside', 'tex/../a.png'],
    ['a file name that only starts with two dots', '..a.png'],
    ['a double-encoded dot-dot (decoded once, as glTF-Transform does: a literal %2e%2e folder)', '%252e%252e/x.png'],
    ['a query-like suffix (a literal file name to glTF-Transform)', 'a.png?v=1'],
  ])('accepts %s', (_, uri) => {
    expect(() => assertConfinedUri(uri, 'images[0].uri', base)).not.toThrow();
  });

  it.each([
    ['../../secret.png', /outside/],
    ['%2e%2e/%2e%2e/secret.png', /outside/],
    ['%2e%2e/x.png', /outside/],
    ['tex/../../x.png', /outside/],
    ['/etc/passwd', /absolute/],
    ['%2Fetc%2Fpasswd', /absolute/],
    ['//server/share/x.png', /absolute/],
    ['file:///etc/passwd', /scheme/],
    ['https://example.com/x.png', /scheme/],
    ['DATA:text/plain,x', /scheme/],
    ['C:/Windows/win.ini', /scheme/],
    ['C%3A/Windows/win.ini', /scheme/],
    ['C:\\Windows\\win.ini', /backslash/],
    ['..\\..\\secret.png', /backslash/],
    ['%5C..%5C..%5Csecret.png', /backslash/],
    ['a\u0000.png', /NUL/],
    ['a%00.png', /NUL/],
    ['100%.png', /percent-encoding/],
    ['%E0%A4%A.png', /percent-encoding/],
  ])('refuses %j', (uri, reason) => {
    expect(() => assertConfinedUri(uri, 'images[0].uri', base)).toThrow(UsageError);
    expect(() => assertConfinedUri(uri, 'images[0].uri', base)).toThrow(reason);
  });

  it('names where the URI came from and quotes it cleaned', () => {
    let message = '';
    try {
      assertConfinedUri('../\x1b[31m../x.png', 'buffers[2].uri', base);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^buffers\[2\]\.uri "\.\.\/\.\.\/x\.png" resolves outside /);
    expect(message).not.toContain('\x1b');
  });

  it('refuses a value that is not a string', () => {
    expect(() => assertConfinedUri(42, 'images[0].uri', base)).toThrow(/not a string/);
  });

  it('refuses a symlink inside the directory that leads outside it: a file, a folder, and a dangling link', () => {
    symlinkSync(join(root, 'secret.png'), join(base, 'link.png'));
    symlinkSync(join(root, 'outside'), join(base, 'linked'));
    symlinkSync(join(root, 'outside', 'not-yet.bin'), join(base, 'dangling.bin'));
    expect(() => assertConfinedUri('link.png', 'images[0].uri', base)).toThrow(/outside .* through a symlink/);
    expect(() => assertConfinedUri('linked/secret.png', 'images[0].uri', base)).toThrow(/through a symlink/);
    expect(() => assertConfinedUri('linked/missing/new.bin', 'buffers[0].uri', base)).toThrow(/through a symlink/);
    expect(() => assertConfinedUri('dangling.bin', 'buffers[0].uri', base)).toThrow(/symlink/);
  });

  it('accepts a symlink that stays inside, and a base directory reached through a symlink', () => {
    symlinkSync(join(base, 'tex', 'a b.png'), join(base, 'inner.png'));
    expect(() => assertConfinedUri('inner.png', 'images[0].uri', base)).not.toThrow();
    const alias = join(root, 'alias');
    symlinkSync(base, alias);
    expect(() => assertConfinedUri('tex/a%20b.png', 'images[0].uri', alias)).not.toThrow();
    expect(() => assertConfinedUri('not-yet/new.bin', 'buffers[0].uri', alias)).not.toThrow();
  });
});

describe('assertConfinedUris', () => {
  it('checks every image and buffer URI and says which one failed', () => {
    expect(() => assertConfinedUris({ images: [{ uri: 'a.png' }, { uri: '../../secret.png' }] }, base)).toThrow(
      /images\[1\]\.uri/,
    );
    expect(() =>
      assertConfinedUris(
        { buffers: [{ uri: 'data:application/octet-stream;base64,AAAA' }, { uri: '/etc/passwd' }] },
        base,
      ),
    ).toThrow(/buffers\[1\]\.uri/);
  });

  it('ignores entries without a URI (GLB-embedded images, the GLB buffer)', () => {
    expect(() => assertConfinedUris({}, base)).not.toThrow();
    expect(() =>
      assertConfinedUris(
        { images: [{ bufferView: 0, mimeType: 'image/png' }, { uri: '' }], buffers: [{ byteLength: 4 }] },
        base,
      ),
    ).not.toThrow();
  });

  it('refuses images or buffers that are not arrays', () => {
    expect(() => assertConfinedUris({ images: { 0: { uri: '../x' } } }, base)).toThrow(/images must be an array/);
    expect(() => assertConfinedUris({ buffers: '../x.bin' }, base)).toThrow(UsageError);
  });
});

describe('readGltfJson', () => {
  const write = (name: string, bytes: Uint8Array | string): string => {
    const file = join(base, name);
    writeFileSync(file, bytes);
    return file;
  };

  it('parses a .gltf file', () => {
    const file = write(
      'scene.gltf',
      JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: '../../secret.png' }] }),
    );
    expect(readGltfJson(file)).toMatchObject({ images: [{ uri: '../../secret.png' }] });
  });

  it("reads a .glb's JSON chunk and ignores the binary chunk after it", () => {
    const file = write(
      'scene.glb',
      glbBytes(
        { asset: { version: '2.0' }, buffers: [{ uri: '../x.bin', byteLength: 4 }] },
        { bin: new Uint8Array([1, 2, 3, 4]) },
      ),
    );
    expect(readGltfJson(file)).toMatchObject({ buffers: [{ uri: '../x.bin' }] });
  });

  it('decides by content, as glTF-Transform does: GLB bytes under a .gltf name are read as GLB', () => {
    const file = write('disguised.gltf', glbBytes({ asset: { version: '2.0' }, images: [{ uri: '/etc/passwd' }] }));
    expect(readGltfJson(file)).toMatchObject({ images: [{ uri: '/etc/passwd' }] });
  });

  it('refuses malformed input with a UsageError', () => {
    const truncated = glbBytes({ asset: { version: '2.0' }, images: [] });
    expect(() => readGltfJson(write('bad.gltf', '{ nope'))).toThrow(UsageError);
    expect(() => readGltfJson(write('array.gltf', '[]'))).toThrow(UsageError);
    expect(() =>
      readGltfJson(write('bin-first.glb', glbBytes({ asset: { version: '2.0' } }, { chunkType: CHUNK_BIN }))),
    ).toThrow(/JSON chunk/);
    expect(() => readGltfJson(write('truncated.glb', truncated.subarray(0, truncated.length - 8)))).toThrow(
      /JSON chunk/,
    );
    expect(() => readGltfJson(write('short.glb', truncated.subarray(0, 16)))).toThrow(UsageError);
    expect(() => readGltfJson(join(base, 'missing.gltf'))).toThrow(UsageError);
  });
});
