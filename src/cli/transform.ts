import type { Document, NodeIO } from '@gltf-transform/core';
import { EnvironmentError } from './errors.js';
import { encodeKtx2, type Ktx2Options, type KtxRunner } from './ktx2.js';
import type { Step } from './pipeline.js';
import type { AssetStats, Counts, Requirement, StepReport, TextureFormat } from './types.js';
import { cleanText } from './untrusted.js';

export const SHARP_INSTALL = 'npm i -D sharp';
export const DRACO_INSTALL = 'npm i -D draco3dgltf';
export const KTX_INSTALL =
  'install KTX-Software (https://github.com/KhronosGroup/KTX-Software/releases) so that `ktx` is on PATH, or set FORGE_KTX to the binary';
/** One texture: a 4096² UASTC at the highest effort takes minutes, a hung encoder forever. */
const KTX_TIMEOUT_MS = 600_000;

/** Encoders the steps need; null when the optional package is missing. */
export interface Deps {
  simplifier: unknown;
  encoder: unknown;
  decoder: unknown;
  sharp: unknown;
  draco: unknown;
  /** KTX-Software's `ktx`, probed only when a step writes KTX2. */
  ktx: KtxRunner | null;
}

/** Optional peers are imported through a variable so TypeScript does not need their types installed. */
async function optional<T>(name: string): Promise<T | null> {
  try {
    return (await import(name)) as T;
  } catch {
    return null;
  }
}

const writesKtx2 = (step: Step): boolean =>
  step.name === 'textures' && (step.options as { format?: string }).format === 'ktx2';

/**
 * `ktx` from `FORGE_KTX` or PATH, after one `--version` call proves it runs. KTX2 is only ever asked for by name, so
 * a missing encoder is an error and never a skipped step, and nothing else is encoded in its place.
 */
async function ktxRunner(): Promise<KtxRunner> {
  const { execFile } = await import('node:child_process');
  const binary = process.env.FORGE_KTX ?? 'ktx';
  const run: KtxRunner = (argv) =>
    new Promise((resolve, reject) => {
      execFile(binary, argv, { timeout: KTX_TIMEOUT_MS }, (error, _stdout, stderr) =>
        error ? reject(new Error(cleanText(stderr.trim() || error.message, 2000))) : resolve(),
      );
    });
  try {
    await run(['--version']);
  } catch {
    throw new EnvironmentError(
      `KTX2 encoding needs KTX-Software's ktx (tried ${JSON.stringify(binary)}): ${KTX_INSTALL}`,
    );
  }
  return run;
}

/**
 * Loads meshoptimizer's encoder, decoder and simplifier (dependencies) plus sharp and draco3dgltf (optional peers).
 * A missing sharp is an error only when textures were asked for explicitly; presets skip the step with a note.
 */
export async function loadDeps(steps: Step[], explicitTextures: boolean): Promise<Deps> {
  const [{ MeshoptDecoder }, { MeshoptEncoder }, { MeshoptSimplifier }] = await Promise.all([
    import('meshoptimizer/decoder'),
    import('meshoptimizer/encoder'),
    import('meshoptimizer/simplifier'),
  ]);
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const ktx = steps.some(writesKtx2) ? await ktxRunner() : null;
  let sharp: unknown = null;
  if (steps.some((s) => s.name === 'textures' && !writesKtx2(s))) {
    sharp = (await optional<{ default: unknown }>('sharp'))?.default ?? null;
    if (!sharp && explicitTextures) throw new EnvironmentError(`texture compression needs sharp: ${SHARP_INSTALL}`);
  }
  const dracoModule = await optional<{ createDecoderModule(): Promise<unknown> }>('draco3dgltf');
  const draco = dracoModule ? await dracoModule.createDecoderModule() : null;
  return { simplifier: MeshoptSimplifier, encoder: MeshoptEncoder, decoder: MeshoptDecoder, sharp, draco, ktx };
}

