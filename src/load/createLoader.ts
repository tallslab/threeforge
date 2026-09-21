import type { BufferGeometry } from 'three';
import type { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

export interface CreateLoaderOptions {
  /** A base URL with `draco/` and `basis/` below it (default `/_decoders/`), or explicit paths. */
  decoders?: string | { draco?: string; basis?: string };
  draco?: boolean;
  ktx2?: boolean;
  meshopt?: boolean;
}

type LoaderRenderer = Parameters<KTX2Loader['detectSupport']>[0] & {
  isWebGPURenderer?: boolean;
  init?(): Promise<unknown>;
};

/** Where the Draco decoder and the Basis transcoder are served: `<base>/draco/` and `<base>/basis/` unless given explicitly. */
export function decoderPaths(decoders: CreateLoaderOptions['decoders']): { draco: string; basis: string } {
  const base = typeof decoders === 'string' ? decoders : '/_decoders/';
  const root = base.endsWith('/') ? base : `${base}/`;
  const explicit = typeof decoders === 'object' && decoders ? decoders : {};
  return { draco: explicit.draco ?? `${root}draco/`, basis: explicit.basis ?? `${root}basis/` };
}

const TRANSCODER_FILES = ['basis_transcoder.js', 'basis_transcoder.wasm'];

/** A definite no for a served file: gone, or an HTML page where a script or a binary should be. */
async function definitelyMissing(url: string): Promise<string | null> {
  // A request that could not be made, or any other status, says nothing about the file.
  const response = await fetch(url, { method: 'HEAD' }).catch(() => null);
  if (!response) return null;
  if (response.status === 404 || response.status === 410) return `HTTP ${response.status}`;
  return response.headers.get('content-type')?.startsWith('text/html') ? 'an HTML page' : null;
}

/** The error for the first of `files` under `base` that is definitely not served, or nothing. `what` names them. */
async function missingDecoder(what: string, base: string, files: string[]): Promise<Error | undefined> {
  const urls = files.map((file) => `${base}${file}`);
  const answers = await Promise.all(urls.map(definitelyMissing));
  const at = answers.findIndex((answer) => answer !== null);
  if (at < 0) return undefined;
  return new Error(
    `createLoader: no ${what} at ${urls[at]} (${answers[at]}). Copy the decoders next to the app with ` +
      '`threeforge decoders <dir>` and pass the path they are served at as `decoders`.',
  );
}

/**
 * Makes KTX2 that cannot work fail the model that needed it, and only that model. three r186 lets none of it reach the
 * app (`docs/three-r186-notes.md`): a transcoder file answered 404 gives a model with its maps missing, one answered
 * with a page never settles, and a device with no block format gets an RGBA8 fallback that neither backend can
 * upload. The first KTX2 texture looks into it once: the device's formats, then both transcoder files by HEAD. From
 * then on every KTX2 texture fails with that error, and so does every model that has KTX2 textures; a model without
 * them loads as before, and an app that loads no KTX2 never asks and needs no decoders.
 */
function failKtx2ThatCannotWork(loader: GLTFLoader, ktx2: KTX2Loader, basis: string): void {
  let unusable: Error | undefined;
  let looked: Promise<void> | undefined;
  const look = async (): Promise<void> => {
    if (!Object.values(ktx2.workerConfig).some(Boolean)) {
      unusable = new Error(
        'createLoader: this device exposes no GPU block format (ASTC, BC, ETC2), and three cannot draw the RGBA8 that ' +
          'KTX2Loader falls back to. KTX2 textures cannot be shown here: load a PNG, JPEG or WebP variant of the model on such a device.',
      );
      return;
    }
    unusable = await missingDecoder('Basis transcoder', basis, TRANSCODER_FILES);
  };
  const load = ktx2.load.bind(ktx2);
  ktx2.load = (file, onLoad, onProgress, onError) => {
    looked ??= look();
    void looked.then(() => (unusable ? onError?.(unusable) : load(file, onLoad, onProgress, onError)));
  };
  const parse = loader.parse.bind(loader);
  loader.parse = (data, path, onLoad, onError) =>
    parse(
      data,
      path,
      (gltf) => {
        const textures: Array<{ extensions?: Record<string, unknown> }> = gltf.parser.json.textures ?? [];
        if (!unusable || !textures.some((texture) => texture.extensions?.KHR_texture_basisu)) onLoad(gltf);
        // three types this callback's argument as ErrorEvent; what it passes, here and in its own code, is an Error.
        else if (onError) onError(unusable as unknown as ErrorEvent);
        else throw unusable;
      },
      onError,
    );
}

/** DRACOLoader with the method GLTFLoader decodes through, which three's typings leave out. */
export type DracoDecoder = DRACOLoader & {
  decodeDracoFile(
    buffer: ArrayBuffer,
    onLoad: (geometry: BufferGeometry) => void,
    attributeIDs?: Record<string, unknown>,
    attributeTypes?: Record<string, unknown>,
    vertexColorSpace?: string,
    onError?: (error: unknown) => void,
  ): Promise<void>;
};

/**
 * Makes a Draco decoder that is not served fail the model that needed it. three r186 rejects a 404 with the URL and
 * no way out, and never settles when the file is answered with a page (a dev server's fallback): its worker has no
 * error listener. The first Draco data to decode asks for the files by HEAD, once; a model without
 * Draco never asks, and its load is its own, so no other model is touched.
 */
function failDracoThatIsMissing(draco: DracoDecoder, path: string): void {
  // What DRACOLoader fetches: the WebAssembly pair, or the JavaScript decoder where there is no WebAssembly.
  const files =
    typeof WebAssembly === 'object' ? ['draco_wasm_wrapper.js', 'draco_decoder.wasm'] : ['draco_decoder.js'];
  let looked: Promise<Error | undefined> | undefined;
  const decode = draco.decodeDracoFile.bind(draco);
  draco.decodeDracoFile = (buffer, onLoad, ids, types, colorSpace, onError) => {
    looked ??= missingDecoder('Draco decoder', path, files);
    return looked.then((missing) =>
      missing ? onError?.(missing) : decode(buffer, onLoad, ids, types, colorSpace, onError),
    );
  };
}

/**
 * A GLTFLoader with Draco, KTX2 (compressed-texture formats detected on the renderer) and meshopt wired in one
 * call. The three addons load lazily, so an app that never loads glTF pays nothing. `threeforge decoders <dir>`
 * copies the decoder files the paths point at.
 */
export async function createLoader(renderer: LoaderRenderer, options: CreateLoaderOptions = {}): Promise<GLTFLoader> {
  const paths = decoderPaths(options.decoders);
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  if (options.draco !== false) {
    const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
    const draco = new DRACOLoader().setDecoderPath(paths.draco) as DracoDecoder;
    failDracoThatIsMissing(draco, paths.draco);
    loader.setDRACOLoader(draco);
  }
  if (options.ktx2 !== false) {
    const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
    const ktx2 = new KTX2Loader().setTranscoderPath(paths.basis);
    // detectSupport reads the WebGPU adapter's features, which exist only after init (detectSupportAsync is deprecated).
    if (renderer.isWebGPURenderer && renderer.init) await renderer.init();
    ktx2.detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
    failKtx2ThatCannotWork(loader, ktx2, paths.basis);
  }
  if (options.meshopt !== false) {
    const { MeshoptDecoder } = await import('meshoptimizer/decoder');
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  return loader;
}

/** Terminates the Draco and KTX2 worker pools of a loader made by `createLoader`. */
export function disposeLoader(loader: GLTFLoader): void {
  loader.dracoLoader?.dispose();
  loader.ktx2Loader?.dispose();
}
