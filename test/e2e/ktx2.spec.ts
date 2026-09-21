/**
 * KTX2 through `createLoader` and the decoders `threeforge decoders` hands out, on the fixtures of
 * `test/fixtures/ktx2` (README there): two planes, `lit` with a colour, a normal and a packed
 * occlusion/roughness/metallic map, `blended` with a colour map that has alpha, as PNG, as ETC1S and as UASTC.
 * `.ktx2` is a container: what a texture costs on the GPU is decided by the format the device transcodes it to, which
 * the tests read off the loaded texture and never take from the file name.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Page } from '@playwright/test';
import { drawImages, planesGlb } from '../../scripts/ktx2-fixtures.mjs';
import { expect, type ForgePage, note, test } from './fixtures.js';
import { differingPixels } from './pixels.js';

const FIXTURES = 'test/fixtures/ktx2';
type Codec = 'etc1s' | 'uastc';
type Variant = 'png' | Codec;

let decoders: string;
test.beforeAll(() => {
  if (!existsSync('dist/cli/index.js')) execFileSync('pnpm', ['build'], { stdio: 'inherit' });
  decoders = mkdtempSync(join(tmpdir(), 'forge-ktx2-decoders-'));
  execFileSync('node', ['dist/cli/index.js', 'decoders', decoders]);
});
test.afterAll(() => rmSync(decoders, { recursive: true, force: true }));

/** Serves `models` (the fixtures by default) under `/_ktx2/` and the packaged decoders under `/_packaged/`. */
async function serve(page: Page, models = FIXTURES): Promise<void> {
  await page.route('**/_ktx2/*', (route) =>
    route.fulfill({ path: join(models, basename(new URL(route.request().url()).pathname)) }),
  );
  await page.route('**/_packaged/**', (route) => {
    const file = join(decoders, new URL(route.request().url()).pathname.split('/_packaged/')[1]!);
    return existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: 'not found' });
  });
}

/** Loads one variant, or a named model, into the empty scene, frames the planes and renders. */
async function load(forge: ForgePage, variant: Variant | `${string}.glb`) {
  return forge.page.evaluate(async (variant) => {
    const f = window.__forge;
    const T = f.three;
    const loader = await f.createLoader(f.renderer, { decoders: '/_packaged/' });
    const started = performance.now();
    const gltf = await loader.loadAsync(`/_ktx2/${variant.endsWith('.glb') ? variant : `planes-${variant}.glb`}`);
    const loadMs = performance.now() - started;
    const support: Record<string, boolean> = { ...loader.ktx2Loader!.workerConfig };
    f.disposeLoader(loader);

    const sun = new T.DirectionalLight(0xffffff, 2.5);
    sun.position.set(0.6, 0.8, 1);
    f.scene.add(new T.AmbientLight(0xffffff, 0.6), sun, gltf.scene);
    f.camera.position.set(0, 0.5, 1.45);
    f.camera.lookAt(0, 0.5, 0);
    f.camera.updateMatrixWorld();
    const materials: Record<string, InstanceType<typeof T.MeshStandardMaterial>> = {};
    gltf.scene.traverse((o) => {
      const mesh = o as InstanceType<typeof T.Mesh>;
      if (!mesh.isMesh) return;
      mesh.userData.forge = 'static';
      materials[mesh.name] = mesh.material as InstanceType<typeof T.MeshStandardMaterial>;
    });
    for (let i = 0; i < 3; i++) await f.frameAsync();

    const NAMES = [
      'RGBA_ASTC_4x4_Format',
      'RGBA_BPTC_Format',
      'RGBA_S3TC_DXT1_Format',
      'RGBA_S3TC_DXT5_Format',
      'RGB_ETC2_Format',
      'RGBA_ETC2_EAC_Format',
      'RGB_ETC1_Format',
      'RGB_PVRTC_4BPPV1_Format',
      'RGBA_PVRTC_4BPPV1_Format',
      'RGBAFormat',
    ] as const;
    const facts = (texture: InstanceType<typeof T.Texture>) => {
      const mips = (texture.mipmaps ?? []) as Array<{ data: { byteLength: number } }>;
      return {
        format: NAMES.find((name) => T[name] === texture.format) ?? String(texture.format),
        compressedTexture: (texture as { isCompressedTexture?: boolean }).isCompressedTexture === true,
        mips: mips.length,
        mipBytes: mips.reduce((sum, level) => sum + level.data.byteLength, 0),
        generateMipmaps: texture.generateMipmaps,
        srgb: texture.colorSpace === T.SRGBColorSpace,
        size: [(texture.image as { width: number }).width, (texture.image as { height: number }).height],
      };
    };
    const lit = materials.lit!;
    return {
      loadMs,
      support,
      sharedPacked: lit.aoMap === lit.roughnessMap && lit.aoMap === lit.metalnessMap,
      textures: {
        colour: facts(lit.map!),
        normal: facts(lit.normalMap!),
        orm: facts(lit.aoMap!),
        alpha: facts(materials.blended!.map!),
      },
      memory: f.ledger.measureMemory().textures,
      resident: f.renderer.info.memory.textures,
    };
  }, variant);
}