/** A NodeIO that reads every registered extension (meshopt and, when installed, Draco inputs). */
export async function createIO(deps: Deps): Promise<NodeIO> {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const dependencies: Record<string, unknown> = { 'meshopt.decoder': deps.decoder, 'meshopt.encoder': deps.encoder };
  if (deps.draco) dependencies['draco3d.decoder'] = deps.draco;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies(dependencies);
}

export function countsOf(doc: Document): Counts {
  const root = doc.getRoot();
  let primitives = 0;
  let vertices = 0;
  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      primitives++;
      const position = prim.getAttribute('POSITION');
      const count = position ? position.getCount() : 0;
      vertices += count;
      const indices = prim.getIndices();
      const elements = indices ? indices.getCount() : count;
      const mode = prim.getMode();
      triangles += mode === 4 ? Math.floor(elements / 3) : mode === 5 || mode === 6 ? Math.max(0, elements - 2) : 0;
    }
  }
  const textures = root.listTextures();
  return {
    nodes: root.listNodes().length,
    meshes: root.listMeshes().length,
    primitives,
    materials: root.listMaterials().length,
    textures: textures.length,
    textureBytes: textures.reduce((sum, t) => sum + (t.getImage()?.byteLength ?? 0), 0),
    accessors: root.listAccessors().length,
    vertices,
    triangles,
  };
}

export function statsOf(doc: Document, bytes: number): AssetStats {
  const root = doc.getRoot();
  let morphTargets = 0;
  for (const mesh of root.listMeshes())
    for (const prim of mesh.listPrimitives()) morphTargets += prim.listTargets().length;
  return {
    ...countsOf(doc),
    bytes,
    animations: root.listAnimations().length,
    skins: root.listSkins().length,
    morphTargets,
    extensions: root
      .listExtensionsUsed()
      .map((e) => e.extensionName)
      .sort(),
  };
}

const LOADER_NEEDS: Record<string, Omit<Requirement, 'extension'>> = {
  EXT_meshopt_compression: {
    needs: 'MeshoptDecoder',
    code: "import { MeshoptDecoder } from 'meshoptimizer/decoder'; loader.setMeshoptDecoder(MeshoptDecoder);",
  },
  KHR_draco_mesh_compression: {
    needs: 'DRACOLoader',
    code: "const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/'); loader.setDRACOLoader(draco);",
  },
  KHR_texture_basisu: {
    needs: 'KTX2Loader',
    code: "const ktx2 = new KTX2Loader().setTranscoderPath('/basis/'); await renderer.init(); ktx2.detectSupport(renderer); loader.setKTX2Loader(ktx2);",
  },
  KHR_mesh_quantization: { needs: 'nothing: GLTFLoader reads quantized attributes', code: null },
  EXT_texture_webp: { needs: 'nothing: browsers decode WebP', code: null },
  EXT_texture_avif: { needs: 'nothing: browsers decode AVIF', code: null },
  EXT_mesh_gpu_instancing: {
    needs: 'nothing: GLTFLoader creates InstancedMesh (threeforge reports it as already-instanced)',
    code: null,
  },
};
/** Extensions GLTFLoader implements without any setup; they are not requirements. */
const BUILT_IN = /^KHR_(materials_|texture_transform|lights_punctual|xmp_json_ld|animation_pointer)/;

/** Load-time requirements of a file that uses `extensions` (from `extensionsUsed`). */
export function requirementsOf(extensions: string[]): Requirement[] {
  const out: Requirement[] = [];
  for (const extension of extensions) {
    const known = LOADER_NEEDS[extension];
    if (known) out.push({ extension, ...known });
    else if (!BUILT_IN.test(extension))
      out.push({ extension, needs: 'not known to threeforge; check that your loader supports it', code: null });
  }
  return out;
}

export const COUNT_KEYS: ReadonlyArray<keyof Counts> = [
  'nodes',
  'meshes',
  'primitives',
  'materials',
  'textures',
  'textureBytes',
  'accessors',
  'vertices',
  'triangles',
];

