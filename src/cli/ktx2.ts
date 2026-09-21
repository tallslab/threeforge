import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Document, Texture } from '@gltf-transform/core';
import { EnvironmentError, UsageError } from './errors.js';
import type { Ktx2Codec } from './types.js';

export interface Ktx2Options {
  /** `auto`: ETC1S for sRGB colour, UASTC for data (normal maps, packed occlusion/roughness/metallic). */
  codec: Ktx2Codec;
  /** ETC1S quality, 1 to 255 (`ktx create --qlevel`). */
  qlevel: number;
  /** UASTC effort, 0 to 4 (`--uastc-quality`). */
  uastcQuality: number;
  /** Zstandard level over UASTC, 1 to 22; 0 leaves it plain. BasisLZ is its own supercompression and takes none. */
  zstd: number;
  /** Longest side in pixels, or null to keep the image's size. */
  size: number | null;
}

/** What decides how a texture may be encoded: how materials read it, and how large it is. */
export interface TextureFacts {
  srgb: boolean;
  alpha: boolean;
  width: number;
  height: number;
}

/** Runs KTX-Software's `ktx` with these arguments; rejects with its message when it exits non-zero. */
export type KtxRunner = (argv: string[]) => Promise<void>;

export interface Ktx2Result {
  encoded: number;
  etc1s: number;
  uastc: number;
  /** Textures left as they were, `name (mime type)`: `ktx` reads PNG and JPEG only. */
  left: string[];
}

/**
 * The size a texture is encoded at: within `max` on its longest side, in whole 4 x 4 blocks. WebGPU refuses a
 * block-compressed texture whose base level is not a multiple of the block, so the image is resampled to one, never
 * padded: UVs are normalised, so a resample keeps them where padding would shift them. A side goes to the nearest whole
 * block, and to the one below where the nearest would pass `max`: 64 under a cap of 63 is 60. A cap below one block
 * cannot be met at all.
 */
export function ktx2Size(width: number, height: number, max: number | null): [number, number] {
  if (max !== null && max < 4)
    throw new UsageError(`--texture-size ${max} is below one 4 x 4 block: KTX2 needs at least 4`);
  const scale = max === null ? 1 : Math.min(1, max / Math.max(width, height));
  const blocks = (edge: number): number => {
    const nearest = Math.max(1, Math.round((edge * scale) / 4)) * 4;
    return max !== null && nearest > max ? Math.floor(max / 4) * 4 : nearest;
  };
  return [blocks(width), blocks(height)];
}

/**
 * The `ktx create` command line for one texture. The transfer function and primaries are assigned, never converted:
 * an 8-bit image with no colour tag is taken as sRGB, and a data map sent to a UNORM format on that assumption would
 * be linearised on the way. `--normal-mode` is never used: it rewrites a normal map to two channels (RGB = X, A = Y)
 * for a shader that rebuilds Z, and three samples XYZ from RGB.
 */
export function ktxCreateArgs(facts: TextureFacts, options: Ktx2Options, input: string, output: string): string[] {
  const format = `${facts.alpha ? 'R8G8B8A8' : 'R8G8B8'}_${facts.srgb ? 'SRGB' : 'UNORM'}`;
  const colour = facts.srgb ? ['srgb', 'bt709'] : ['linear', 'none'];
  const [width, height] = ktx2Size(facts.width, facts.height, options.size);
  const resample =
    width === facts.width && height === facts.height ? [] : ['--width', `${width}`, '--height', `${height}`];
  const codec = options.codec === 'auto' ? (facts.srgb ? 'etc1s' : 'uastc') : options.codec;
  const encode =
    codec === 'etc1s'
      ? ['--encode', 'basis-lz', '--qlevel', `${options.qlevel}`]
      : [
          '--encode',
          'uastc',
          '--uastc-quality',
          `${options.uastcQuality}`,
          ...(options.zstd > 0 ? ['--zstd', `${options.zstd}`] : []),
        ];
  return [
    'create',
    '--format',
    format,
    '--assign-tf',
    colour[0]!,
    '--assign-primaries',
    colour[1]!,
    ...resample,
    '--generate-mipmap',
    '--fail-on-color-conversions',
    ...encode,
    input,
    output,
  ];
}

