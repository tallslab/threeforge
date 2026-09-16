import { Document, NodeIO } from '@gltf-transform/core';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import pngjs from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARITY, parseArgs } from '../../src/cli/args.js';
import { UsageError } from '../../src/cli/errors.js';
import { optimizeAsset, verifyAnalyzeInput } from '../../src/cli/optimize.js';
import type { OptimizeInput } from '../../src/cli/types.js';
import { GLB_MAGIC, glbBytes } from './helpers/gltf-files.js';

/**
 * What `optimize` accepts as input resources and as `--out`. All of it runs with `--no-verify` (no browser). `root/a/b`
 * is the input directory; `root/secret.png` is what a hostile URI reaches for.
 */
function inputFor(file: string, ...extra: string[]): OptimizeInput {
  const command = parseArgs(['optimize', file, '--no-verify', ...extra]);
  if (command.name !== 'optimize') throw new Error(`parsed as ${command.name}`);
  return command.input;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection, but the call resolved');
}

/**
 * One textured triangle; the texture and the buffer keep the given URIs when written as .gltf. The 4×4 image is not a
 * single colour, so the safe preset's `prune` keeps it (it replaces solid-colour textures with a factor).
 */
function texturedTriangle({ imageUri, bufferUri }: { imageUri?: string; bufferUri?: string } = {}): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  if (bufferUri) buffer.setURI(bufferUri);
  const png = new pngjs.PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i++) png.data[i] = i % 4 === 3 ? 255 : (i * 37) % 256;
  const texture = doc.createTexture('t').setImage(new Uint8Array(pngjs.PNG.sync.write(png))).setMimeType('image/png');
  if (imageUri) texture.setURI(imageUri);
  const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setAttribute('TEXCOORD_0', uv).setMaterial(doc.createMaterial('m').setBaseColorTexture(texture));
  doc.createScene().addChild(doc.createNode('n').setMesh(doc.createMesh('triangle').addPrimitive(prim)));
  return doc;
}

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-optimize-inputs-'));
  dir = join(root, 'a', 'b');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'secret.png'), 'TOP SECRET');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const writeGltf = (name: string, json: Record<string, unknown>): string => {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ asset: { version: '2.0' }, ...json }));
  return file;
};

describe('optimize reads resources only from inside the input directory', () => {
  it('refuses a .gltf whose image URI climbs out (../../secret.png) before writing anything', async () => {
    const file = writeGltf('scene.gltf', { images: [{ uri: '../../secret.png' }] });
    const error = await rejection(optimizeAsset(inputFor(file)));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(/outside/);
    expect(existsSync(join(dir, 'scene.forge.glb'))).toBe(false);
  });

  it.each([
    ['%2e%2e/%2e%2e/secret.png', /outside/],
    ['/etc/passwd', /absolute/],
    ['file:///etc/passwd', /scheme/],
    ['100%.png', /percent-encoding/],
  ])('refuses the image URI %j', async (uri, reason) => {
    const file = writeGltf('scene.gltf', { images: [{ uri }] });
    const error = await rejection(optimizeAsset(inputFor(file)));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(reason);
  });

  it('refuses a .glb whose JSON chunk points a buffer outside (../x.bin)', async () => {
    writeFileSync(join(root, 'a', 'x.bin'), new Uint8Array([1, 2, 3, 4]));
    const file = join(dir, 'scene.glb');
    writeFileSync(file, glbBytes({ asset: { version: '2.0' }, buffers: [{ uri: '../x.bin', byteLength: 4 }] }));
    const error = await rejection(optimizeAsset(inputFor(file)));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(/buffers\[0\]\.uri .*outside/);
  });

  it('refuses a symlink inside the input directory that leads outside it', async () => {
    symlinkSync(join(root, 'secret.png'), join(dir, 'innocent.png'));
    const file = writeGltf('scene.gltf', { images: [{ uri: 'innocent.png' }] });
    const error = await rejection(optimizeAsset(inputFor(file)));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(/outside/);
  });

  it('still optimizes a .gltf whose texture and buffer sit in subfolders with an escaped space', async () => {
    const file = join(dir, 'scene.gltf');
    await new NodeIO().write(file, texturedTriangle({ imageUri: 'tex/a%20b.png', bufferUri: 'bin/scene%20data.bin' }));
    expect(existsSync(join(dir, 'tex', 'a b.png'))).toBe(true);
    expect(existsSync(join(dir, 'bin', 'scene data.bin'))).toBe(true);
    const doc = await optimizeAsset(inputFor(file));
    expect(doc.stats.before.textures).toBe(1);
    expect(doc.output.file).toBe(join(dir, 'scene.forge.glb'));
    expect(readFileSync(doc.output.file).readUInt32LE(0)).toBe(GLB_MAGIC);
  });
});