/**
 * The format three r186's KTX2Loader ranks first for a device (`FORMAT_OPTIONS`, sorted by `priorityETC1S` and
 * `priorityUASTC`): the second name of a pair is the one a texture with alpha gets, and ETC1 has none.
 */
function rankedFirst(codec: Codec, alpha: boolean, support: Record<string, boolean>): string {
  const FORMATS: Record<string, [string, string | null]> = {
    astc: ['RGBA_ASTC_4x4_Format', 'RGBA_ASTC_4x4_Format'],
    bptc: ['RGBA_BPTC_Format', 'RGBA_BPTC_Format'],
    dxt: ['RGBA_S3TC_DXT1_Format', 'RGBA_S3TC_DXT5_Format'],
    etc2: ['RGB_ETC2_Format', 'RGBA_ETC2_EAC_Format'],
    etc1: ['RGB_ETC1_Format', null],
    pvrtc: ['RGB_PVRTC_4BPPV1_Format', 'RGBA_PVRTC_4BPPV1_Format'],
  };
  const order =
    codec === 'etc1s' ? ['etc2', 'etc1', 'bptc', 'dxt', 'pvrtc'] : ['astc', 'bptc', 'etc2', 'etc1', 'dxt', 'pvrtc'];
  for (const family of order) {
    const format = FORMATS[family]![alpha ? 1 : 0];
    if (support[`${family}Supported`] && format) return format;
  }
  return 'RGBAFormat';
}

/** Bytes of a 4 x 4 block of each compressed format. */
const BLOCK_BYTES: Record<string, number> = {
  RGBA_ASTC_4x4_Format: 16,
  RGBA_BPTC_Format: 16,
  RGBA_S3TC_DXT5_Format: 16,
  RGBA_ETC2_EAC_Format: 16,
  RGBA_S3TC_DXT1_Format: 8,
  RGB_ETC2_Format: 8,
  RGB_ETC1_Format: 8,
};
/**
 * GPU bytes of a square texture with its whole mip chain: whole 4 x 4 blocks for a compressed format (the 2 and 1
 * texel levels still take one), 4 bytes a texel for `RGBAFormat`, which is what is left when the device has no block
 * format.
 */
function gpuBytes(format: string, edge = 64): number {
  const levels = Array.from({ length: Math.log2(edge) + 1 }, (_, level) => edge >> level);
  if (format === 'RGBAFormat') return levels.reduce((sum, e) => sum + e * e * 4, 0);
  if (!(format in BLOCK_BYTES)) throw new Error(`no block size known for ${format}`);
  return levels.reduce((sum, e) => sum + Math.ceil(e / 4) ** 2, 0) * BLOCK_BYTES[format]!;
}
/** What the ledger counts for a 64 x 64 RGBA8 texture whose mips three generates. */
const PNG_BYTES = Math.round(64 * 64 * 4 * 1.333);
const SLOTS = ['colour', 'normal', 'orm', 'alpha'] as const;

