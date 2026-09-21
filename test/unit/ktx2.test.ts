import { readFileSync, writeFileSync } from 'node:fs';
import { Document } from '@gltf-transform/core';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import { EnvironmentError, UsageError } from '../../src/cli/errors.js';
import { encodeKtx2, type Ktx2Options, ktx2Size, ktxCreateArgs } from '../../src/cli/ktx2.js';

const OPTIONS: Ktx2Options = { codec: 'auto', qlevel: 128, uastcQuality: 2, zstd: 18, size: null };
const colour = { srgb: true, alpha: false, width: 64, height: 64 };
const data = { srgb: false, alpha: false, width: 64, height: 64 };
const args = (facts: typeof colour, options: Partial<Ktx2Options> = {}) =>
  ktxCreateArgs(facts, { ...OPTIONS, ...options }, 'in.png', 'out.ktx2').join(' ');

describe('ktxCreateArgs', () => {
  it('tags colour as sRGB and data as linear without converting either', () => {
    expect(args(colour)).toContain('--format R8G8B8_SRGB --assign-tf srgb --assign-primaries bt709');
    expect(args(data)).toContain('--format R8G8B8_UNORM --assign-tf linear --assign-primaries none');
    for (const line of [args(colour), args(data)]) {
      expect(line).toContain('--fail-on-color-conversions');
      expect(line).not.toMatch(/--convert-/);
      expect(line.endsWith('in.png out.ktx2')).toBe(true);
    }
  });

  it('keeps alpha only where a material reads it', () => {
    expect(args({ ...colour, alpha: true })).toContain('--format R8G8B8A8_SRGB');
    expect(args({ ...data, alpha: true })).toContain('--format R8G8B8A8_UNORM');
    expect(args(colour)).not.toContain('A8');
  });

  it('auto picks ETC1S for colour and UASTC for data; a named codec covers both', () => {
    expect(args(colour)).toContain('--encode basis-lz --qlevel 128');
    expect(args(data)).toContain('--encode uastc --uastc-quality 2 --zstd 18');
    expect(args(data, { codec: 'etc1s', qlevel: 200 })).toContain('--encode basis-lz --qlevel 200');
    expect(args(colour, { codec: 'uastc', uastcQuality: 4 })).toContain('--encode uastc --uastc-quality 4');
  });

  it('never supercompresses BasisLZ, and leaves UASTC plain at zstd 0', () => {
    expect(args(colour, { zstd: 22 })).not.toContain('--zstd');
    expect(args(data, { zstd: 0 })).not.toContain('--zstd');
  });

  it('always bakes the mip chain and never rewrites normals to two channels', () => {
    for (const line of [args(colour), args(data), args(data, { codec: 'etc1s' })]) {
      expect(line).toContain('--generate-mipmap');
      expect(line).not.toContain('--normal-mode');
      expect(line).not.toContain('--normalize');
    }
  });

  it('asks for a resample only when the size changes', () => {
    expect(args(colour)).not.toContain('--width');
    expect(args({ ...colour, width: 30, height: 18 })).toContain('--width 32 --height 20');
    expect(args({ ...colour, width: 1024, height: 512 }, { size: 256 })).toContain('--width 256 --height 128');
  });
});

describe('ktx2Size', () => {
  it.each([
    [[64, 64], null, [64, 64]],
    [[30, 18], null, [32, 20]],
    [[1, 1], null, [4, 4]],
    [[1024, 512], 256, [256, 128]],
    [[1000, 300], 512, [512, 152]],
    [[100, 100], 4096, [100, 100]],
    // A cap is a cap: where the nearest whole block would pass it, the size goes down to the block below.
    [[64, 64], 63, [60, 60]],
    [[63, 63], 63, [60, 60]],
    [[62, 62], 62, [60, 60]],
    [[1024, 1024], 1023, [1020, 1020]],
    [[30, 18], 30, [28, 20]],
    [[6, 6], 5, [4, 4]],
    [[1000, 3], 4, [4, 4]],
  ] as const)('fits %j within %j as whole 4 x 4 blocks: %j', (size, max, expected) => {
    const fitted = ktx2Size(size[0], size[1], max);
    expect(fitted).toEqual(expected);
    if (max !== null) expect(Math.max(...fitted)).toBeLessThanOrEqual(max);
  });

  it('refuses a cap below one block, which no block-compressed texture can meet', () => {
    expect(() => ktx2Size(64, 64, 3)).toThrow(UsageError);
    expect(() => ktx2Size(64, 64, 3)).toThrow(/--texture-size 3.*at least 4/s);
  });
});