/** "materials 148 → 10, meshes 109 → 63" or "no change"; only the count keys, so asset stats can be passed too. */
export function describeChange(before: Counts, after: Counts): string {
  const parts: string[] = [];
  for (const key of COUNT_KEYS) if (before[key] !== after[key]) parts.push(`${key} ${before[key]} → ${after[key]}`);
  return parts.length ? parts.join(', ') : 'no change';
}

/** Runs the steps in order on the document, one report per step. */
export async function applySteps(
  doc: Document,
  steps: Step[],
  deps: Deps,
  log: (line: string) => void,
): Promise<StepReport[]> {
  const fns = await import('@gltf-transform/functions');
  const reports: StepReport[] = [];
  for (const step of steps) {
    const before = countsOf(doc);
    const started = Date.now();
    let applied = true;
    let note: string | null = null;
    const o = step.options as Record<string, unknown>;
    switch (step.name) {
      case 'dedup':
        await doc.transform(fns.dedup());
        break;
      case 'instance':
        await doc.transform(fns.instance({ min: Number(o.min ?? 2) }));
        break;
      case 'palette':
        await doc.transform(fns.palette({ min: Number(o.min ?? 5) }));
        break;
      case 'flatten':
        await doc.transform(fns.flatten());
        break;
      case 'join':
        await doc.transform(fns.join());
        break;
      case 'weld':
        await doc.transform(fns.weld());
        break;
      case 'simplify':
        await doc.transform(
          fns.simplify({ simplifier: deps.simplifier, ratio: Number(o.ratio), error: Number(o.error) }),
        );
        break;
      case 'resample':
        // The tolerance comes from the preset: 0 in `safe`, glTF-Transform's lossy 1e-4 default in the
        // others. Passing it explicitly is the whole fix — `fns.resample()` with no options takes 1e-4 and moves
        // posed geometry, which `safe`, held to zero changed pixels at `--parity 0` on the Fox and the Buggy, must not do.
        await doc.transform(fns.resample({ tolerance: Number((o as { tolerance?: number }).tolerance ?? 1e-4) }));
        break;
      case 'prune':
        await doc.transform(fns.prune());
        break;
      case 'textures':
        if (writesKtx2(step)) {
          if (!deps.ktx) throw new EnvironmentError(`KTX2 encoding needs KTX-Software's ktx: ${KTX_INSTALL}`);
          const ktx2 = (o as { ktx2: Omit<Ktx2Options, 'size'> }).ktx2;
          const result = await encodeKtx2(doc, { ...ktx2, size: (o.size as number | null) ?? null }, deps.ktx);
          note = `${result.encoded} encoded as KTX2 (${result.etc1s} ETC1S, ${result.uastc} UASTC)`;
          if (result.left.length > 0) note += `; left as they were (ktx reads PNG and JPEG): ${result.left.join(', ')}`;
          break;
        }
        if (!deps.sharp) {
          applied = false;
          note = `skipped: texture compression needs sharp (${SHARP_INSTALL})`;
          break;
        }
        await doc.transform(
          fns.textureCompress({
            encoder: deps.sharp,
            targetFormat: o.format as Exclude<TextureFormat, 'ktx2'>,
            quality: Number(o.quality),
            ...(o.size ? { resize: [Number(o.size), Number(o.size)] as [number, number] } : {}),
          }),
        );
        break;
      case 'quantize':
        await doc.transform(fns.quantize());
        break;
      case 'meshopt':
        await doc.transform(fns.meshopt({ encoder: deps.encoder, level: (o.level as 'medium' | 'high') ?? 'medium' }));
        break;
    }
    const after = countsOf(doc);
    const ms = Date.now() - started;
    reports.push({ name: step.name, applied, ms, note, before, after });
    log(
      `${step.name}: ${applied ? [describeChange(before, after), note].filter(Boolean).join('; ') : note} (${ms} ms)`,
    );
  }
  return reports;
}