for (const codec of ['etc1s', 'uastc'] as const) {
  test(`ktx2 ${codec}: each map transcodes to the format this device ranks first`, async ({ forge }) => {
    await forge.open('empty');
    await serve(forge.page);
    const loaded = await load(forge, codec);
    note('ktx2', `[${forge.backend}] ${codec}: device support ${JSON.stringify(loaded.support)}`);
    expect(loaded.sharedPacked, 'occlusion, roughness and metallic read one texture').toBe(true);
    for (const slot of SLOTS) {
      const texture = loaded.textures[slot];
      const expected = rankedFirst(codec, slot === 'alpha', loaded.support);
      expect(texture.format, `${slot}: GPU format`).toBe(expected);
      expect(texture.compressedTexture).toBe(true);
      expect(texture.size).toEqual([64, 64]);
      // The file carries its own levels down to 1 x 1; three must not generate any over them.
      expect(texture.mips, `${slot}: mip levels`).toBe(7);
      expect(texture.generateMipmaps).toBe(false);
      expect(texture.mipBytes, `${slot}: bytes of ${expected}`).toBe(gpuBytes(expected));
      expect(texture.srgb, `${slot}: colour maps are sRGB, data maps are not`).toBe(
        slot === 'colour' || slot === 'alpha',
      );
    }
  });
}

test('ktx2: resident texture bytes follow the transcoded format, not the file', async ({ forge }) => {
  const measured: Record<string, Awaited<ReturnType<typeof load>>> = {};
  for (const variant of ['png', 'etc1s', 'uastc'] as const) {
    await forge.open('empty');
    await serve(forge.page);
    measured[variant] = await load(forge, variant);
  }
  const png = measured.png!;
  for (const codec of ['etc1s', 'uastc'] as const) {
    const ktx2 = measured[codec]!;
    const formats = SLOTS.map((slot) => ktx2.textures[slot].format);
    const expected = formats.reduce((sum, format) => sum + gpuBytes(format), 0);
    // The same scene with the same four maps: whatever else the ledger counts cancels between the two loads.
    expect(ktx2.memory.bytes - png.memory.bytes, `${codec}: ledger bytes against the PNG twin`).toBe(
      expected - SLOTS.length * PNG_BYTES,
    );
    expect(ktx2.memory.count).toBe(png.memory.count);
    // Three figures that are not each other: what travels, what stays on the GPU, and what the transcode took.
    const figures =
      `[${forge.backend}] ${codec}: transfer ${statSync(join(FIXTURES, `planes-${codec}.glb`)).size} B ` +
      `(png ${statSync(join(FIXTURES, 'planes-png.glb')).size} B) | GPU ${expected} B in ${[...new Set(formats)].join(', ')} ` +
      `(png ${SLOTS.length * PNG_BYTES} B) | load and transcode ${ktx2.loadMs.toFixed(0)} ms (png ${png.loadMs.toFixed(0)} ms)`;
    note('ktx2', figures);
    console.log(figures);
  }
});

