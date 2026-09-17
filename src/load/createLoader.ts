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
    loader.setDRACOLoader(new DRACOLoader().setDecoderPath(paths.draco));
  }
  if (options.ktx2 !== false) {
    const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
    const ktx2 = new KTX2Loader().setTranscoderPath(paths.basis);
    // detectSupport reads the WebGPU adapter's features, which exist only after init (detectSupportAsync is deprecated).
    if (renderer.isWebGPURenderer && renderer.init) await renderer.init();
    ktx2.detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
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
