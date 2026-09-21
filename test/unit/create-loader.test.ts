import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoader, type DracoDecoder, decoderPaths, disposeLoader } from '../../src/load/createLoader.js';

const renderer = { isWebGPURenderer: true, init: async () => undefined, hasFeature: () => false } as never;

/** Answers HEAD by file name: `[status, content type]`, a decoder file's own types by default. */
const host = (answers: Record<string, [number, string]>) =>
  vi.fn(async (url: string) => {
    const file = url.split('/').pop()!;
    const [status, type] = answers[file] ?? [200, file.endsWith('.js') ? 'text/javascript' : 'application/wasm'];
    return { status, headers: new Headers({ 'content-type': type }) } as Response;
  });

describe('createLoader', () => {
  it('resolves decoder paths from a base or explicit paths', () => {
    expect(decoderPaths(undefined)).toEqual({ draco: '/_decoders/draco/', basis: '/_decoders/basis/' });
    expect(decoderPaths('/dec')).toEqual({ draco: '/dec/draco/', basis: '/dec/basis/' });
    expect(decoderPaths({ draco: 'https://cdn/draco/' })).toEqual({
      draco: 'https://cdn/draco/',
      basis: '/_decoders/basis/',
    });
  });

  it('wires Draco, KTX2 (support detected on the renderer) and meshopt, and disposes the workers', async () => {
    const loader = await createLoader(renderer, { decoders: '/dec/' });
    // DRACOLoader keeps resolved file URLs, not the base path.
    expect((loader.dracoLoader as unknown as { decoderPaths: { wasm: string } }).decoderPaths.wasm).toBe(
      '/dec/draco/draco_decoder.wasm',
    );
    expect(loader.ktx2Loader?.transcoderPath).toBe('/dec/basis/');
    expect(loader.ktx2Loader?.workerConfig).toBeTruthy();
    expect(loader.meshoptDecoder).toBeTruthy();
    disposeLoader(loader);
    const bare = await createLoader(renderer, { draco: false, ktx2: false, meshopt: false });
    expect(bare.dracoLoader).toBeNull();
    expect(bare.ktx2Loader).toBeNull();
    expect(bare.meshoptDecoder).toBeNull();
  });

  describe('KTX2 that cannot work', () => {
    afterEach(() => vi.unstubAllGlobals());
    /** A device with one block format, which is all KTX2Loader needs. */
    const withBc = {
      isWebGPURenderer: true,
      init: async () => undefined,
      hasFeature: (name: string) => name === 'texture-compression-bc',
    } as never;
    /** Loads a KTX2 file through the wired loader and resolves with the error it was given. */
    const loadKtx2 = async (device = withBc): Promise<Error> => {
      const loader = await createLoader(device, { decoders: '/dec/' });
      return new Promise((resolve) =>
        loader.ktx2Loader!.load('https://example.test/a.ktx2', () => {}, undefined, resolve as never),
      );
    };

    it('is not looked into until a KTX2 texture is loaded', async () => {
      const fetch = host({ 'basis_transcoder.wasm': [404, 'text/plain'] });
      vi.stubGlobal('fetch', fetch);
      disposeLoader(await createLoader(withBc, { decoders: '/dec/' }));
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
      ['the script answers 404', 'basis_transcoder.js', 404, 'text/plain'],
      ['the script answers 410', 'basis_transcoder.js', 410, 'text/plain'],
      ['the script is the dev server page', 'basis_transcoder.js', 200, 'text/html; charset=utf-8'],
      ['the binary answers 404', 'basis_transcoder.wasm', 404, 'text/plain'],
      ['the binary is the dev server page', 'basis_transcoder.wasm', 200, 'text/html'],
    ])('fails the texture when %s, naming that file and the decoders command', async (_, file, status, type) => {
      const fetch = host({ [file]: [status, type] });
      vi.stubGlobal('fetch', fetch);
      const error = await loadKtx2();
      expect(error.message).toContain(`/dec/basis/${file}`);
      expect(error.message).toContain('threeforge decoders');
      // Both files asked for by HEAD, and the texture itself never requested.
      expect(fetch.mock.calls).toEqual([
        ['/dec/basis/basis_transcoder.js', { method: 'HEAD' }],
        ['/dec/basis/basis_transcoder.wasm', { method: 'HEAD' }],
      ]);
    });

    it.each([
      ['both files are there', {}],
      [
        'the host refuses HEAD',
        { 'basis_transcoder.js': [405, 'text/plain'], 'basis_transcoder.wasm': [405, 'text/plain'] },
      ],
    ] as Array<[string, Record<string, [number, string]>]>)('leaves the load to three when %s', async (_, answers) => {
      const fetch = host(answers);
      vi.stubGlobal('fetch', fetch);
      const error = await loadKtx2();
      // The stubbed response has no body, so three's own loader fails: the point is that it got to run.
      expect(error.message).not.toContain('threeforge decoders');
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('refuses KTX2 on a device with no block format, without asking for the transcoder', async () => {
      const fetch = host({});
      vi.stubGlobal('fetch', fetch);
      const error = await loadKtx2(renderer);
      expect(error.message).toMatch(/no GPU block format.*RGBA8/s);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('a Draco decoder that is not there', () => {
    afterEach(() => vi.unstubAllGlobals());
    /** Decodes Draco data through the wired loader and resolves with the error it was given. */
    const decode = async (): Promise<Error> => {
      const loader = await createLoader(renderer, { decoders: '/dec/' });
      return new Promise((resolve) => {
        void (loader.dracoLoader as DracoDecoder).decodeDracoFile(
          new ArrayBuffer(8),
          () => {},
          undefined,
          undefined,
          undefined,
          resolve as never,
        );
      });
    };

    it('is not looked for until a model has Draco data to decode', async () => {
      const fetch = host({ 'draco_decoder.wasm': [404, 'text/plain'] });
      vi.stubGlobal('fetch', fetch);
      disposeLoader(await createLoader(renderer, { decoders: '/dec/' }));
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
      ['the wrapper answers 404', 'draco_wasm_wrapper.js', 404, 'text/plain'],
      ['the wrapper is the dev server page', 'draco_wasm_wrapper.js', 200, 'text/html; charset=utf-8'],
      ['the binary answers 410', 'draco_decoder.wasm', 410, 'text/plain'],
      ['the binary is the dev server page', 'draco_decoder.wasm', 200, 'text/html'],
    ])('fails the decode when %s, naming that file and the decoders command', async (_, file, status, type) => {
      const fetch = host({ [file]: [status, type] });
      vi.stubGlobal('fetch', fetch);
      const error = await decode();
      expect(error.message).toContain(`/dec/draco/${file}`);
      expect(error.message).toContain('threeforge decoders');
      // Both files asked for by HEAD, and three's own decoder never started.
      expect(fetch.mock.calls).toEqual([
        ['/dec/draco/draco_wasm_wrapper.js', { method: 'HEAD' }],
        ['/dec/draco/draco_decoder.wasm', { method: 'HEAD' }],
      ]);
    });

    it('leaves the decode to three when both files are there', async () => {
      const fetch = host({});
      vi.stubGlobal('fetch', fetch);
      const error = await decode();
      // three's own decoder cannot start in node, so it fails: the point is that it was handed the data.
      expect(error.message).not.toContain('threeforge decoders');
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});