test('ktx2: the planes render like their PNG twins, within the codec error', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  const shots: Record<string, Buffer> = {};
  for (const variant of ['png', 'etc1s', 'uastc'] as const) {
    await forge.open('empty');
    await serve(forge.page);
    await load(forge, variant);
    shots[variant] = await forge.page.screenshot({ type: 'png' });
  }
  await forge.page.evaluate(async () => {
    const f = window.__forge;
    for (const o of f.scene.children) o.visible = false;
    await f.frameAsync();
  });
  const covered = differingPixels(shots.png!, await forge.page.screenshot({ type: 'png' }));
  expect(covered, 'the planes must cover pixels for the comparison to mean anything').toBeGreaterThan(100_000);
  for (const codec of ['etc1s', 'uastc'] as const) {
    const share = differingPixels(shots.png!, shots[codec]!) / covered;
    console.log(
      `ktx2 [${forge.backend}] ${codec}: ${(share * 100).toFixed(2)}% of the planes' pixels differ from the PNG twin`,
    );
    // Lossy by design, so never zero and never called identical. Measured at the default threshold of 24 on both
    // backends: ETC1S 0.17 % (ETC2 on the GPU), UASTC 0.02 % (ASTC 4x4). The bounds leave about 3.5x and 5x.
    expect(share, `${codec} against its PNG twin`).toBeLessThan(codec === 'etc1s' ? 0.006 : 0.001);
    if (codec === 'etc1s') expect(share, 'ETC1S changes pixels').toBeGreaterThan(0);
  }
});

test('ktx2: releasing the loaded scene frees its textures on the GPU', async ({ forge }) => {
  await forge.open('empty');
  await serve(forge.page);
  const loaded = await load(forge, 'uastc');
  const after = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const planes = f.scene.children.find((o) => o.getObjectByName('lit'))!;
    const tracker = new f.ResourceTracker();
    tracker.track(planes);
    const released = tracker.release(planes);
    await f.frameAsync();
    return { released: released.textures, resident: f.renderer.info.memory.textures, ledger: f.ledger.measureMemory() };
  });
  expect(after.released).toBe(4);
  // What stays is three's own (the lighting lookup tables a lit material brings in), not the four maps.
  expect(loaded.resident - after.resident, 'the four maps leave the GPU').toBe(4);
  expect(after.ledger.unreferenced).toEqual({ geometries: 0, textures: 0 });
});

test('ktx2: a device with no block format is refused KTX2 and still loads PNG', async ({ forge }) => {
  await forge.open('empty');
  await serve(forge.page);
  // three r186's last resort there is RGBA8 inside a CompressedTexture (measured on the UASTC fixture: `RGBAFormat`,
  // seven levels, 21 844 B a map, what a PNG costs), which neither backend can upload: WebGL2 refuses
  // compressedTexSubImage2D with that format and the WebGPU path has no block size for it (docs/three-r186-notes.md).
  // So it is not a rendering path, and the loader says so where three would draw black maps.
  const outcomes = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const noBlockFormat = { isWebGPURenderer: true, init: async () => undefined, hasFeature: () => false } as never;
    const loader = await f.createLoader(noBlockFormat, { decoders: '/_packaged/' });
    const outcome = (model: string) =>
      loader.loadAsync(`/_ktx2/${model}`).then(
        () => 'loaded',
        (error: Error) => `rejected: ${error.message}`,
      );
    return [await outcome('planes-uastc.glb'), await outcome('planes-png.glb')];
  });
  expect(outcomes[0]).toMatch(/^rejected: .*no GPU block format.*RGBA8/s);
  expect(outcomes[1]).toBe('loaded');
});

/**
 * Serves the packaged decoders under `/_partial/` with one file of the Basis transcoder taken away: answered 404, as a
 * static host does, or 200 with a page, as a dev server with an SPA fallback does (Vite's default).
 */
async function serveWithout(page: Page, file: string, how: '404' | 'html'): Promise<void> {
  await page.route('**/_partial/**', (route) => {
    const path = new URL(route.request().url()).pathname.split('/_partial/')[1]!;
    if (!path.endsWith(file)) return route.fulfill({ path: join(decoders, path) });
    return how === '404'
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>app</title>' });
  });
}

