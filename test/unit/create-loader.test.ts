import { describe, expect, it } from 'vitest';
import { createLoader, decoderPaths, disposeLoader } from '../../src/load/createLoader.js';

const renderer = { isWebGPURenderer: true, init: async () => undefined, hasFeature: () => false } as never;

describe('createLoader', () => {
  it('resolves decoder paths from a base or explicit paths', () => {
    expect(decoderPaths(undefined)).toEqual({ draco: '/_decoders/draco/', basis: '/_decoders/basis/' });
    expect(decoderPaths('/dec')).toEqual({ draco: '/dec/draco/', basis: '/dec/basis/' });
    expect(decoderPaths({ draco: 'https://cdn/draco/' })).toEqual({ draco: 'https://cdn/draco/', basis: '/_decoders/basis/' });
  });

  it('wires Draco, KTX2 (support detected on the renderer) and meshopt, and disposes the workers', async () => {
    const loader = await createLoader(renderer, { decoders: '/dec/' });
    // DRACOLoader keeps resolved file URLs, not the base path.
    expect((loader.dracoLoader as unknown as { decoderPaths: { wasm: string } }).decoderPaths.wasm).toBe('/dec/draco/draco_decoder.wasm');
    expect(loader.ktx2Loader?.transcoderPath).toBe('/dec/basis/');
    expect(loader.ktx2Loader?.workerConfig).toBeTruthy();
    expect(loader.meshoptDecoder).toBeTruthy();
    disposeLoader(loader);
    const bare = await createLoader(renderer, { draco: false, ktx2: false, meshopt: false });
    expect(bare.dracoLoader).toBeNull();
    expect(bare.ktx2Loader).toBeNull();
    expect(bare.meshoptDecoder).toBeNull();
  });
});