const READABLE: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/**
 * Re-encodes every PNG and JPEG texture of the document as KTX2 and marks `KHR_texture_basisu` required. Each output
 * is checked against the glTF profile (`ktx validate --gltf-basisu`) and against the size it was asked for before it
 * replaces anything, so an encoder error or a bad file leaves the document as it was read.
 */
export async function encodeKtx2(doc: Document, options: Ktx2Options, run: KtxRunner): Promise<Ktx2Result> {
  const { getTextureChannelMask, getTextureColorSpace } = await import('@gltf-transform/functions');
  const { KHRTextureBasisu } = await import('@gltf-transform/extensions');
  const { TextureChannel } = await import('@gltf-transform/core');
  // Teaches glTF-Transform to read a KTX2 header, which is how an output's size is checked below.
  KHRTextureBasisu.register();
  const result: Ktx2Result = { encoded: 0, etc1s: 0, uastc: 0, left: [] };
  const replacements: Array<{ texture: Texture; bytes: Uint8Array }> = [];
  const dir = await mkdtemp(join(tmpdir(), 'threeforge-ktx2-'));
  try {
    for (const [index, texture] of doc.getRoot().listTextures().entries()) {
      const mime = texture.getMimeType();
      const label = texture.getName() || texture.getURI() || `texture ${index}`;
      if (mime === 'image/ktx2') continue;
      const extension = READABLE[mime];
      const size = texture.getSize();
      if (!extension || !size) {
        result.left.push(`${label} (${mime})`);
        continue;
      }
      const facts: TextureFacts = {
        srgb: getTextureColorSpace(texture) === 'srgb',
        alpha: (getTextureChannelMask(texture) & TextureChannel.A) !== 0,
        width: size[0],
        height: size[1],
      };
      const [input, output] = [join(dir, `${index}.${extension}`), join(dir, `${index}.ktx2`)];
      await writeFile(input, texture.getImage()!);
      const argv = ktxCreateArgs(facts, options, input, output);
      try {
        await run(argv);
        await run(['validate', '--gltf-basisu', output]);
      } catch (error) {
        // The encoder refusing an image is a fact about the input (a truncated PNG, 16 bits a channel), as an
        // unreadable file is: exit 2, with the texture's name and what `ktx` said.
        throw new UsageError(
          `KTX2 encoding of "${label}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const bytes = new Uint8Array(await readFile(output));
      const probe = texture.clone().setImage(bytes).setMimeType('image/ktx2');
      // A header that cannot be read throws; to the caller that is the same thing as not being a KTX2 file.
      let encoded: [number, number] | null = null;
      try {
        encoded = probe.getSize();
      } catch {}
      probe.dispose();
      const expected = ktx2Size(facts.width, facts.height, options.size);
      if (!encoded)
        throw new EnvironmentError(`KTX2 encoding of "${label}" failed: the encoder's output is not a KTX2 file`);
      if (encoded[0] !== expected[0] || encoded[1] !== expected[1])
        throw new EnvironmentError(
          `KTX2 encoding of "${label}" failed: the output is ${encoded[0]} x ${encoded[1]}, not the ${expected[0]} x ${expected[1]} asked for`,
        );
      replacements.push({ texture, bytes });
      result.encoded++;
      result[argv.includes('basis-lz') ? 'etc1s' : 'uastc']++;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  for (const { texture, bytes } of replacements) {
    texture.setImage(bytes).setMimeType('image/ktx2');
    if (texture.getURI()) texture.setURI(texture.getURI().replace(/\.[^./]+$/, '.ktx2'));
  }
  if (replacements.length > 0) doc.createExtension(KHRTextureBasisu).setRequired(true);
  return result;
}