describe('encodeKtx2', () => {
  const FIXTURE = readFileSync('test/fixtures/ktx2/colour-etc1s.ktx2');
  const png = (): Uint8Array => {
    const image = new PNG({ width: 64, height: 64 });
    image.data.fill(180);
    return new Uint8Array(PNG.sync.write(image));
  };
  /** A document with a base colour texture and a normal map, and a runner that writes `out` for every `create`. */
  function setup(out: Uint8Array = FIXTURE) {
    const doc = new Document();
    const base = doc.createTexture('base').setImage(png()).setMimeType('image/png').setURI('base.png');
    const normal = doc.createTexture('normal').setImage(png()).setMimeType('image/png');
    doc.createMaterial('m').setBaseColorTexture(base).setNormalTexture(normal);
    const calls: string[][] = [];
    const run = vi.fn(async (argv: string[]) => {
      calls.push(argv);
      if (argv[0] === 'create') writeFileSync(argv.at(-1)!, out);
    });
    return { doc, base, normal, calls, run };
  }

  it('swaps each image for its KTX2, renames its file and requires the extension', async () => {
    const { doc, base, normal, calls, run } = setup();
    const result = await encodeKtx2(doc, OPTIONS, run);
    expect(result).toEqual({ encoded: 2, etc1s: 1, uastc: 1, left: [] });
    expect([base.getMimeType(), normal.getMimeType()]).toEqual(['image/ktx2', 'image/ktx2']);
    expect(base.getURI()).toBe('base.ktx2');
    expect(Buffer.from(base.getImage()!).equals(FIXTURE)).toBe(true);
    const extension = doc
      .getRoot()
      .listExtensionsUsed()
      .find((e) => e.extensionName === 'KHR_texture_basisu');
    expect(extension?.isRequired()).toBe(true);
    // One create and one validation against the glTF profile per texture; colour first as sRGB, then the data map.
    expect(calls.map((c) => c[0])).toEqual(['create', 'validate', 'create', 'validate']);
    expect(calls[0]!.join(' ')).toContain('R8G8B8_SRGB');
    expect(calls[2]!.join(' ')).toContain('R8G8B8_UNORM');
    expect(calls[1]).toContain('--gltf-basisu');
  });

  it('leaves what is already KTX2 and what ktx cannot read, and says which', async () => {
    const { doc, base, normal, calls, run } = setup();
    base.setMimeType('image/ktx2').setImage(FIXTURE);
    normal.setMimeType('image/webp');
    const result = await encodeKtx2(doc, OPTIONS, run);
    expect(result).toEqual({ encoded: 0, etc1s: 0, uastc: 0, left: ['normal (image/webp)'] });
    expect(calls).toEqual([]);
    expect(normal.getMimeType()).toBe('image/webp');
  });

  it('fails on an encoder error and changes nothing', async () => {
    const { doc, base, run } = setup();
    run.mockRejectedValueOnce(new Error('ktx create fatal: unsupported bit depth'));
    const refused = encodeKtx2(doc, OPTIONS, run);
    await expect(refused).rejects.toThrow(/base.*unsupported bit depth/s);
    await expect(refused).rejects.toBeInstanceOf(UsageError);
    expect(base.getMimeType()).toBe('image/png');
  });

  it('rejects an output that is not the KTX2 it asked for', async () => {
    const truncated = setup(FIXTURE.subarray(0, 40));
    const bad = encodeKtx2(truncated.doc, OPTIONS, truncated.run);
    await expect(bad).rejects.toThrow(/base.*not a KTX2/s);
    await expect(bad).rejects.toBeInstanceOf(EnvironmentError);
    const wrongSize = setup();
    await expect(encodeKtx2(wrongSize.doc, { ...OPTIONS, size: 32 }, wrongSize.run)).rejects.toThrow(
      /base.*64 x 64.*32 x 32/s,
    );
    expect(wrongSize.base.getMimeType()).toBe('image/png');
  });
});