describe('optimize --out', () => {
  async function inputGlb(name = 'fox.glb'): Promise<string> {
    const file = join(dir, name);
    writeFileSync(file, await new NodeIO().writeBinary(texturedTriangle()));
    return file;
  }

  it('must end in .glb or .gltf', async () => {
    const file = await inputGlb();
    const out = join(dir, 'fox.txt');
    const error = await rejection(optimizeAsset(inputFor(file, '--out', out)));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(/\.glb or \.gltf/);
    expect(existsSync(out)).toBe(false);
  });

  it('must not be the input file, even through a hard link or a symlink', async () => {
    const file = await inputGlb();
    const original = readFileSync(file);
    linkSync(file, join(dir, 'hard.glb'));
    symlinkSync(file, join(dir, 'soft.glb'));
    for (const [input, out] of [
      [file, file],
      [file, join(dir, 'hard.glb')],
      [file, join(dir, 'soft.glb')],
      [join(dir, 'soft.glb'), file],
    ] as const) {
      const error = await rejection(optimizeAsset(inputFor(input, '--out', out)));
      expect(error, out).toBeInstanceOf(UsageError);
      expect(error.message).toMatch(/input file/);
    }
    expect(readFileSync(file).equals(original)).toBe(true);
  });

  it('on a case-insensitive filesystem, a case variant of the input name is the input file', async (ctx) => {
    const file = await inputGlb();
    const variant = join(dir, 'FOX.glb');
    if (!existsSync(variant)) ctx.skip();
    const error = await rejection(optimizeAsset(inputFor(file, '--out', variant)));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(/input file/);
  });

  it('writes an upper-case .GLB as binary glTF (glTF-Transform picks GLB only for a lower-case .glb)', async () => {
    const file = await inputGlb();
    const out = join(dir, 'Optimized.GLB');
    await optimizeAsset(inputFor(file, '--out', out));
    expect(readFileSync(out).readUInt32LE(0)).toBe(GLB_MAGIC);
    expect(readdirSync(dir).sort()).toEqual(['Optimized.GLB', 'fox.glb']);
  });

  it('writes a .gltf output with its resources next to it', async () => {
    const file = await inputGlb();
    const out = join(dir, 'optimized.gltf');
    const doc = await optimizeAsset(inputFor(file, '--out', out));
    expect(doc.output.file).toBe(out);
    const json = JSON.parse(readFileSync(out, 'utf8')) as { images?: Array<{ uri: string }>; buffers?: Array<{ uri: string }> };
    const uris = [...(json.images ?? []), ...(json.buffers ?? [])].map((r) => r.uri);
    expect(uris.length).toBeGreaterThan(0);
    for (const uri of uris) expect(existsSync(join(dir, decodeURIComponent(uri))), uri).toBe(true);
    expect((await new NodeIO().read(out)).getRoot().listMeshes()).toHaveLength(1);
  });

  it('refuses a .gltf output whose resource URIs would leave its directory, before writing anything', async () => {
    const file = await inputGlb();
    // glTF-Transform names the buffer after the output (`..%2F..%2Fescape.bin`) and writes it to path.join(dir, decodeURIComponent(uri)).
    const out = join(dir, '..%2F..%2Fescape.gltf');
    const error = await rejection(optimizeAsset(inputFor(file, '--out', out)));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(/outside/);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(root).sort()).toEqual(['a', 'secret.png']);
    expect(readdirSync(dir).sort()).toEqual(['fox.glb']);
  });
});