/** Loads the named models through ONE loader with its decoders under `decoders`, all at once or one by one. */
function loadThrough(page: Page, models: string[], together: boolean, decoders = '/_partial/'): Promise<string[]> {
  return page.evaluate(
    async ({ models, together, decoders }) => {
      const f = window.__forge;
      const loader = await f.createLoader(f.renderer, { decoders });
      const outcome = (model: string): Promise<string> => {
        const settled = loader.loadAsync(`/_ktx2/${model}`).then(
          (gltf) => {
            let maps = 0;
            gltf.scene.traverse((o) => {
              if (((o as InstanceType<typeof f.three.Mesh>).material as { map?: unknown } | undefined)?.map) maps++;
            });
            return `loaded with ${maps} colour maps`;
          },
          (error: Error) => `rejected: ${error.message}`,
        );
        const hung = new Promise<string>((resolve) => setTimeout(() => resolve('never settled'), 15_000));
        return Promise.race([settled, hung]);
      };
      if (together) return Promise.all(models.map(outcome));
      const outcomes: string[] = [];
      for (const model of models) outcomes.push(await outcome(model));
      return outcomes;
    },
    { models, together, decoders },
  );
}

for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
  for (const how of ['404', 'html'] as const) {
    test(`ktx2: a missing ${file} (${how}) rejects the load and names the file`, async ({ forge }) => {
      await forge.open('empty');
      await serve(forge.page);
      await serveWithout(forge.page, file, how);
      const [outcome] = await loadThrough(forge.page, ['planes-uastc.glb'], false);
      expect(outcome).toMatch(/^rejected: /);
      expect(outcome).toContain(`/_partial/basis/${file}`);
      expect(outcome).toContain('threeforge decoders');
    });
  }
}

for (const together of [false, true]) {
  test(`ktx2: a failed KTX2 load leaves a PNG model loadable (${together ? 'at once' : 'after'})`, async ({
    forge,
  }) => {
    await forge.open('empty');
    await serve(forge.page);
    await serveWithout(forge.page, 'basis_transcoder.wasm', '404');
    // One loader for both: the transcoder is what the KTX2 model lacks, and the PNG model never needed it.
    const [ktx2, png] = await loadThrough(forge.page, ['planes-uastc.glb', 'planes-png.glb'], together);
    expect(ktx2).toMatch(/^rejected: /);
    expect(png).toBe('loaded with 2 colour maps');
  });
}

test('ktx2: a model without KTX2 loads where no decoders were deployed at all', async ({ forge }) => {
  await forge.open('empty');
  await serve(forge.page);
  const asked: string[] = [];
  await forge.page.route('**/_absent/**', (route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 404, body: 'not found' });
  });
  expect(await loadThrough(forge.page, ['planes-png.glb'], false, '/_absent/')).toEqual(['loaded with 2 colour maps']);
  // Decoders are looked for when something needs them, and a PNG model needs none.
  expect(asked).toEqual([]);
});

/**
 * The whole way round, on a model large enough for memory to matter (four 1024 px maps): source GLB, `threeforge
 * optimize --textures ktx2`, which verifies its output in the packaged harness with the packaged decoders, then the
 * output loaded here through `createLoader`, rendered, measured by the ledger and released. Needs KTX-Software's `ktx`
 * (`FORGE_KTX` or PATH): without it the test is skipped, and `FORGE_REQUIRE_KTX=1` turns that skip into a failure.
 */