/**
 * Ruling R21 (Task 10 re-review): a `.gltf` out also writes resource files (`.bin`, textures) next to it, named
 * after the out's own basename (`UniqueURIGenerator`, `@gltf-transform/core`: a single buffer becomes
 * `<basename>.bin`). Task 10 already refuses a resource target that is the *input's own* file or resource; this
 * covers every other pre-existing file that name happens to collide with. `optimizeAsset`'s `overwrite` (default
 * `true`, unset by `inputFor`/the CLI parser) must refuse before writing anything when `false`.
 */
describe("optimize --out overwrite (protects resource files, not just the input's own)", () => {
  async function inputGlb(name = 'fox.glb'): Promise<string> {
    const file = join(dir, name);
    writeFileSync(file, await new NodeIO().writeBinary(texturedTriangle()));
    return file;
  }

  it("refuses a .gltf out whose single-buffer resource (<basename>.bin) clashes with an unrelated pre-existing file, leaving it byte-identical", async () => {
    const file = await inputGlb();
    const out = join(dir, 'x.gltf');
    const clashing = join(dir, 'x.bin');
    const original = Buffer.from('UNRELATED PRE-EXISTING BYTES, NOT WRITTEN BY THIS RUN');
    writeFileSync(clashing, original);
    const input: OptimizeInput = { ...inputFor(file, '--out', out), overwrite: false };
    const error = await rejection(optimizeAsset(input));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(/x\.bin/);
    expect(error.message).toMatch(/overwrite: true/);
    expect(readFileSync(clashing).equals(original)).toBe(true);
    expect(existsSync(out)).toBe(false);
  });

  it('the same call with overwrite: true succeeds and replaces the clashing resource', async () => {
    const file = await inputGlb();
    const out = join(dir, 'x.gltf');
    const clashing = join(dir, 'x.bin');
    writeFileSync(clashing, 'stale bytes');
    const input: OptimizeInput = { ...inputFor(file, '--out', out), overwrite: true };
    const doc = await optimizeAsset(input);
    expect(doc.output.file).toBe(out);
    expect(readFileSync(clashing, 'utf8')).not.toBe('stale bytes');
  });

  it('the CLI default (overwrite left unset) still replaces, unchanged from before this task', async () => {
    const file = await inputGlb();
    const out = join(dir, 'x.gltf');
    const clashing = join(dir, 'x.bin');
    writeFileSync(clashing, 'stale bytes');
    const input = inputFor(file, '--out', out);
    expect(input.overwrite).toBeUndefined();
    const doc = await optimizeAsset(input);
    expect(doc.output.file).toBe(out);
    expect(readFileSync(clashing, 'utf8')).not.toBe('stale bytes');
  });

  it('refuses a .glb out that already exists with overwrite: false — one consistent rule for .glb and .gltf', async () => {
    const file = await inputGlb();
    const out = join(dir, 'existing.glb');
    writeFileSync(out, 'stale glb bytes');
    const input: OptimizeInput = { ...inputFor(file, '--out', out), overwrite: false };
    const error = await rejection(optimizeAsset(input));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(/exists/);
    expect(error.message).toMatch(/overwrite: true/);
    expect(readFileSync(out, 'utf8')).toBe('stale glb bytes');
  });

  it('with overwrite: false, a dangling symlink at a .glb or .gltf out counts as existing and nothing is written through it (final review F1)', async () => {
    const file = await inputGlb();
    for (const name of ['dangling.glb', 'dangling.gltf']) {
      const target = join(root, `outside-${name}`);
      const out = join(dir, name);
      symlinkSync(target, out);
      const error = await rejection(optimizeAsset({ ...inputFor(file, '--out', out), overwrite: false }));
      expect(error, name).toBeInstanceOf(UsageError);
      expect(error.message, name).toMatch(/exists/);
      expect(existsSync(target), name).toBe(false);
    }
  });

  /**
   * Final re-review A, L3(c): the case above passes if either guard is reverted alone, because each refuses a dangling
   * link at `out` on its own. These two pin each guard without the other.
   *
   * The `lstat` check (`assertNotClobbering` through `entryExists`) refuses a dangling link at a .glb `out` before the
   * output is even serialized. With `existsSync` (which follows the link and reads it as free) only the write's `wx`
   * would refuse it, after `io.writeBinary` has run. (A dangling link at a .gltf *resource* target cannot show this:
   * `assertConfinedUris` refuses it first, as a symlink that cannot be resolved.)
   */
  it('with overwrite: false, a dangling symlink at a .glb out is refused by the check before anything is serialized (the lstat check)', async () => {
    const file = await inputGlb();
    const out = join(dir, 'dangling-check.glb');
    const target = join(root, 'outside-dangling-check.glb');
    symlinkSync(target, out);
    const spy = vi.spyOn(NodeIO.prototype, 'writeBinary');
    try {
      const error = await rejection(optimizeAsset({ ...inputFor(file, '--out', out), overwrite: false }));
      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toMatch(/exists/);
      expect(spy).not.toHaveBeenCalled();
      expect(existsSync(target)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * The `wx` open flag is what refuses a link that appears *after* the check: `writeOutput` awaits
   * `io.writeBinary(doc)` between `assertNotClobbering(out)` and the write, so the link is planted inside that await.
   * With a plain `w` the write would follow it and create the file outside.
   */
  it('with overwrite: false, a symlink planted at a .glb out between the check and the write is refused, not followed (the wx flag)', async () => {
    const file = await inputGlb();
    const out = join(dir, 'raced.glb');
    const target = join(root, 'outside-raced.glb');
    const writeBinary = NodeIO.prototype.writeBinary;
    const spy = vi.spyOn(NodeIO.prototype, 'writeBinary').mockImplementation(async function (this: NodeIO, doc: Document) {
      const bytes = await writeBinary.call(this, doc);
      symlinkSync(target, out);
      return bytes;
    });
    try {
      const error = await rejection(optimizeAsset({ ...inputFor(file, '--out', out), overwrite: false }));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toMatch(/exists/);
      expect(existsSync(target)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('a .glb out that already exists still replaces when overwrite is left unset (CLI default)', async () => {
    const file = await inputGlb();
    const out = join(dir, 'existing2.glb');
    writeFileSync(out, 'stale glb bytes');
    const doc = await optimizeAsset(inputFor(file, '--out', out));
    expect(doc.output.file).toBe(out);
    expect(readFileSync(out, 'utf8')).not.toBe('stale glb bytes');
  });
});

/** Every file under `base`, recursively, mapped to its SHA-256: proves a run left a directory byte-identical. */
function snapshotOf(base: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else hashes[relative(base, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(base);
  return hashes;
}

/**
 * A `.gltf` input is its JSON plus its resources. glTF-Transform keeps each buffer's and image's URI (`createURI`
 * returns `getURI()`) and writes it to `path.join(dirname(out), decodeURIComponent(uri))`, so a `.gltf` output beside
 * the input rewrote the input's own `scene.bin` and left `scene.gltf` unloadable, with exit 0.
 */
describe("optimize never overwrites a .gltf input's resources", () => {
  /** `scene.gltf` beside `scene.bin` and `tex/a.png`, the usual multi-file glTF. */
  async function gltfInput(): Promise<string> {
    const file = join(dir, 'scene.gltf');
    await new NodeIO().write(file, texturedTriangle({ imageUri: 'tex/a.png', bufferUri: 'scene.bin' }));
    return file;
  }

  it("refuses a .gltf output beside the input whose resources would replace the input's, leaving the input byte-identical and loadable", async () => {
    const file = await gltfInput();
    const before = snapshotOf(dir);
    const error = await rejection(optimizeAsset(inputFor(file, '--out', join(dir, 'scene.opt.gltf'))));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(/would overwrite the input's/);
    expect(error.message).toMatch(/another directory|\.glb/);
    expect(snapshotOf(dir)).toEqual(before);
    expect((await new NodeIO().read(file)).getRoot().listTextures()).toHaveLength(1);
  });

  it('refuses an output resource that is a hard link to an input resource', async () => {
    const file = await gltfInput();
    const outDir = join(root, 'out');
    mkdirSync(outDir);
    linkSync(join(dir, 'scene.bin'), join(outDir, 'scene.bin'));
    const before = snapshotOf(dir);
    const error = await rejection(optimizeAsset(inputFor(file, '--out', join(outDir, 'scene.opt.gltf'))));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(/would overwrite the input's/);
    expect(snapshotOf(dir)).toEqual(before);
    expect(existsSync(join(outDir, 'scene.opt.gltf'))).toBe(false);
  });

  it("refuses an --out that is one of the input's resources", async () => {
    writeFileSync(join(dir, 'skin.gltf'), 'not really an image');
    const file = writeGltf('scene.gltf', { images: [{ uri: 'skin.gltf' }] });
    const error = await rejection(optimizeAsset(inputFor(file, '--out', join(dir, 'skin.gltf'))));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(/would overwrite the input's images\[0\]\.uri/);
    expect(readFileSync(join(dir, 'skin.gltf'), 'utf8')).toBe('not really an image');
  });

  it('writes a .gltf output into another directory, re-runs over its own resources, and leaves the input byte-identical', async () => {
    const file = await gltfInput();
    const before = snapshotOf(dir);
    const outDir = join(root, 'out');
    mkdirSync(outDir);
    const out = join(outDir, 'scene.opt.gltf');
    const doc = await optimizeAsset(inputFor(file, '--out', out));
    expect(doc.output.file).toBe(out);
    expect(existsSync(join(outDir, 'scene.bin'))).toBe(true);
    expect(existsSync(join(outDir, 'tex', 'a.png'))).toBe(true);
    expect((await new NodeIO().read(out)).getRoot().listTextures()).toHaveLength(1);
    await optimizeAsset(inputFor(file, '--out', out));
    expect(snapshotOf(dir)).toEqual(before);
  });
});

/**
 * R156. `--parity` is the threshold between the two *files*, and each file's own compile check is a different
 * question that keeps the `analyze` default. The independent review proposed carrying a stricter `--parity` into the
 * inner checks (`Math.min`); that was tried and reverted against a measurement — see `verifyAnalyzeInput`'s comment
 * and `cli.spec.ts`'s Buggy case, which pins the consequence end to end. This pins the decision itself:
 * `verifyAnalyzeInput` is the object `verifyPair` hands to each `analyzeAssetWithShots` call.
 */
describe('verifyAnalyzeInput: the inner compile checks keep the analyze default, whatever --parity says', () => {
  const optimizeInput = (...extra: string[]): OptimizeInput => {
    const command = parseArgs(['optimize', 'x.glb', ...extra]);
    if (command.name !== 'optimize') throw new Error(`parsed as ${command.name}`);
    return command.input;
  };

  it('does not follow --parity down: a run asking for zero between the files still compiles at the default', () => {
    // The question `--parity 0` asks is "is the optimized asset exactly the original?", which `verify.parity`
    // answers. Whether compiling either file moves a pixel is a separate question, reported in
    // `verify.optimized.parity` and asked directly by `analyze --parity 0`.
    expect(verifyAnalyzeInput(optimizeInput('--parity', '0')).parity).toBe(DEFAULT_PARITY);
    for (const pct of ['0', '0.001', '0.1', '0.49']) expect(verifyAnalyzeInput(optimizeInput('--parity', pct)).parity, pct).toBe(DEFAULT_PARITY);
  });

  it('does not follow --parity up either', () => {
    expect(verifyAnalyzeInput(optimizeInput()).parity).toBe(DEFAULT_PARITY);
    expect(verifyAnalyzeInput(optimizeInput('--parity', '5')).parity).toBe(DEFAULT_PARITY);
    expect(verifyAnalyzeInput(optimizeInput('--parity', '100')).parity).toBe(DEFAULT_PARITY);
  });

  it('carries the run flags each file is rendered with, and never bakes', () => {
    const input = optimizeInput('--backend', 'webgpu', '--frames', '7', '--views', '3', '--timeout', '9000', '--tier', 'phone-low');
    expect(verifyAnalyzeInput(input)).toEqual({ backend: 'webgpu', tier: 'phone-low', budget: null, frames: 7, compile: true, bake: 'off', views: 3, parity: DEFAULT_PARITY, timeout: 9000, headed: false });
  });
});