test('ktx2: optimize --textures ktx2 lowers the resident bytes of a 1024 px model', async ({ forge }) => {
  test.setTimeout(300_000);
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  const encoder = spawnSync(process.env.FORGE_KTX ?? 'ktx', ['--version'], { encoding: 'utf8' });
  if (encoder.status !== 0 && process.env.FORGE_REQUIRE_KTX === '1')
    throw new Error('FORGE_REQUIRE_KTX=1, and ktx does not run');
  test.skip(encoder.status !== 0, 'KTX-Software (ktx) is not installed');

  const dir = mkdtempSync(join(tmpdir(), 'forge-ktx2-optimize-'));
  try {
    const png = drawImages(1024);
    const asPng = (bytes: Uint8Array) => ({ bytes, mimeType: 'image/png' });
    const images = {
      colour: asPng(png.colour),
      alpha: asPng(png.alpha),
      normal: asPng(png.normal),
      orm: asPng(png.orm),
    };
    writeFileSync(join(dir, 'source.glb'), await planesGlb(images));
    const run = spawnSync(
      'node',
      [
        'dist/cli/index.js',
        'optimize',
        join(dir, 'source.glb'),
        '--out',
        join(dir, 'optimized.glb'),
        '--textures',
        'ktx2',
        '--backend',
        forge.backend,
        '--frames',
        '3',
        '--json',
      ],
      { encoding: 'utf8', timeout: 240_000 },
    );
    expect(run.status, run.stderr).toBe(0);
    const doc = JSON.parse(run.stdout);
    const step = doc.steps.find((s: { name: string }) => s.name === 'textures');
    // `auto`: the two colour maps as ETC1S, the normal and the packed data map as UASTC. Nothing left as PNG.
    expect(step).toMatchObject({ applied: true, note: '4 encoded as KTX2 (2 ETC1S, 2 UASTC)' });
    expect(doc.stats.after.extensions).toEqual(['KHR_texture_basisu']);
    expect(doc.requires).toEqual([expect.objectContaining({ extension: 'KHR_texture_basisu', needs: 'KTX2Loader' })]);
    expect(doc.verdict.pass, JSON.stringify(doc.verdict)).toBe(true);
    const worst = Math.max(...doc.verify.parity.views.map((v: { diffPct: number }) => v.diffPct));
    console.log(
      `ktx2 optimize [${forge.backend}]: worst view ${worst}% changed, file ${doc.stats.before.bytes} -> ${doc.stats.after.bytes} B, memory ${doc.verify.delta.memoryBytes} B`,
    );
    // Lossy, so it changes pixels and is held to a measured bound, never to zero: 0.039 % of the frame in the worst
    // view on both backends, bounded at about four times that.
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(0.15);

    const measured: Record<string, Awaited<ReturnType<typeof load>>> = {};
    for (const file of ['source.glb', 'optimized.glb'] as const) {
      await forge.open('empty');
      await serve(forge.page, dir);
      measured[file] = await load(forge, file);
    }
    const [source, optimized] = [measured['source.glb']!, measured['optimized.glb']!];
    const formats = SLOTS.map((slot) => optimized.textures[slot].format);
    const expected = formats.reduce((sum, format) => sum + gpuBytes(format, 1024), 0);
    const uncompressed = SLOTS.length * Math.round(1024 * 1024 * 4 * 1.333);
    // The evidence is what the ledger counts on the GPU, against the block math of the formats actually chosen. The
    // file size is printed beside it and proves nothing either way.
    expect(optimized.memory.bytes - source.memory.bytes, 'ledger bytes against the source').toBe(
      expected - uncompressed,
    );
    const measuredByCommand =
      doc.verify.optimized.before.memory.textures.bytes - doc.verify.original.before.memory.textures.bytes;
    expect(measuredByCommand, 'the same saving, as the command measured it in its own harness').toBe(
      expected - uncompressed,
    );
    console.log(
      `ktx2 optimize [${forge.backend}]: GPU ${uncompressed} -> ${expected} B in ${[...new Set(formats)].join(', ')}`,
    );
    if (formats.includes('RGBAFormat')) {
      test
        .info()
        .annotations.push({ type: 'ktx2', description: 'this device has no block format: no GPU saving to claim' });
    } else {
      expect(expected, 'block formats cost a quarter of RGBA8 or less').toBeLessThanOrEqual(uncompressed / 4);
      for (const slot of SLOTS) expect(optimized.textures[slot].size).toEqual([1024, 1024]);
    }

    const released = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const planes = f.scene.children.find((o) => o.getObjectByName('lit'))!;
      const before = f.renderer.info.memory.textures;
      const tracker = new f.ResourceTracker();
      tracker.track(planes);
      const report = tracker.release(planes);
      await f.frameAsync();
      return { textures: report.textures, left: before - f.renderer.info.memory.textures };
    });
    expect(released).toEqual({ textures: 4, left: 4 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
